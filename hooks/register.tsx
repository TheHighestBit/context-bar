import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ContextBarMode, ContextSegment, ContextSnapshot, PlanUsage, PlanWindow } from '../types'

const snapshot = atom({ plugin: 'context-bar', key: 'snapshot' } as const, null)
const mode = atom({ plugin: 'context-bar', key: 'mode' } as const, 'bar')
const plan = atom({ plugin: 'context-bar', key: 'plan' } as const, null)
const cost = atom({ plugin: 'context-bar', key: 'cost' } as const, null)
const effort = atom({ plugin: 'context-bar', key: 'effort' } as const, null)

const MODES: readonly ContextBarMode[] = ['bar', 'legend', 'off']
const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']
const HEAD = { context: 'Context ', usage: 'Usage   ' } as const
const MIN_BAR = 12
const MAX_BAR = 48
const MIN_METER = 4
const MAX_METER = 10

const GLYPH = { used: '█', free: '░', buffer: '▒' } as const

// The endpoint /usage and the web app's usage page read: account-wide, so a
// session that sits idle still shows what the others spent.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const TICK_MS = 15_000
const POLL_MS = 60_000
const BACKOFF_MS = 5 * 60_000
const AFTER_TURN_GAP_MS = 20_000
const STALE_MS = 3 * 60_000
// After a compaction or /clear the new conversation lands once the engine's
// own steps finish: read the breakdown again a little later, then once more.
const SETTLE_MS = [300, 1_500, 5_000] as const

// The poll's own bookkeeping: a reload starts it over, which only asks sooner.
let nextFetchAt = 0
let lastFetchAt = 0
let fetchingSince = 0
// True from a compaction or /clear until the next main-thread response: the
// status line's fill still describes the conversation from before it.
let isLiveStale = false

async function fetchPlan($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  if (fetchingSince !== 0 && now - fetchingSince < 30_000) {
    return
  }
  fetchingSince = now
  lastFetchAt = now
  nextFetchAt = now + POLL_MS
  try {
    const outcome = await readPlan($)
    if (outcome === 'planless') {
      nextFetchAt = now + BACKOFF_MS
      return
    }
    if (typeof outcome === 'string') {
      if (outcome === 'HTTP 429') {
        nextFetchAt = now + BACKOFF_MS
      }
      await update($, plan, prev => ({
        windows: prev?.windows ?? [],
        fetchedAt: prev?.fetchedAt ?? 0,
        error: outcome,
      }))
      return
    }
    const fresh: PlanUsage = { windows: outcome, fetchedAt: now, error: null }
    await update($, plan, () => fresh)
  } finally {
    fetchingSince = 0
  }
}

