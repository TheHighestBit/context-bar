import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer, TurnUsage } from 'claude-code'

import type {
  AgentCost,
  CacheState,
  CostSplit,
  CacheTtl,
  ContextBarMode,
  ContextSegment,
  ContextSnapshot,
  PlanUsage,
  PlanWindow,
} from '../types'

const snapshot = atom({ plugin: 'context-bar', key: 'snapshot' } as const, null)
const mode = atom({ plugin: 'context-bar', key: 'mode' } as const, 'bar')
const plan = atom({ plugin: 'context-bar', key: 'plan' } as const, null)
const cost = atom({ plugin: 'context-bar', key: 'cost' } as const, null)
const effort = atom({ plugin: 'context-bar', key: 'effort' } as const, null)
const cache = atom({ plugin: 'context-bar', key: 'cache' } as const, null)
const cacheLeft = atom({ plugin: 'context-bar', key: 'cacheLeft' } as const, null)
const limits = atom({ plugin: 'context-bar', key: 'limits' } as const, [])
const split = atom({ plugin: 'context-bar', key: 'split' } as const, null)

const TTLS: readonly CacheTtl[] = ['5m', '1h']
const TTL_MS: Record<CacheTtl, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }
const TRUTHY: readonly string[] = ['1', 'true', 'yes', 'on']

const MODES: readonly ContextBarMode[] = ['bar', 'legend', 'off']
const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']
const HEAD = { context: 'Context ', usage: 'Usage   ' } as const
const MIN_BAR = 12
const MAX_BAR = 48
const MIN_METER = 4
const MAX_METER = 10

const GLYPH = { used: '█', free: '░', buffer: '▒' } as const

// The legend's names for /context's categories; one not listed is lowercased.
const SHORT_NAMES: Readonly<Record<string, string>> = {
  'System prompt': 'prompt',
  'System tools': 'tools',
  'MCP tools': 'mcp',
  'Custom agents': 'agents',
  'Memory files': 'memory',
  Skills: 'skills',
  Messages: 'msgs',
}
const LEGEND_GAP = 2
// `/context-bar agents` lists this many subagents, then counts the rest.
const AGENT_ROWS = 12

// The endpoint /usage and the web app's usage page read: account-wide, so a
// session that sits idle still shows what the others spent.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const TICK_MS = 15_000
const POLL_MS = 60_000
// After a 429, a refusal or a session without a subscription.
const BACKOFF_MS = 5 * 60_000
// Other failures wait twice as long each time, up to this.
const MAX_RETRY_MS = 15 * 60_000
const AFTER_TURN_GAP_MS = 20_000
const STALE_MS = 3 * 60_000
// A request older than this no longer holds the next one back.
const FETCH_GUARD_MS = 30_000
// After a compaction or /clear the new conversation lands once the engine's
// own steps finish: read the breakdown again a little later, then once more.
const SETTLE_MS = [300, 1_500, 5_000] as const

// The poll's own bookkeeping: a reload starts it over, which only asks sooner.
let nextFetchAt = 0
let lastFetchAt = 0
let fetchingSince = 0
let fetchToken = 0
let failures = 0
// The person keeps nonessential traffic off: the usage endpoint is never asked.
let isTrafficOff = false
// Whether a surface drew the session at start, for an engine without `$.session.surfaces`.
let drewAtStart = true
// True from a compaction or /clear until the next main-thread response: the
// status line's fill still describes the conversation from before it.
let isLiveStale = false
// Moves the countdown on at each minute boundary and at expiry, not at the next tick.
let expiryTimer: Timer | null = null
// The steps that have failed once already: each is logged the first time only.
const failed = new Set<string>()
// Replies since the last cost reading, each with the loop it came from (null:
// the main conversation): the next rise in Claude Code's total is theirs.
let pendingSteps: { loop: string | null; weight: number }[] = []
// One split at a time, so two readings never hand out the same rise twice.
let splitQueue: Promise<void> = Promise.resolve()
// What the agent list said of each loop seen: null for one it does not name.
const agentKinds = new Map<string, { type: string; description: string } | null>()

/**
 * Runs one step of one feature. A `$` call this engine lacks or refuses, or a
 * value it never sent before, costs that step alone: it is logged once to the
 * debug log, and the band, the other features and the next step go on.
 */