async function tick($: EngineInterface): Promise<void> {
  await syncLive($)
  if ((await $.clock.now()) >= nextFetchAt) {
    await fetchPlan($)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'context-bar',
      description: 'Context bar above the prompt: cycle bar, legend, off',
      argumentHint: '[bar|legend|off]',
      immediate: true,
    })
    const saved = await $.store.get('mode')
    if (isMode(saved)) {
      await update($, mode, () => saved)
    }
    if ((await read($, effort)) === null) {
      const level = (await $.settings.read()).effortLevel
      if (typeof level === 'string' && EFFORTS.includes(level)) {
        await update($, effort, () => level)
      }
    }
    await refresh($)
    // Off the start path: the first read goes out once the session is up.
    $.clock.after(1, () => void fetchPlan($).catch(() => undefined))
    $.clock.every(TICK_MS, () => void tick($).catch(() => undefined))

    return next(e)
  })

  // The status line's figures move after each main-thread turn; take the
  // breakdown again then so the categories stay true, and re-read the
  // account's usage, which that turn spent.
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (e.changed.includes('context')) {
      await refresh($)
    } else if (e.cost !== undefined) {
      await setCost($, e.cost.usd)
    }
    if ((await $.clock.now()) - lastFetchAt >= AFTER_TURN_GAP_MS) {
      await fetchPlan($)
    }

    return result
  })

  // Between those, follow each main-thread response live: its input side is
  // the window's new fill, the growth is the conversation's, and its effort is
  // the one the request was really sent with.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId !== undefined) {
      return result
    }
    isLiveStale = false
    const sent = e.effort === undefined ? null : String(e.effort)
    if ((await read($, effort)) !== sent) {
      await update($, effort, () => sent)
    }
    const usage = result.usage
    if (usage !== null) {
      const tokens =
        usage.input_tokens +
        usage.cache_read_input_tokens +
        usage.cache_creation_input_tokens
      await update($, snapshot, s => (s === null ? s : withTokens(s, tokens)))
    }

    return result
  })

  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const result = await next(e)
    const level = e.args.trim().toLowerCase()
    if (EFFORTS.includes(level)) {
      await update($, effort, () => level)
    }

    return result
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && result.messages !== undefined) {
      isLiveStale = true
      refreshSoon($)
    }

    return result
  })

  on('classic.PostCompact', async ($, e, next) => {
    const result = await next(e)
    isLiveStale = true
    refreshSoon($)

    return result
  })

  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    if (e.source === 'clear' || e.source === 'compact') {
      isLiveStale = true
      await refresh($)
      refreshSoon($)
    }

    return result
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    const result = await next(e)
    await refresh($)

    return result
  })

  on('command.run', { command: 'context-bar' }, async ($, e) => {
    const asked = e.args.trim().toLowerCase()
    const wanted = asked === 'on' ? 'bar' : asked === 'hide' ? 'off' : asked
    if (wanted !== '' && !isMode(wanted)) {
      return { text: `Unknown mode "${asked}". Use bar, legend or off.` }
    }
    const current = await read($, mode)
    const chosen = isMode(wanted) ? wanted : cycle(current)
    await update($, mode, () => chosen)
    await $.store.set('mode', chosen)
    if (chosen !== 'off') {
      await refresh($)
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
    const now = await $.clock.now()

    const { Box, Text } = $.ui.resolve(e)
    const columns = e.props.bodyColumns

    // Row 1: the context window.
    const segments = barSegments(snap)
    const percent = snap.window > 0 ? Math.round((snap.tokens / snap.window) * 100) : 0
    const figures = ` ${percent}% ${snap.isEstimate ? '~' : ''}${tokens(snap.tokens)}/${tokens(snap.window)}`
    const model = level === null ? snap.model : `${snap.model} (${level} effort)`
    const extras = [compactNote(snap), model].filter(part => part !== '').map(part => ` · ${part}`)
    const room = (): number => columns - HEAD.context.length - figures.length - extras.join('').length
    while (room() < MIN_BAR + 8 && extras.length > 0) {
      extras.pop()
    }
    const barWidth = Math.max(MIN_BAR, Math.min(MAX_BAR, room()))
    const cells = allocate(segments, barWidth)
    const runs = segments
      .map((seg, i) => ({ seg, width: cells[i] ?? 0 }))
      .filter(run => run.width > 0)

    // Row 2: the account's usage windows and what the session would cost on the API.
    const windows = usage?.windows ?? []
    const costText = spent === null ? '' : `API ${dollars(spent)}`
    const age = usage === null || usage.fetchedAt === 0 ? 0 : now - usage.fetchedAt
    const note =
      usage?.error != null && windows.length === 0
        ? `usage unavailable (${usage.error})`
        : usage?.error != null && age >= STALE_MS
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

    return (
      <Box flexDirection="column" paddingTop={1}>
        <Box flexDirection="row">
          <Text dimColor>{HEAD.context}</Text>
          {runs.map(({ seg, width }) => (
            <Text color={seg.color} dimColor={seg.kind !== 'used'}>
              {GLYPH[seg.kind].repeat(width)}
            </Text>
          ))}
          <Text bold color={toneOf(snap.tokens / Math.max(1, snap.compactAt ?? snap.window))}>
            {figures}
          </Text>
          <Text dimColor wrap="truncate-end">
            {extras.join('')}
          </Text>
        </Box>
        {shown === 'legend' && (
          <Box flexDirection="row" flexWrap="wrap" paddingLeft={HEAD.context.length}>
            {segments
              .filter(seg => seg.tokens > 0)
              .map(seg => (
                <Box flexDirection="row" marginRight={2}>
                  <Text color={seg.color} dimColor={seg.kind !== 'used'}>
                    {GLYPH[seg.kind]}
                  </Text>
                  <Text dimColor>
                    {' '}
                    {seg.name} {tokens(seg.tokens)}
                  </Text>
                </Box>
              ))}
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
  const live = usage.context.tokens
  const snap = await read($, snapshot)
  if (live !== undefined && !isLiveStale && snap !== null && snap.tokens !== live) {
    await update($, snapshot, s => (s === null ? s : withTokens(s, live)))
  }
}

async function setCost($: EngineInterface, usd: number): Promise<void> {
  if ((await read($, cost)) !== usd) {
    await update($, cost, () => usd)
  }
}

async function snapshotOf(
  $: EngineInterface,
  context: Awaited<ReturnType<EngineInterface['session']['usage']>>['context'],
): Promise<ContextSnapshot> {
  const breakdown = context.breakdown
  if (breakdown !== undefined) {
    const segments: ContextSegment[] = []
    for (const row of breakdown.categories) {
      if (row.kind !== 'deferred') {
        segments.push({ name: row.name, tokens: row.tokens, color: row.color, kind: row.kind })
      }
    }
    const isCompacting = breakdown.isAutoCompactEnabled && breakdown.autoCompactThreshold !== undefined

    return {
      model: breakdown.model,
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
 * Reads the account's usage windows: the windows, an error to show, or
 * `planless` where the session holds no subscription credential.
 */
async function readPlan($: EngineInterface): Promise<PlanWindow[] | string> {
  const auth = await $.session.authorize()
  if (auth === null || auth.kind !== 'bearer') {
    return 'planless'
  }
  let text: string
  try {
    const response = await $.http.fetch(USAGE_URL, {
      auth: auth.handle,
      headers: { 'Content-Type': 'application/json', 'anthropic-beta': 'oauth-2025-04-20' },
    })
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
    for (const row of body.limits) {
      if (isRecord(row) && typeof row.percent === 'number') {
        rows.push({
          label: limitLabel(row),
          percent: row.percent,
          resetsAt: typeof row.resets_at === 'string' ? row.resets_at : null,
        })
      }
    }
  }
  if (rows.length > 0) {
    return rows
  }
  const fixed = [
    ['five_hour', 'Session'],
    ['seven_day', 'Week'],
    ['seven_day_opus', 'Opus'],
    ['seven_day_sonnet', 'Sonnet'],
  ] as const
  for (const [key, label] of fixed) {
    const window = body[key]
    if (isRecord(window) && typeof window.utilization === 'number') {
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

function compactNote(s: ContextSnapshot): string {
  if (s.compactAt === null) {
    return ''
  }
  const left = s.compactAt - s.tokens

  return left > 0 ? `${tokens(left)} to auto-compact` : 'auto-compact due'
}

function resetIn(iso: string, now: number): string {
  const at = Date.parse(iso)

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