async function attempt($: EngineInterface, step: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch (error) {
    if (!failed.has(step)) {
      failed.add(step)
      try {
        $.ui.log(`${step} failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
      } catch {
        // Nowhere to say it.
      }
    }
  }
}

/**
 * Whether the usage endpoint may be asked now: the band is on, something draws
 * it (not a `-p` or SDK run nobody watches; a surface that attaches later
 * counts from then on), and the person has not turned nonessential traffic off.
 */
async function canPoll($: EngineInterface): Promise<boolean> {
  if (isTrafficOff || (await read($, mode)) === 'off') {
    return false
  }
  try {
    return (await $.session.surfaces()).length > 0
  } catch {
    return drewAtStart
  }
}

/**
 * Reads the account's usage windows for this session. Only a 429's wait is
 * shared through `$.store` (every session on the machine holds back while the
 * server is busy); the windows are not, since nothing tells which account
 * another session is signed in to.
 */
async function fetchPlan($: EngineInterface): Promise<void> {
  if (!(await canPoll($))) {
    return
  }
  const now = await $.clock.now()
  if (now < lastFetchAt) {
    // The clock went back (a correction, a machine waking): start over.
    nextFetchAt = now
    fetchingSince = 0
  }
  if (fetchingSince !== 0 && now - fetchingSince < FETCH_GUARD_MS) {
    return
  }
  lastFetchAt = now
  nextFetchAt = now + POLL_MS
  const auth = await $.session.authorize()
  if (auth === null || auth.kind !== 'bearer') {
    // No subscription (an API key, a cloud provider, a gateway, signed out):
    // no plan windows, and none left over from an account signed in before.
    nextFetchAt = now + BACKOFF_MS
    await update($, plan, () => null)
    return
  }
  // A wait further off than any this version sets was written by a clock that
  // ran ahead, or by something else: not honoured.
  const retryAt = sharedRetryAt(await $.store.get('planRetryAt').catch(() => null))
  if (retryAt > now && retryAt <= now + MAX_RETRY_MS) {
    nextFetchAt = retryAt
    await update($, plan, prev => (prev === null ? prev : { ...prev, error: prev.error ?? 'HTTP 429' }))
    return
  }
  const token = ++fetchToken
  fetchingSince = now
  try {
    const outcome = await readPlan($, auth.handle)
    if (token !== fetchToken) {
      return
    }
    if (outcome === 'refused') {
      // This account has no plan usage to read (or the endpoint is gone).
      failures = 0
      nextFetchAt = now + BACKOFF_MS
      await update($, plan, () => ({ windows: [], fetchedAt: now, error: null }))
      return
    }
    if (typeof outcome === 'string') {
      failures += 1
      const wait = Math.min(MAX_RETRY_MS, POLL_MS * 2 ** (failures - 1))
      nextFetchAt = now + (outcome === 'HTTP 429' ? Math.max(BACKOFF_MS, wait) : wait)
      await update($, plan, prev => ({
        windows: prev?.windows ?? [],
        fetchedAt: prev?.fetchedAt ?? 0,
        error: outcome,
      }))
      if (outcome === 'HTTP 429') {
        const until = nextFetchAt
        await $.store.set('planRetryAt', until).catch(() => undefined)
      }
      return
    }
    failures = 0
    await update($, plan, () => ({ windows: outcome, fetchedAt: now, error: null }))
  } finally {
    if (token === fetchToken) {
      fetchingSince = 0
    }
  }
}

/** Another session's 429 wait, if the store holds one this version wrote. */
function sharedRetryAt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

async function tick($: EngineInterface): Promise<void> {
  await attempt($, 'live figures', () => syncLive($))
  await attempt($, 'cache countdown', () => syncCacheLeft($))
  if ((await $.clock.now()) >= nextFetchAt) {
    await attempt($, 'usage poll', () => fetchPlan($))
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Each step on its own: what one engine lacks costs that step, not the band.
    await attempt($, 'command', () =>
      $.command.register({
        name: 'context-bar',
        description:
          'Context bar above the prompt: cycle bar, legend, off; ttl explains the cache TTL; agents splits the cost by subagent',
        argumentHint: '[bar|legend|off|ttl|agents]',
        immediate: true,
      }),
    )
    drewAtStart = e.surface !== null && e.isInteractive !== false
    await attempt($, 'traffic setting', async () => {
      isTrafficOff = isTruthy(await $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'))
    })
    await attempt($, 'saved mode', async () => {
      const saved = await $.store.get('mode')
      if (isMode(saved)) {
        await update($, mode, () => saved)
      }
    })
    await attempt($, 'effort setting', async () => {
      if ((await read($, effort)) === null) {
        const level = (await $.settings.read()).effortLevel
        if (typeof level === 'string' && EFFORTS.includes(level)) {
          await update($, effort, () => level)
        }
      }
    })
    await attempt($, 'breakdown', () => refresh($))
    await attempt($, 'live figures', () => syncLive($))
    // The display-only override an earlier version kept; the TTL now follows Claude Code's own rules.
    await attempt($, 'old override', () => $.store.delete('cacheTtl'))
    await attempt($, 'cache TTL', () => syncTtl($))
    await attempt($, 'cache countdown', () => armExpiry($))
    // Off the start path: the first read goes out once the session is up. The
    // tick runs in every session; whether to ask the server is asked each time.
    await attempt($, 'timers', async () => {
      $.clock.after(1, () => void attempt($, 'usage poll', () => fetchPlan($)))
      $.clock.every(TICK_MS, () => void attempt($, 'tick', () => tick($)))
    })

    return next(e)
  })

  // The status line's figures move after each main-thread turn; take the
  // breakdown again then so the categories stay true, and re-read the
  // account's usage, which that turn spent.
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (e.changed.includes('context')) {
      await attempt($, 'breakdown', () => refresh($))
    } else if (e.cost !== undefined) {
      const usd = e.cost.usd
      await attempt($, 'cost', () => setCost($, usd))
    }
    // Not while a backoff holds, and not awaited: measures run one at a time.
    const now = await $.clock.now()
    const isBackingOff = nextFetchAt - lastFetchAt > POLL_MS || failures > 0
    if (!isBackingOff && now - lastFetchAt >= AFTER_TURN_GAP_MS) {
      void attempt($, 'usage poll', () => fetchPlan($))
    }

    return result
  })

  // Between those, follow each main-thread response live: its input side is
  // the window's new fill, the growth is the conversation's, and its effort is
  // the one the request was really sent with.
  on('turn.step', async function* ($, e, next) {
    // The cache entry's clock restarts when the request reaches the API.
    const sentAt = e.agentId === undefined ? await $.clock.now() : 0
    const result = yield* next(e)
    // Every reply, a subagent's too, gets its share of the cost it added.
    const replied = result.usage
    if (replied !== null) {
      pendingSteps.push({ loop: e.agentId ?? null, weight: costWeight(replied) })
      await attempt($, 'cost split', async () => {
        const usd = (await $.session.usage()).cost?.usd
        if (usd !== undefined) {
          await setCost($, usd)
        }
      })
    }
    if (e.agentId !== undefined) {
      return result
    }
    isLiveStale = false
    await attempt($, 'effort', async () => {
      const sent = effortLabel(e.effort)
      if ((await read($, effort)) !== sent) {
        await update($, effort, () => sent)
      }
    })
    const usage = result.usage
    if (usage !== null) {
      // A server-side tool loop sums its iterations: the fill waits for the
      // status line's own figure then.
      if ((result.serverToolUses ?? []).length === 0) {
        const fill = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
        await attempt($, 'live fill', () => update($, snapshot, s => (s === null ? s : withTokens(s, fill))))
      }
      // No cache activity means caching is off, but only where the reply comes
      // from Anthropic itself: a gateway may drop the cache figures.
      const isCached = usage.cache_read_input_tokens + usage.cache_creation_input_tokens > 0
      await attempt($, 'cache response', async () => {
        const isFirstParty = (await $.session.authorize().catch(() => null)) !== null
        await noteResponse($, sentAt, isCached || !isFirstParty)
      })
    }

    return result
  })

  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const result = await next(e)
    const level = e.args.trim().toLowerCase()
    if (EFFORTS.includes(level)) {
      await attempt($, 'effort', () => update($, effort, () => level))
    }

    return result
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && result.messages !== undefined) {
      isLiveStale = true
      await attempt($, 'cache cold', () => markCold($))
      refreshSoon($)
    }

    return result
  })

  // A subagent's compaction is its own: the main window and its cache stand.
  on('classic.PostCompact', async ($, e, next) => {
    const result = await next(e)
    if (e.agent_id === undefined) {
      isLiveStale = true
      await attempt($, 'cache cold', () => markCold($))
      refreshSoon($)
    }

    return result
  })

  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    if (e.agent_id !== undefined) {
      return result
    }
    if (e.source === 'clear' || e.source === 'compact') {
      isLiveStale = true
      await attempt($, 'cache cold', () => markCold($))
      await attempt($, 'breakdown', () => refresh($))
      refreshSoon($)
    } else if ((e.source === 'resume' || e.source === 'fork') && typeof e.seconds_since_last_response === 'number') {
      const gapMs = e.seconds_since_last_response * 1000
      const isExpired = e.prompt_cache_likely_expired === true
      await attempt($, 'cache resume', () => noteResume($, gapMs, isExpired))
    }

    return result
  })

  // The engine names the TTL it caches with here. A switch empties the cache
  // for the new model; the model a resume restores is the one cached.
  on('classic.PostModelSwitch', async ($, e, next) => {
    const result = await next(e)
    const reported = isTtl(e.cache_ttl) ? e.cache_ttl : null
    const isRestore = e.source === 'resume'
    await attempt($, 'cache switch', () => noteSwitch($, reported, isRestore))
    await attempt($, 'breakdown', () => refresh($))

    return result
  })

  on('command.run', { command: 'context-bar' }, async ($, e) => {
    const asked = e.args.trim().toLowerCase()
    if (asked === 'ttl' || asked.startsWith('ttl ')) {
      return { text: await ttlCommand($) }
    }
    if (asked === 'agents' || asked === 'agent') {
      return { text: await agentsCommand($) }
    }
    const wanted = asked === 'on' ? 'bar' : asked === 'hide' ? 'off' : asked
    if (wanted !== '' && !isMode(wanted)) {
      return { text: `Unknown mode "${asked}". Use bar, legend, off, ttl or agents.` }
    }
    const current = await read($, mode)
    const chosen = isMode(wanted) ? wanted : cycle(current)
    await update($, mode, () => chosen)
    await attempt($, 'saved mode', () => $.store.set('mode', chosen))
    if (chosen !== 'off') {
      await attempt($, 'breakdown', () => refresh($))
    }
    if (current === 'off' && chosen !== 'off') {
      // Polling sleeps while the band is off: catch up now.
      void attempt($, 'usage poll', () => fetchPlan($))
    }

    return { text: `Context bar: ${chosen}.` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }
    const shown = await read($, mode)
    const snap = await read($, snapshot)
    if (shown === 'off' || snap === null) {
      return next(e)
    }
    const usage = await read($, plan)
    const spent = await read($, cost)
    const level = await read($, effort)
    const prompt = await read($, cache)
    // Read so the countdown redraws as each minute passes.
    await read($, cacheLeft)
    const now = await $.clock.now()

    const { Box, Text } = $.ui.resolve(e)
    const columns = e.props.bodyColumns

    // Row 1: the context window.
    const segments = barSegments(snap)
    const percent = snap.window > 0 ? Math.round((snap.tokens / snap.window) * 100) : 0
    const figures = ` ${percent}% ${snap.isEstimate ? '~' : ''}${tokens(snap.tokens)}/${tokens(snap.window)}`
    const name = typeof snap.model === 'string' ? snap.model : ''
    const effortText = level === null ? '' : EFFORTS.includes(level) ? `${level} effort` : level
    const model = effortText === '' ? name : name === '' ? effortText : `${name} (${effortText})`
    const extras: Extra[] = [cacheNote(prompt, now), { text: model }].filter(
      (part): part is Extra => part !== null && typeof part.text === 'string' && part.text !== '',
    )
    const room = (): number =>
      columns - HEAD.context.length - figures.length - extras.reduce((n, part) => n + 3 + part.text.length, 0)
    while (room() < MIN_BAR + 8 && extras.length > 0) {
      extras.pop()
    }
    // Down to nothing on a very narrow terminal rather than past its edge.
    const barWidth = room() >= MIN_BAR ? Math.min(MAX_BAR, room()) : Math.max(0, room())
    const cells = allocate(segments, barWidth)
    const runs = segments
      .map((seg, i) => ({ seg, width: cells[i] ?? 0 }))
      .filter(run => run.width > 0)

    // Row 2: the account's usage windows and what the session would cost on the
    // API. Without the usage endpoint's windows, the ones the last API response
    // reported (a plan's, a gateway's spend limit) stand in.
    const planRows = usage?.windows ?? []
    const isFromPlan = planRows.length > 0
    const windows = isFromPlan ? planRows : await read($, limits)
    const agentsUsd = agentTotal(await read($, split))
    const costText =
      spent === null ? '' : `API ${dollars(spent)}${agentsUsd >= 0.005 ? ` (agents ${dollars(agentsUsd)})` : ''}`
    const age = usage === null || usage.fetchedAt === 0 ? 0 : now - usage.fetchedAt
    const note =
      usage?.error != null && windows.length === 0
        ? `usage unavailable (${usage.error})`
        : isFromPlan && usage?.error != null && age >= STALE_MS
          ? `stale ${duration(age)}`
          : ''
    const tail = [costText, note].filter(part => part !== '')
    const meters = windows.map(w => ({
      label: w.label,
      percent: Math.floor(w.percent),
      tone: toneOf(w.percent / 100),
      reset: w.resetsAt === null ? '' : resetIn(w.resetsAt, now),
    }))
    const layout = meterLayout(meters, tail, columns - HEAD.usage.length)
    const legend = shown === 'legend' ? legendLayout(segments, columns - HEAD.context.length) : null

    return (
      <Box flexDirection="column" paddingTop={1}>
        <Box flexDirection="row">
          <Text dimColor>{HEAD.context}</Text>
          {runs.map(({ seg, width }) => (
            <Text color={seg.color} dimColor={seg.kind !== 'used'}>
              {(GLYPH[seg.kind] ?? GLYPH.buffer).repeat(width)}
            </Text>
          ))}
          <Text bold color={toneOf(snap.tokens / Math.max(1, snap.compactAt ?? snap.window))}>
            {figures}
          </Text>
          {extras.map(part => (
            <Text color={part.color} dimColor={part.color === undefined} wrap="truncate-end">
              {` · ${part.text}`}
            </Text>
          ))}
        </Box>
        {legend !== null && (
          <Box flexDirection="row" paddingLeft={HEAD.context.length}>
            {legend.items.map((item, i) => (
              <Box flexDirection="row" marginLeft={i > 0 ? LEGEND_GAP : 0}>
                <Text color={item.color}>{GLYPH.used}</Text>
                <Text dimColor>{` ${item.label}`}</Text>
              </Box>
            ))}
            {legend.hidden > 0 && <Text dimColor>{`${' '.repeat(LEGEND_GAP)}+${legend.hidden} more`}</Text>}
          </Box>
        )}
        {(meters.length > 0 || tail.length > 0) && (
          <Box flexDirection="row" marginTop={1}>
            <Text dimColor>{HEAD.usage}</Text>
            {meters.map((m, i) => {
              const filled = Math.min(layout.meter, Math.round((m.percent / 100) * layout.meter))
              return (
                <Box flexDirection="row">
                  {i > 0 && <Text dimColor> · </Text>}
                  <Text>{m.label}</Text>
                  {layout.meter > 0 && <Text> </Text>}
                  {filled > 0 && <Text color={m.tone}>{'█'.repeat(filled)}</Text>}
                  {layout.meter - filled > 0 && <Text dimColor>{'░'.repeat(layout.meter - filled)}</Text>}
                  <Text bold color={m.tone}>
                    {' '}
                    {m.percent}%
                  </Text>
                  {layout.isResetShown && m.reset !== '' && <Text dimColor> resets {m.reset}</Text>}
                </Box>
              )
            })}
            <Text dimColor wrap="truncate-end">
              {tail.map((part, i) => (i === 0 && meters.length === 0 ? part : ` · ${part}`)).join('')}
            </Text>
          </Box>
        )}
      </Box>
    )
  })
}

async function refresh($: EngineInterface): Promise<void> {
  const usage = await $.session.usage({ breakdown: 'summary' })
  const next = await snapshotOf($, usage.context)
  await update($, snapshot, () => next)
  if (usage.cost !== undefined) {
    await setCost($, usage.cost.usd)
  }
}

/**
 * The cheap figures between breakdowns: the session's cost, background
 * subagents' spend included, and the main window's fill.
 */
function refreshSoon($: EngineInterface): void {
  for (const ms of SETTLE_MS) {
    $.clock.after(ms, () => void refresh($).catch(() => undefined))
  }
}

async function syncLive($: EngineInterface): Promise<void> {
  const usage = await $.session.usage()
  if (usage.cost !== undefined) {
    await setCost($, usage.cost.usd)
  }
  const fresh = liveWindows(usage.rateLimits ?? [])
  if (JSON.stringify(fresh) !== JSON.stringify(await read($, limits))) {
    await update($, limits, () => fresh)
  }
  const live = usage.context.tokens
  const snap = await read($, snapshot)
  if (live !== undefined && !isLiveStale && snap !== null && snap.tokens !== live) {
    await update($, snapshot, s => (s === null ? s : withTokens(s, live)))
  }
}

async function setCost($: EngineInterface, usd: number): Promise<void> {
  await attempt($, 'cost split', () => splitCost($, usd))
  if ((await read($, cost)) !== usd) {
    await update($, cost, () => usd)
  }
}

/**
 * A reply's relative cost, for sharing out a rise several replies made
 * together: list-price ratios (cache write 1.25x, cache read 0.1x, output 5x
 * input), the same for every current model.
 */
function costWeight(u: TurnUsage): number {
  return u.input_tokens + 1.25 * u.cache_creation_input_tokens + 0.1 * u.cache_read_input_tokens + 5 * u.output_tokens
}

function agentTotal(s: CostSplit | null): number {
  return (s?.agents ?? []).reduce((sum, a) => sum + (Number.isFinite(a.usd) ? a.usd : 0), 0)
}

/** Shares out the rise in Claude Code's running total since the last reading, one reading at a time. */
function splitCost($: EngineInterface, usd: number): Promise<void> {
  const run = splitQueue.then(() => splitOnce($, usd))
  splitQueue = run.catch(() => undefined)

  return run
}

async function splitOnce($: EngineInterface, usd: number): Promise<void> {
  if (!Number.isFinite(usd)) {
    return
  }
  const prev = await read($, split)
  if (prev === null || !Number.isFinite(prev.lastUsd) || usd < prev.lastUsd - 1e-6) {
    // The first reading, or a total that started over: what came before is not split.
    pendingSteps = []
    await update($, split, () => ({ baseline: usd, lastUsd: usd, mainUsd: 0, otherUsd: 0, agents: [] }))
    return
  }
  const rise = usd - prev.lastUsd
  if (rise <= 0) {
    return
  }
  const steps = pendingSteps
  pendingSteps = []
  let mainUsd = prev.mainUsd
  let otherUsd = prev.otherUsd
  const agents: AgentCost[] = (prev.agents ?? []).map(a => ({ ...a }))
  if (steps.length === 0) {
    // No reply explains it: Claude Code's own calls (compaction, a title).
    otherUsd += rise
  }
  const weights = steps.reduce((sum, step) => sum + step.weight, 0)
  for (const step of steps) {
    const share = weights > 0 ? (rise * step.weight) / weights : rise / steps.length
    if (step.loop === null) {
      mainUsd += share
      continue
    }
    const kind = await agentKind($, step.loop)
    if (kind === null) {
      otherUsd += share
      continue
    }
    const known = agents.find(a => a.id === step.loop)
    if (known === undefined) {
      agents.push({ id: step.loop, type: kind.type, description: kind.description, usd: share })
    } else {
      known.usd += share
    }
  }
  await update($, split, () => ({ ...prev, lastUsd: usd, mainUsd, otherUsd, agents }))
}

/** The type and task of a loop the agent list names; null for one it does not (a fork, a workflow's agent). */
async function agentKind($: EngineInterface, id: string): Promise<{ type: string; description: string } | null> {
  const seen = agentKinds.get(id)
  if (seen !== undefined) {
    return seen
  }
  const listed = (await $.agent.list().catch(() => [])).find(agent => agent.id === id)
  const kind =
    listed === undefined ? null : { type: String(listed.type || 'agent'), description: String(listed.description ?? '') }
  agentKinds.set(id, kind)

  return kind
}

async function agentsCommand($: EngineInterface): Promise<string> {
  const s = await read($, split)
  const agents = [...(s?.agents ?? [])].sort((a, b) => b.usd - a.usd)
  if (s === null || agents.length === 0) {
    return 'No subagents have run in this session yet.'
  }
  const total = (await read($, cost)) ?? s.lastUsd
  const spent = agentTotal(s)
  const share = total > 0 ? Math.round((spent / total) * 100) : 0
  const lines = [`Subagents this session: ${dollars(spent)} of ${dollars(total)} (${share}%)`]
  const shown = agents.slice(0, AGENT_ROWS)
  const typeWidth = Math.min(18, Math.max(...shown.map(a => a.type.length)))
  const taskWidth = Math.min(40, Math.max(...shown.map(a => a.description.length)))
  for (const a of shown) {
    lines.push(`  ${clip(a.type, typeWidth).padEnd(typeWidth)}  ${clip(a.description, taskWidth).padEnd(taskWidth)}  ${dollars(a.usd)}`)
  }
  if (agents.length > shown.length) {
    lines.push(`  +${agents.length - shown.length} more`)
  }
  if (s.otherUsd >= 0.005) {
    lines.push(`Claude Code's own calls (compaction, titles and the like): ${dollars(s.otherUsd)}.`)
  }
  if (s.baseline >= 0.005) {
    lines.push(`The first ${dollars(s.baseline)} came before the split started and is not divided.`)
  }

  return lines.join('\n')
}

function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`
}

async function snapshotOf(
  $: EngineInterface,
  context: Awaited<ReturnType<EngineInterface['session']['usage']>>['context'],
): Promise<ContextSnapshot> {
  const breakdown = context.breakdown
  if (breakdown !== undefined) {
    const segments: ContextSegment[] = []
    for (const row of breakdown.categories ?? []) {
      if (row.kind === 'deferred' || !Number.isFinite(row.tokens) || row.tokens < 0) {
        continue
      }
      // A kind this version does not know is drawn as reserved room, like the buffer.
      const kind = row.kind === 'used' || row.kind === 'free' || row.kind === 'buffer' ? row.kind : 'buffer'
      segments.push({ name: String(row.name), tokens: row.tokens, color: row.color, kind })
    }
    const isCompacting = breakdown.isAutoCompactEnabled && breakdown.autoCompactThreshold !== undefined

    return {
      model: typeof breakdown.model === 'string' ? breakdown.model : await $.session.model(),
      tokens: breakdown.totalTokens,
      window: breakdown.rawMaxTokens,
      isEstimate: breakdown.apiUsage === null,
      segments,
      compactAt: isCompacting ? (breakdown.autoCompactThreshold ?? null) : null,
    }
  }

  return {
    model: await $.session.model(),
    tokens: context.tokens ?? 0,
    window: context.window,
    isEstimate: context.tokens === undefined,
    segments: [],
    compactAt: null,
  }
}

/**
 * Reads the account's usage windows with the session's subscription
 * credential: the windows, an error to show, or `refused` where the server has
 * no usage for this account (403, 404, 410).
 */
async function readPlan($: EngineInterface, handle: string): Promise<PlanWindow[] | string> {
  let text: string
  try {
    const response = await $.http.fetch(USAGE_URL, {
      auth: handle,
      headers: { 'Content-Type': 'application/json', 'anthropic-beta': 'oauth-2025-04-20' },
    })
    if (response.status === 403 || response.status === 404 || response.status === 410) {
      return 'refused'
    }
    if (!response.ok) {
      return `HTTP ${response.status}`
    }
    text = response.text
  } catch (error) {
    return error instanceof Error ? error.message.slice(0, 60) : 'request failed'
  }
  try {
    return planWindows(JSON.parse(text) as unknown)
  } catch {
    return 'unreadable reply'
  }
}

/**
 * The server's rows in its own order (`limits`: the session, the week across
 * models, each model's own week such as Fable), or the older fixed fields.
 */
function planWindows(body: unknown): PlanWindow[] {
  if (!isRecord(body)) {
    return []
  }
  const rows: PlanWindow[] = []
  if (Array.isArray(body.limits)) {
    // An empty list is an account with no plan limits; a row the server marks
    // inactive does not apply. Only a list none of whose rows reads falls back.
    let read = 0
    for (const row of body.limits) {
      if (isRecord(row) && typeof row.percent === 'number' && Number.isFinite(row.percent)) {
        read += 1
        if (row.is_active !== false) {
          rows.push({
            label: limitLabel(row),
            percent: row.percent,
            resetsAt: typeof row.resets_at === 'string' ? row.resets_at : null,
          })
        }
      }
    }
    if (read > 0 || body.limits.length === 0) {
      return rows
    }
  }
  const fixed = [
    ['five_hour', 'Session'],
    ['seven_day', 'Week'],
    ['seven_day_opus', 'Opus'],
    ['seven_day_sonnet', 'Sonnet'],
  ] as const
  for (const [key, label] of fixed) {
    const window = body[key]
    if (isRecord(window) && typeof window.utilization === 'number' && Number.isFinite(window.utilization)) {
      const isCore = key === 'five_hour' || key === 'seven_day'
      if (isCore || window.utilization > 0) {
        rows.push({
          label,
          percent: window.utilization,
          resetsAt: typeof window.resets_at === 'string' ? window.resets_at : null,
        })
      }
    }
  }

  return rows
}

/** The rate-limit windows the last API response reported, as usage meters. */
function liveWindows(rows: readonly { kind: string; percentUsed: number; resetsAt?: string }[]): PlanWindow[] {
  const labels: Readonly<Record<string, string>> = { five_hour: 'Session', seven_day: 'Week', spend_limit: 'Spend' }

  return rows
    .filter(row => typeof row.kind === 'string' && Number.isFinite(row.percentUsed))
    .map(row => ({
      label: labels[row.kind] ?? row.kind.replace(/_/g, ' '),
      percent: row.percentUsed,
      resetsAt: typeof row.resetsAt === 'string' ? row.resetsAt : null,
    }))
}

function limitLabel(row: Record<string, unknown>): string {
  const scope = isRecord(row.scope) ? row.scope : {}
  const model = isRecord(scope.model) ? scope.model.display_name : undefined
  const surface = isRecord(scope.surface) ? scope.surface.display_name : undefined
  if (typeof model === 'string') {
    return model
  }
  if (typeof surface === 'string') {
    return surface
  }
  if (row.kind === 'session') {
    return 'Session'
  }
  if (row.kind === 'weekly_all') {
    return 'Week'
  }

  return typeof row.kind === 'string' ? row.kind.replace(/_/g, ' ') : 'Limit'
}

type LegendItem = { label: string; color: string; tokens: number }

/**
 * The legend as one row of `width`: the categories that take room, in the
 * bar's order, short-named (free space and the buffer read off the bar itself).
 * What does not fit goes smallest first, counted as "+N more".
 */
function legendLayout(
  segments: readonly ContextSegment[],
  width: number,
): { items: LegendItem[]; hidden: number } | null {
  const all = segments
    .filter(seg => seg.kind === 'used' && seg.tokens > 0)
    .map(seg => ({
      label: `${SHORT_NAMES[seg.name] ?? seg.name.toLowerCase()} ${tokens(seg.tokens)}`,
      color: seg.color,
      tokens: seg.tokens,
    }))
  if (all.length === 0) {
    return null
  }
  const length = (items: readonly LegendItem[], hidden: number): number =>
    items.reduce((sum, item, i) => sum + (i > 0 ? LEGEND_GAP : 0) + 2 + item.label.length, 0) +
    (hidden > 0 ? LEGEND_GAP + `+${hidden} more`.length : 0)
  const items = [...all]
  while (items.length > 1 && length(items, all.length - items.length) > width) {
    const smallest = items.reduce((min, item) => (item.tokens < min.tokens ? item : min))
    items.splice(items.indexOf(smallest), 1)
  }

  return { items, hidden: all.length - items.length }
}

type Meter = { label: string; percent: number; reset: string }

/**
 * Fits the usage row to `width`: meters as wide as fit (up to 10), dropping the
 * reset times first and then the meters, leaving the percentages.
 */
function meterLayout(
  meters: readonly Meter[],
  tail: readonly string[],
  width: number,
): { meter: number; isResetShown: boolean } {
  const n = meters.length
  const tailLength = tail.reduce((sum, part) => sum + part.length + 3, 0)
  const textLength = (isResetShown: boolean, hasMeter: boolean): number =>
    meters.reduce(
      (sum, m, i) =>
        sum +
        (i > 0 ? 3 : 0) +
        m.label.length +
        (hasMeter ? 1 : 0) +
        ` ${m.percent}%`.length +
        (isResetShown && m.reset !== '' ? ` resets ${m.reset}`.length : 0),
      0,
    ) + tailLength
  for (const isResetShown of [true, false]) {
    const meter = n === 0 ? 0 : Math.min(MAX_METER, Math.floor((width - textLength(isResetShown, true)) / n))
    if (meter >= MIN_METER) {
      return { meter, isResetShown }
    }
  }

  return { meter: 0, isResetShown: textLength(true, false) <= width }
}

/**
 * Moves a snapshot to a new fill without a fresh breakdown: the growth goes to
 * the last `used` row (the conversation's messages) and comes out of free space.
 */
function withTokens(s: ContextSnapshot, total: number): ContextSnapshot {
  const delta = total - s.tokens
  const segments = s.segments.map(seg => ({ ...seg }))
  const lastUsed = segments.map(seg => seg.kind).lastIndexOf('used')
  const target = segments[lastUsed]
  if (target !== undefined) {
    target.tokens = Math.max(0, target.tokens + delta)
  }
  const free = segments.find(seg => seg.kind === 'free')
  if (free !== undefined) {
    free.tokens = Math.max(0, free.tokens - delta)
  }

  return { ...s, tokens: total, isEstimate: false, segments }
}

/** The bar's runs, in order: used rows, then free space, then the compaction buffer. */
function barSegments(s: ContextSnapshot): ContextSegment[] {
  if (s.segments.length > 0) {
    const order = { used: 0, free: 1, buffer: 2 } as const

    return [...s.segments].sort((a, b) => order[a.kind] - order[b.kind])
  }

  return [
    { name: 'Used', tokens: s.tokens, color: 'claude', kind: 'used' },
    { name: 'Free space', tokens: Math.max(0, s.window - s.tokens), color: 'inactive', kind: 'free' },
  ]
}

/** Splits `width` cells among the segments by tokens, largest remainder first. */
function allocate(segments: readonly ContextSegment[], width: number): number[] {
  const total = segments.reduce((sum, seg) => sum + seg.tokens, 0)
  if (total <= 0) {
    return segments.map(seg => (seg.kind === 'free' ? width : 0))
  }
  const exact = segments.map(seg => (seg.tokens / total) * width)
  const cells = exact.map(Math.floor)
  let left = width - cells.reduce((sum, n) => sum + n, 0)
  const byRemainder = exact
    .map((x, i) => ({ i, rest: x - Math.floor(x) }))
    .sort((a, b) => b.rest - a.rest)
  for (const { i } of byRemainder) {
    if (left <= 0) {
      break
    }
    cells[i] = (cells[i] ?? 0) + 1
    left -= 1
  }

  return cells
}

function toneOf(fill: number): string {
  return fill >= 0.85 ? 'error' : fill >= 0.6 ? 'warning' : 'success'
}

type Extra = { text: string; color?: string }

/** The prompt cache's countdown: how long the main conversation's entry stays warm. */
function cacheNote(c: CacheState | null, now: number): Extra | null {
  if (c === null) {
    return null
  }
  if (c.ttl === null || c.isOff === true) {
    return { text: 'cache off' }
  }
  const ms = msLeft(c, now)
  if (ms === null) {
    return { text: 'cache cold' }
  }
  if (ms <= 0) {
    return { text: 'cache expired', color: 'error' }
  }
  const text = `cache ${Math.ceil(ms / 60_000)}m left`

  return ms <= TTL_MS[c.ttl] / 4 ? { text, color: 'warning' } : { text }
}

/** What the entry has left; never more than its TTL, should the clock have gone back. */
function msLeft(c: CacheState | null, now: number): number | null {
  if (c === null || !isTtl(c.ttl) || c.isOff === true || typeof c.lastAt !== 'number') {
    return null
  }
  const span = TTL_MS[c.ttl]

  return Math.min(span, Math.max(0, c.lastAt + span - now))
}

type TtlRule = { ttl: CacheTtl | null; why: string }

/**
 * The TTL Claude Code asks for on the main conversation's requests, by the
 * order https://code.claude.com/docs/en/prompt-caching documents: the first
 * match wins, and a subscription drops to five minutes once usage credits pay.
 * Caching switched off for one model shows in that model's responses instead
 * (noteResponse): which model each per-model variable covers is the engine's.
 */
async function ruleTtl($: EngineInterface): Promise<TtlRule> {
  // A read this engine refuses counts as unset, as the engine itself would.
  const unset = (): undefined => undefined
  if (isTruthy(await $.env.get('DISABLE_PROMPT_CACHING').catch(unset))) {
    return { ttl: null, why: 'DISABLE_PROMPT_CACHING' }
  }
  if (isTruthy(await $.env.get('FORCE_PROMPT_CACHING_5M').catch(unset))) {
    return { ttl: '5m', why: 'FORCE_PROMPT_CACHING_5M' }
  }
  const fromEnv = (await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL').catch(unset))?.trim()
  if (isTtl(fromEnv)) {
    return { ttl: fromEnv, why: 'CLAUDE_CODE_PROMPT_CACHE_TTL' }
  }
  const fromSettings = (await $.settings.read().catch(() => ({}) as Record<string, unknown>)).promptCacheTtl
  if (isTtl(fromSettings)) {
    return { ttl: fromSettings, why: 'the promptCacheTtl setting' }
  }
  if (isTruthy(await $.env.get('ENABLE_PROMPT_CACHING_1H').catch(unset))) {
    return { ttl: '1h', why: 'ENABLE_PROMPT_CACHING_1H' }
  }
  const auth = await $.session.authorize()
  if (auth === null) {
    return { ttl: '5m', why: 'the default for a cloud provider or gateway' }
  }
  if (auth.kind !== 'bearer') {
    return { ttl: '5m', why: 'the default for an API key' }
  }
  if (await isOverPlan($).catch(() => false)) {
    return { ttl: '5m', why: 'the default once usage credits pay (plan limit reached)' }
  }

  return { ttl: '1h', why: 'the default for a subscription within plan usage' }
}

/** Whether a plan limit that covers this model is used up, so usage credits pay for the requests. */
async function isOverPlan($: EngineInterface): Promise<boolean> {
  const live = (await $.session.usage()).rateLimits ?? []
  if (live.some(r => (r.kind === 'five_hour' || r.kind === 'seven_day') && r.percentUsed >= 100)) {
    return true
  }
  const model = ((await read($, snapshot))?.model ?? '').toLowerCase()
  const windows = (await read($, plan))?.windows ?? []

  return windows.some(
    w =>
      w.percent >= 100 &&
      (w.label === 'Session' || w.label === 'Week' || (model !== '' && model.includes(w.label.toLowerCase()))),
  )
}

/**
 * Brings the TTL in line with the rules. A model switch's report that
 * disagreed stands while the rules still answer what they did then.
 */
async function syncTtl($: EngineInterface): Promise<void> {
  const rule = await ruleTtl($)
  const c = await read($, cache)
  // An earlier version's value may lack `why`, `reported` or `isOff`: rebuilt here.
  const reported = c?.reported != null && isTtl(c.reported.ttl) ? c.reported : null
  const kept = reported !== null && reported.rulesTtl === rule.ttl ? reported : null
  const next: CacheState = {
    ttl: kept?.ttl ?? rule.ttl,
    why: kept === null ? rule.why : 'what the last model switch reported',
    reported: kept,
    lastAt: typeof c?.lastAt === 'number' ? c.lastAt : null,
    isOff: c?.isOff === true,
  }
  const isSame =
    c !== null &&
    c.ttl === next.ttl &&
    c.why === next.why &&
    c.reported === next.reported &&
    c.lastAt === next.lastAt &&
    c.isOff === next.isOff
  if (isSame) {
    await syncCacheLeft($)
  } else {
    await setCache($, () => next)
  }
}

/**
 * A main-thread response: the entry's clock restarts from when its request
 * went out, under the TTL the rules gave that request (a setting changed, or a
 * plan limit reached, counts from the next request on). A response that read
 * nothing from the cache and wrote nothing to it was not cached at all.
 */
async function noteResponse($: EngineInterface, sentAt: number, isCached: boolean): Promise<void> {
  await attempt($, 'cache TTL', () => syncTtl($))
  await setCache($, c => (c === null ? c : { ...c, lastAt: sentAt, isOff: !isCached }))
  await armExpiry($)
}

/**
 * A model switch: the engine's own TTL (left to the rules when it sent one
 * this version does not know), and a cache that is empty for the new model,
 * unless the switch is a resume restoring the model its cache was made with.
 */
async function noteSwitch($: EngineInterface, reported: CacheTtl | null, isRestore: boolean): Promise<void> {
  const rule = await ruleTtl($)
  const differs = reported !== null && reported !== rule.ttl
  await setCache($, c => ({
    ttl: reported ?? rule.ttl,
    why: differs ? 'what the last model switch reported' : rule.why,
    reported: differs && reported !== null ? { ttl: reported, rulesTtl: rule.ttl } : null,
    lastAt: isRestore && typeof c?.lastAt === 'number' ? c.lastAt : null,
    isOff: isRestore ? c?.isOff === true : false,
  }))
  await armExpiry($)
}

/** A resumed transcript: the engine judged whether its entry is still warm. */
async function noteResume($: EngineInterface, gapMs: number, isExpired: boolean): Promise<void> {
  const now = await $.clock.now()
  await setCache($, c =>
    c === null ? c : { ...c, lastAt: isExpired || !Number.isFinite(gapMs) ? null : now - Math.max(0, gapMs) },
  )
  await armExpiry($)
}

async function markCold($: EngineInterface): Promise<void> {
  await setCache($, c => (c === null ? c : { ...c, lastAt: null }))
}

async function setCache($: EngineInterface, fn: (c: CacheState | null) => CacheState | null): Promise<void> {
  await update($, cache, fn)
  await syncCacheLeft($)
}

/** Bumps the minutes left when they change, so the band redraws its countdown. */
async function syncCacheLeft($: EngineInterface): Promise<void> {
  const ms = msLeft(await read($, cache), await $.clock.now())
  const minutes = ms === null ? null : Math.ceil(ms / 60_000)
  if ((await read($, cacheLeft)) !== minutes) {
    await update($, cacheLeft, () => minutes)
  }
}

/** Wakes at each minute the countdown crosses, and at expiry, so the label flips on time. */
async function armExpiry($: EngineInterface): Promise<void> {
  expiryTimer?.cancel()
  expiryTimer = null
  const ms = msLeft(await read($, cache), await $.clock.now())
  if (ms !== null && ms > 0) {
    const toNextMinute = ms % 60_000 === 0 ? 60_000 : ms % 60_000
    expiryTimer = $.clock.after(toNextMinute, () => {
      void attempt($, 'cache countdown', async () => {
        await syncCacheLeft($)
        await armExpiry($)
      })
    })
  }
}

async function ttlCommand($: EngineInterface): Promise<string> {
  const c = await read($, cache)
  if (c === null || (c.ttl !== null && !isTtl(c.ttl))) {
    return 'Prompt cache: not known yet.'
  }
  if (c.ttl === null) {
    return `Prompt cache: off (${c.why}).`
  }
  if (c.isOff === true) {
    return "Prompt cache: off for this model (the last response read and wrote nothing to the cache)."
  }
  const ms = msLeft(c, await $.clock.now())
  const state = ms === null ? 'cold' : ms <= 0 ? 'expired' : `warm, ${duration(ms)} left`
  const change =
    c.why === 'FORCE_PROMPT_CACHING_5M'
      ? 'Unset FORCE_PROMPT_CACHING_5M to change it.'
      : 'Change it with the promptCacheTtl setting or CLAUDE_CODE_PROMPT_CACHE_TTL (5m or 1h).'

  return `Prompt cache: ${c.ttl} TTL, from ${c.why}; ${state}. ${change}`
}

/** The effort a request went out with, as the band names it: a level, or a thinking budget. */
function effortLabel(sent: string | number | undefined): string | null {
  if (typeof sent === 'number') {
    return Number.isFinite(sent) ? `${tokens(sent)} thinking` : null
  }

  return typeof sent === 'string' && sent !== '' ? sent : null
}

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && TRUTHY.includes(value.trim().toLowerCase())
}

function isTtl(value: unknown): value is CacheTtl {
  return typeof value === 'string' && (TTLS as readonly string[]).includes(value)
}

function resetIn(iso: string, now: number): string {
  // A time written without an offset is the server's UTC, not this machine's zone.
  const at = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : `${iso}Z`)

  return Number.isNaN(at) ? '' : duration(Math.max(0, at - now))
}

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
  }

  return `${Math.floor(hours / 24)}d${hours % 24}h`
}

function dollars(usd: number): string {
  return usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`
}

function tokens(n: number): string {
  if (n >= 1_000_000) {
    return `${trim((n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1))}M`
  }
  if (n >= 1000) {
    return `${trim((n / 1000).toFixed(n >= 100_000 ? 0 : 1))}k`
  }

  return String(Math.round(n))
}

function trim(fixed: string): string {
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMode(value: unknown): value is ContextBarMode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value)
}

function cycle(current: ContextBarMode): ContextBarMode {
  return MODES[(MODES.indexOf(current) + 1) % MODES.length] ?? 'bar'
}
