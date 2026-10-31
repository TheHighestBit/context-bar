import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { AgentInfo, On, RenderSurface, SessionAuthorization, SessionMessage, SessionUsage, TurnUsage } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const
const NOW = Date.parse('2026-10-03T12:00:00Z')
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

const USAGE: SessionUsage = {
  startedAt: 0,
  context: {
    tokens: 52_000,
    window: 200_000,
    percent: 26,
    breakdown: {
      categories: [
        { name: 'System prompt', tokens: 3_000, color: 'promptBorder', isDeferred: false, kind: 'used' },
        { name: 'System tools', tokens: 15_000, color: 'inactive', isDeferred: false, kind: 'used' },
        { name: 'Messages', tokens: 34_000, color: 'permission', isDeferred: false, kind: 'used' },
        { name: 'Free space', tokens: 115_000, color: 'promptBorder', isDeferred: false, kind: 'free' },
        { name: 'Autocompact buffer', tokens: 33_000, color: 'inactive', isDeferred: false, kind: 'buffer' },
        { name: 'MCP tools', tokens: 9_000, color: 'inactive', isDeferred: true, kind: 'deferred' },
      ],
      totalTokens: 52_000,
      maxTokens: 200_000,
      rawMaxTokens: 200_000,
      autocompactSource: 'model-default',
      percentage: 26,
      gridRows: [],
      model: 'Opus 5.5',
      memoryFiles: [],
      mcpTools: [],
      agents: [],
      autoCompactThreshold: 167_000,
      isAutoCompactEnabled: true,
      apiUsage: {
        input_tokens: 2,
        output_tokens: 10,
        cache_read_input_tokens: 50_000,
        cache_creation_input_tokens: 1_998,
      },
    },
  },
  rateLimits: [],
  cost: { usd: 4.2134 },
}

// After a compaction: the breakdown is small again while the status line's
// fill, from the last response before it, still reads the old size.
const COMPACTED: SessionUsage = {
  ...USAGE,
  context: {
    ...USAGE.context,
    breakdown: {
      ...USAGE.context.breakdown!,
      categories: [
        { name: 'System prompt', tokens: 3_000, color: 'promptBorder', isDeferred: false, kind: 'used' },
        { name: 'System tools', tokens: 15_000, color: 'inactive', isDeferred: false, kind: 'used' },
        { name: 'Messages', tokens: 4_000, color: 'permission', isDeferred: false, kind: 'used' },
        { name: 'Free space', tokens: 145_000, color: 'promptBorder', isDeferred: false, kind: 'free' },
        { name: 'Autocompact buffer', tokens: 33_000, color: 'inactive', isDeferred: false, kind: 'buffer' },
      ],
      totalTokens: 22_000,
      percentage: 11,
      apiUsage: null,
    },
  },
}

const SUMMARY: SessionMessage = { role: 'user', text: 'Summary of the conversation so far.', toolUses: [] }

// The usage endpoint's reply, in the shape the CLI's own /usage parses.
const SESSION_ROW = {
  kind: 'session',
  group: 'session',
  percent: 23,
  resets_at: '2026-10-03T14:14:00Z',
  severity: 'normal',
  is_active: true,
  scope: null,
}
const PLAN = {
  five_hour: { utilization: 23, resets_at: '2026-10-03T14:14:00Z' },
  seven_day: { utilization: 35, resets_at: '2026-10-07T04:00:00Z' },
  limits: [
    SESSION_ROW,
    { kind: 'weekly_all', group: 'weekly', percent: 35, resets_at: '2026-10-07T04:00:00Z', severity: 'normal', is_active: true, scope: null },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 12.5,
      resets_at: '2026-10-07T04:00:00Z',
      severity: 'normal',
      is_active: true,
      scope: { model: { display_name: 'Fable' } },
    },
  ],
}

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

/** One reply of the usage endpoint: `body` sent as JSON, or `text` as it stands. */
type Reply = { status: number; body?: unknown; text?: string }

type World = {
  clock: MockClock
  usage: SessionUsage
  fetches: { url: string; auth: string | undefined }[]
  /** What the next main-thread response reports. */
  stepUsage: TurnUsage
  /** The session's credential, as `$.session.authorize` answers it now. */
  auth: SessionAuthorization
  /** The session's agents, as `$.agent.list` answers them now. */
  agents: AgentInfo[]
}

// A warm response: most of the 100k input read from the cache.
const WARM: TurnUsage = {
  model: 'claude-opus-5-5',
  input_tokens: 1_000,
  output_tokens: 50,
  cache_read_input_tokens: 51_000,
  cache_creation_input_tokens: 48_000,
}

const MINUTE = 60_000

/** Stands up what sits beneath the plugin: the engine's answers, the network, a clock. */
function world(
  on: On,
  {
    auth = { handle: 'h1', kind: 'bearer' },
    replies = [{ status: 200, body: PLAN }],
    env = {},
    settings = {},
    broken = [],
  }: {
    auth?: SessionAuthorization
    replies?: Reply[]
    env?: Record<string, string>
    settings?: Record<string, unknown>
    /** Calls this engine lacks: each rejects. */
    broken?: ('env' | 'settings')[]
  } = {},
): World {
  const w: World = { clock: mock.clock(on, { now: NOW }), usage: USAGE, fetches: [], stepUsage: WARM, auth, agents: [] }
  const queue = [...replies]
  mock.store(on)
  if (broken.includes('env')) {
    on('env.get', () => {
      throw new Error('env.get is not a call on this engine')
    })
  } else {
    mock.env(on, env)
  }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('settings.read', () => {
    if (broken.includes('settings')) {
      throw new Error('settings.read is not a call on this engine')
    }
    return { value: { effortLevel: 'high', ...settings } }
  })
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: w.usage }))
  on('session.compact', () => ({ messages: [SUMMARY], tokensBefore: 52_000, tokensAfter: 4_000 }))
  on('classic.PostCompact', () => ({}))
  on('classic.PostModelSwitch', () => ({}))
  on('classic.SessionStart', () => ({}))
  on('session.authorize', () => ({ value: w.auth }))
  on('agent.list', () => ({ value: w.agents }))
  on('http.fetch', (_$, e) => {
    w.fetches.push({ url: e.url, auth: e.init?.auth })
    const reply = queue.length > 1 ? queue.shift() : queue[0]
    const status = reply?.status ?? 500
    return {
      value: { status, ok: status < 300, headers: {}, text: reply?.text ?? JSON.stringify(reply?.body ?? {}) },
    }
  })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('command.run', { command: 'effort' }, () => ({ text: 'Effort set.' }))
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn',
      usage: w.stepUsage,
    }
  })
  // Stands for the engine's own band: what shows when the mod passes.
  on('ui.render', { component: 'AbovePrompt' }, (engine, e) => {
    const { Text } = engine.ui.resolve(e)
    return <Text>engine band</Text>
  })

  return w
}

async function start($: Engine, w: World): Promise<void> {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await w.clock.advance(1)
}

test('the context row shows fill, tokens, the prompt cache, the model and its effort', async ($, on) => {
  const w = world(on)
  await start($, w)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'context-bar', surface, ...BAND })
    expect((await ui.find({ type: 'Text', text: /26%/ }))?.text).toContain('52k/200k')
    expect(await ui.find({ type: 'Text', text: /^ · cache cold$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /TTL/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /auto-compact/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Opus 5\.5 \(high effort\)/ })).toBeDefined()
    expect(await ui.findAll({ type: 'Text', text: /^▒+$/ })).toHaveLength(1)
    expect(await ui.find({ type: 'Text', text: /MCP tools/ })).toBeUndefined()
    expect(await ui.drawn()).toMatchObject({ props: { paddingTop: 1 } })
    await ui.unmount()
  }
})

test('the usage row shows the account windows from the usage endpoint, and the API cost', async ($, on) => {
  const w = world(on)
  await start($, w)
  expect(w.fetches).toEqual([{ url: USAGE_URL, auth: 'h1' }])
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'context-bar', surface, ...BAND })
    for (const label of ['Session', 'Week', 'Fable']) {
      expect(await ui.find({ type: 'Text', text: label })).toBeDefined()
    }
    expect(await ui.find({ type: 'Text', text: / 23%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: / 35%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: / 12%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /resets 2h14m/ })).toBeDefined()
    expect(await ui.findAll({ type: 'Text', text: /resets 3d16h/ })).toHaveLength(2)
    expect(await ui.find({ type: 'Text', text: /API \$4\.21/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the usage keeps polling while the session sits idle', async ($, on) => {
  const w = world(on, {
    replies: [
      { status: 200, body: PLAN },
      { status: 200, body: { ...PLAN, limits: [{ ...SESSION_ROW, percent: 61 }] } },
    ],
  })
  await start($, w)
  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: / 23%/ })).toBeDefined()

  await w.clock.advance(76_000)
  expect(w.fetches).toHaveLength(2)
  expect(await ui.find({ type: 'Text', text: / 61%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Fable' })).toBeUndefined()
  await ui.unmount()
})

test('older replies without limits fall back to the fixed windows', async ($, on) => {
  const { limits: _, ...fixed } = PLAN
  const w = world(on, { replies: [{ status: 200, body: fixed }] })
  await start($, w)
  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: 'Session' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Week' })).toBeDefined()
  await ui.unmount()
})

test('a failed read says so', async ($, on) => {
  const w = world(on, { replies: [{ status: 401, body: {} }] })
  await start($, w)
  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /usage unavailable \(HTTP 401\)/ })).toBeDefined()
  await ui.unmount()
})

test('an API-key session asks nothing and shows the cost alone', async ($, on) => {
  const w = world(on, { auth: null })
  await start($, w)
  expect(w.fetches).toHaveLength(0)
  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /API \$4\.21/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Session' })).toBeUndefined()
  await ui.unmount()
})

test('a main-thread step moves the fill and the effort; a subagent step does not', async ($, on) => {
  const w = world(on)
  await start($, w)
  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND })

  await step($, { turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'max', messageCount: 4, agentId: 'sub-1' })
  expect(await ui.find({ type: 'Text', text: /26%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\(high effort\)/ })).toBeDefined()

  await step($, { turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 4 })
  expect((await ui.find({ type: 'Text', text: /50%/ }))?.text).toContain('100k/200k')
  expect(await ui.find({ type: 'Text', text: /cache 60m left/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\(xhigh effort\)/ })).toBeDefined()
  await ui.unmount()
})

test('/effort changes the effort shown at once', async ($, on) => {
  const w = world(on)
  await start($, w)
  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND })
  await $.command.run({
    command: 'effort',
    args: 'low',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
  expect(await ui.find({ type: 'Text', text: /\(low effort\)/ })).toBeDefined()
  await ui.unmount()
})

test('the cost follows each measurement', async ($, on) => {
  const w = world(on)
  await start($, w)
  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND })
  await $.session.measure({ context: USAGE.context, rateLimits: [], cost: { usd: 12.5 }, changed: ['cost'] })
  expect(await ui.find({ type: 'Text', text: /API \$12\.50/ })).toBeDefined()
  await ui.unmount()
})

test('/context-bar cycles bar, legend and off', async ($, on) => {
  const w = world(on)
  await start($, w)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'context-bar', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /tools 15k/ })).toBeUndefined()

    await runCommand($, '')
    expect(await ui.find({ type: 'Text', text: / tools 15k/ })).toBeDefined()

    await runCommand($, '')
    expect(await ui.find({ type: 'Text', text: /%/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()

    await runCommand($, 'bar')
    expect(await ui.find({ type: 'Text', text: /26%/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the legend sits right under the context row, above the usage row', async ($, on) => {
  const w = world(on)
  await start($, w)
  await runCommand($, 'legend')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'context-bar', surface, ...BAND })
    const order = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    const at = (pattern: RegExp): number => order.findIndex(text => pattern.test(text))
    expect(at(/26%/)).toBeLessThan(at(/ tools 15k/))
    expect(at(/ tools 15k/)).toBeLessThan(at(/^Session$/))
    const legend = (await ui.findAll({ type: 'Box' })).find(box => box.props.paddingLeft === 8)
    expect(legend?.props.marginTop).toBeUndefined()
    await ui.unmount()
  }
})

test('the legend is one row of the categories that take room, short-named, in bar order', async ($, on) => {
  const w = world(on)
  await start($, w)
  await runCommand($, 'legend')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'context-bar', surface, ...BAND })
    const legend = (await ui.findAll({ type: 'Text' })).map(t => t.text).filter(text => /^ \w+ \d+k$/.test(text))
    expect(legend).toEqual([' prompt 3k', ' tools 15k', ' msgs 34k'])
    expect(await ui.find({ type: 'Text', text: /free|buffer|mcp/i })).toBeUndefined()
    await ui.unmount()
  }
})

test('a narrow legend drops the smallest categories and counts them', async ($, on) => {
  const w = world(on)
  await start($, w)
  await runCommand($, 'legend')
  const ui = await $.ui.mount({
    plugin: 'context-bar',
    surface: 'terminal',
    ...BAND,
    props: { ...BAND.props, bodyColumns: 40 },
  })
  expect(await ui.find({ type: 'Text', text: / prompt 3k/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: / tools 15k/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: / msgs 34k/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ {2}\+1 more$/ })).toBeDefined()
  await ui.unmount()
})

test('a compaction redraws the bar without waiting for the next message', async ($, on) => {
  const w = world(on)
  await start($, w)
  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /26%/ })).toBeDefined()

  w.usage = COMPACTED
  await $.session.compact({ trigger: 'manual', messages: [SUMMARY] })
  await w.clock.advance(300)
  expect((await ui.find({ type: 'Text', text: /11%/ }))?.text).toContain('~22k/200k')

  // The 15-second sync must not put the pre-compaction fill back.
  await w.clock.advance(15_000)
  expect(await ui.find({ type: 'Text', text: /11%/ })).toBeDefined()

  // The next response is the live fill again.
  await step($, { turnId: 't2', index: 0, model: 'claude-opus-5-5', messageCount: 3 })
  expect(await ui.find({ type: 'Text', text: /50%/ })).toBeDefined()
  await ui.unmount()
})

test('an auto-compaction seen only as PostCompact redraws the bar too', async ($, on) => {
  const w = world(on)
  await start($, w)
  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND })
  w.usage = COMPACTED
  await $.classic.PostCompact({ trigger: 'auto', compact_summary: 'summary' })
  await w.clock.advance(300)
  expect(await ui.find({ type: 'Text', text: /11%/ })).toBeDefined()
  await ui.unmount()
})

test('an unknown mode is refused', async ($, on) => {
  const w = world(on)
  await start($, w)
  const result = await runCommand($, 'sideways')
  expect(result.text).toContain('Unknown mode')
})

// Every kind of account the band meets: what the usage row draws for each.
const WEEK_ROW = {
  kind: 'weekly_all',
  group: 'weekly',
  percent: 35,
  resets_at: '2026-10-07T04:00:00Z',
  severity: 'normal',
  is_active: true,
  scope: null,
}

type AccountCase = {
  name: string
  auth?: SessionAuthorization
  replies?: Reply[]
  usage?: Partial<SessionUsage>
  shows: RegExp[]
  hides: RegExp[]
}

const ACCOUNTS: readonly AccountCase[] = [
  {
    name: 'a plan with a 5-hour limit shows the session and the week',
    replies: [{ status: 200, body: { limits: [SESSION_ROW, WEEK_ROW] } }],
    shows: [/^Session$/, /^Week$/, / 23%/, / 35%/],
    hides: [/usage unavailable/],
  },
  {
    name: 'a plan without a 5-hour limit shows the week alone',
    replies: [{ status: 200, body: { limits: [WEEK_ROW] } }],
    shows: [/^Week$/, / 35%/],
    hides: [/^Session$/, /usage unavailable/],
  },
  {
    name: 'the older reply shape without a 5-hour window shows the week alone',
    replies: [{ status: 200, body: { five_hour: null, seven_day: { utilization: 35, resets_at: null } } }],
    shows: [/^Week$/, / 35%/],
    hides: [/^Session$/, /resets/],
  },
  {
    name: 'a limit kind the mod has never seen is labelled from its kind',
    replies: [{ status: 200, body: { limits: [{ kind: 'monthly_spend', percent: 40, resets_at: null }] } }],
    shows: [/^monthly spend$/, / 40%/],
    hides: [/resets/, /undefined|NaN/],
  },
  {
    name: 'a row past 100% fills its meter and says so',
    replies: [{ status: 200, body: { limits: [{ ...WEEK_ROW, percent: 104.6 }] } }],
    shows: [/^Week$/, / 104%/],
    hides: [/NaN/],
  },
  {
    name: 'rows without a percent, or not rows at all, are skipped',
    replies: [{ status: 200, body: { limits: [{ kind: 'session' }, null, 'x', { ...WEEK_ROW }] } }],
    shows: [/^Week$/],
    hides: [/^Session$/, /NaN|undefined/],
  },
  {
    name: 'an account with no plan limits shows the cost alone',
    replies: [{ status: 200, body: { limits: [] } }],
    shows: [/API \$4\.21/],
    hides: [/^Session$/, /^Week$/, /usage unavailable/],
  },
  {
    name: 'a reply that is not JSON says so',
    replies: [{ status: 200, text: '<html>Bad gateway</html>' }],
    shows: [/usage unavailable/],
    hides: [/NaN|undefined/],
  },
  {
    name: 'when the usage endpoint fails, the windows the API response reported stand in',
    replies: [{ status: 503 }],
    usage: {
      rateLimits: [
        { kind: 'five_hour', percentUsed: 23, resetsAt: '2026-10-03T14:14:00Z' },
        { kind: 'seven_day', percentUsed: 35 },
      ],
    },
    shows: [/^Session$/, /^Week$/, /resets 2h14m/],
    hides: [/usage unavailable/],
  },
  {
    name: 'an account the usage endpoint refuses (403) shows the cost alone, quietly',
    replies: [{ status: 403 }],
    shows: [/API \$4\.21/],
    hides: [/usage unavailable/, /^Session$/],
  },
  {
    name: 'a gateway spend limit from the API response shows as a meter',
    auth: null,
    usage: { rateLimits: [{ kind: 'spend_limit', percentUsed: 104.5 }] },
    shows: [/^Spend$/, / 104%/, /API \$4\.21/],
    hides: [/NaN|undefined/],
  },
  {
    name: 'a plan row with a non-number percent is skipped',
    replies: [{ status: 200, body: { limits: [{ kind: 'session', percent: null }, { kind: 'weekly_all', percent: 'high' }] } }],
    shows: [/API \$4\.21/],
    hides: [/^Session$/, /^Week$/, /NaN/],
  },
  {
    name: 'an API key shows the cost alone',
    auth: { handle: 'k1', kind: 'api-key' },
    shows: [/API \$4\.21/],
    hides: [/^Session$/, /usage unavailable/],
  },
  {
    name: 'a cloud provider or gateway shows the cost alone',
    auth: null,
    shows: [/API \$4\.21/],
    hides: [/^Session$/, /usage unavailable/],
  },
  {
    name: 'a host without a cost ledger draws no cost',
    auth: null,
    usage: { cost: undefined },
    shows: [/26%/],
    hides: [/API \$/, /^Usage/],
  },
]

for (const c of ACCOUNTS) {
  test(`accounts: ${c.name}`, async ($, on) => {
    const w = world(on, {
      ...(c.auth === undefined ? {} : { auth: c.auth }),
      ...(c.replies === undefined ? {} : { replies: c.replies }),
    })
    if (c.usage !== undefined) {
      w.usage = { ...USAGE, ...c.usage }
    }
    await start($, w)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'context-bar', surface, ...BAND })
      for (const pattern of c.shows) {
        expect(await ui.find({ type: 'Text', text: pattern })).toBeDefined()
      }
      for (const pattern of c.hides) {
        expect(await ui.find({ type: 'Text', text: pattern })).toBeUndefined()
      }
      await ui.unmount()
    }
  })
}

test('a new install starts in bar mode', async ($, on) => {
  const w = world(on)
  await start($, w)
  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /26%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: / tools 15k/ })).toBeUndefined()
  await ui.unmount()
})

test('a stored mode the mod does not know falls back to bar', async ($, on) => {
  const w = world(on)
  on('store.get', { key: 'mode' }, () => ({ value: 'sideways' }))
  await start($, w)
  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /26%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: / tools 15k/ })).toBeUndefined()
  await ui.unmount()
})

test('the chosen mode is kept for the next session', async ($, on) => {
  const saved: unknown[] = []
  on('store.set', { key: 'mode' }, (_$, e, next) => {
    saved.push(e.value)
    return next(e)
  })
  const w = world(on)
  await start($, w)
  await runCommand($, 'legend')
  expect(saved).toEqual(['legend'])
})

const MAIN = { turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 4 } as const

/** Starts a session in `w` and mounts the band, for the cache tests. */
async function band($: Engine, w: World) {
  await start($, w)

  return $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND })
}

test('the cache counts down from each main-thread response, warns, then expires', async ($, on) => {
  const w = world(on)
  const ui = await band($, w)
  await step($, MAIN)
  expect((await ui.find({ type: 'Text', text: /^ · cache 60m left$/ }))?.props.color).toBeUndefined()

  await w.clock.advance(46 * MINUTE + 1_000)
  expect((await ui.find({ type: 'Text', text: /cache 14m left/ }))?.props.color).toBe('warning')

  await w.clock.advance(14 * MINUTE)
  expect((await ui.find({ type: 'Text', text: /^ · cache expired$/ }))?.props.color).toBe('error')

  // The next response warms it again.
  await step($, MAIN)
  expect(await ui.find({ type: 'Text', text: /cache 60m left/ })).toBeDefined()
  await ui.unmount()
})

test('a subagent step leaves the main cache alone', async ($, on) => {
  const w = world(on)
  const ui = await band($, w)
  await step($, { ...MAIN, agentId: 'sub-1' })
  expect(await ui.find({ type: 'Text', text: /cache cold/ })).toBeDefined()
  await ui.unmount()
})

const FIVE_MINUTE_SIGN_INS: readonly [string, SessionAuthorization][] = [
  ['an API key', { handle: 'k1', kind: 'api-key' }],
  ['a cloud provider', null],
]

for (const [name, auth] of FIVE_MINUTE_SIGN_INS) {
  test(`${name} gets five minutes`, async ($, on) => {
    const w = world(on, { auth })
    const ui = await band($, w)
    await step($, MAIN)
    expect(await ui.find({ type: 'Text', text: /cache 5m left/ })).toBeDefined()
    await w.clock.advance(5 * MINUTE)
    expect(await ui.find({ type: 'Text', text: /cache expired/ })).toBeDefined()
    await ui.unmount()
  })
}

test('a subscription over its plan limit drops to five minutes', async ($, on) => {
  const w = world(on, { replies: [{ status: 200, body: { ...PLAN, limits: [{ ...SESSION_ROW, percent: 100 }] } }] })
  const ui = await band($, w)
  await step($, MAIN)
  expect(await ui.find({ type: 'Text', text: /cache 5m left/ })).toBeDefined()
  expect((await runCommand($, 'ttl')).text).toContain('5m TTL, from the default once usage credits pay')
  await ui.unmount()
})

type RuleCase = {
  name: string
  env?: Record<string, string>
  settings?: Record<string, unknown>
  auth?: SessionAuthorization
  shows: RegExp
  why: string
}

// The documented order: the first match wins.
const RULES: readonly RuleCase[] = [
  {
    name: 'the env var beats the setting',
    env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' },
    settings: { promptCacheTtl: '1h' },
    shows: /cache 5m left/,
    why: 'CLAUDE_CODE_PROMPT_CACHE_TTL',
  },
  { name: 'the setting beats the default', settings: { promptCacheTtl: '5m' }, shows: /cache 5m left/, why: 'promptCacheTtl' },
  {
    name: 'FORCE_PROMPT_CACHING_5M beats the env var',
    env: { FORCE_PROMPT_CACHING_5M: '1', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' },
    shows: /cache 5m left/,
    why: 'FORCE_PROMPT_CACHING_5M',
  },
  {
    name: 'ENABLE_PROMPT_CACHING_1H gives an API key the hour',
    env: { ENABLE_PROMPT_CACHING_1H: 'true' },
    auth: { handle: 'k1', kind: 'api-key' },
    shows: /cache 60m left/,
    why: 'ENABLE_PROMPT_CACHING_1H',
  },
  {
    name: 'the setting beats ENABLE_PROMPT_CACHING_1H',
    env: { ENABLE_PROMPT_CACHING_1H: '1' },
    settings: { promptCacheTtl: '5m' },
    shows: /cache 5m left/,
    why: 'promptCacheTtl',
  },
  { name: 'a value other than 5m or 1h is ignored', env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '2h' }, shows: /cache 60m left/, why: 'subscription' },
  { name: 'caching off for another model', env: { DISABLE_PROMPT_CACHING_SONNET: '1' }, shows: /cache 60m left/, why: 'subscription' },
  { name: 'caching off altogether', env: { DISABLE_PROMPT_CACHING: '1' }, shows: /cache off/, why: 'DISABLE_PROMPT_CACHING' },
]

for (const c of RULES) {
  test(`the TTL rules: ${c.name}`, async ($, on) => {
    const w = world(on, {
      env: c.env ?? {},
      settings: c.settings ?? {},
      ...(c.auth === undefined ? {} : { auth: c.auth }),
    })
    const ui = await band($, w)
    await step($, MAIN)
    expect(await ui.find({ type: 'Text', text: c.shows })).toBeDefined()
    expect((await runCommand($, 'ttl')).text).toContain(c.why)
    await ui.unmount()
  })
}

test('a model switch that reports another TTL than the rules is believed, and starts cold', async ($, on) => {
  const w = world(on)
  const ui = await band($, w)
  await step($, MAIN)
  await $.classic.PostModelSwitch({
    from_model: 'claude-opus-5-5',
    to_model: 'claude-sonnet-5-5',
    requested_model: 'sonnet',
    source: 'command',
    context_tokens: 100_000,
    prompt_cache_warm: true,
    cache_ttl: '5m',
    estimated_cache_write_usd: 0.4,
    pricing: 'catalog',
  })
  expect(await ui.find({ type: 'Text', text: /cache cold/ })).toBeDefined()

  expect((await runCommand($, 'ttl')).text).toContain('5m TTL, from what the last model switch reported')

  // The rules still say what they said: the report stands for the next request.
  await step($, MAIN)
  expect(await ui.find({ type: 'Text', text: /cache 5m left/ })).toBeDefined()
  await ui.unmount()
})

test('a resumed session that is still warm counts down from its last response', async ($, on) => {
  const w = world(on)
  const ui = await band($, w)
  await $.classic.SessionStart({
    source: 'resume',
    seconds_since_last_response: 600,
    prompt_cache_likely_expired: false,
    context_tokens: 52_000,
  })
  expect(await ui.find({ type: 'Text', text: /cache 50m left/ })).toBeDefined()
  await ui.unmount()
})

test('/clear and compaction leave the cache cold', async ($, on) => {
  const w = world(on)
  const ui = await band($, w)
  await step($, MAIN)
  await $.classic.SessionStart({ source: 'clear' })
  expect(await ui.find({ type: 'Text', text: /cache cold/ })).toBeDefined()

  await step($, MAIN)
  w.usage = COMPACTED
  await $.session.compact({ trigger: 'manual', messages: [SUMMARY] })
  expect(await ui.find({ type: 'Text', text: /cache cold/ })).toBeDefined()
  await ui.unmount()
})

test('/context-bar ttl says the TTL, why, and how warm the cache is', async ($, on) => {
  const w = world(on)
  await band($, w)
  await step($, MAIN)
  await w.clock.advance(20 * MINUTE)
  const { text } = await runCommand($, 'ttl')
  expect(text).toContain('1h TTL, from the default for a subscription within plan usage; warm, 40m left')
  expect(text).toContain('promptCacheTtl')
})

test('a value an earlier version kept is rebuilt', async ($, on) => {
  const w = world(on)
  // What the version before this one wrote stays through the reload, once.
  let isSeeded = false
  on('state.get', { key: 'cache' }, (_$, e, next) => {
    if (isSeeded) {
      return next(e)
    }
    isSeeded = true

    return {
      value: { value: { ttl: '5m', source: 'guess', lastAt: NOW - 2 * MINUTE, lastInput: 0, model: null }, version: 1 },
    }
  })
  const ui = await band($, w)
  expect(await ui.find({ type: 'Text', text: /cache 58m left/ })).toBeDefined()
  await ui.unmount()
})

test('a narrow band drops the model before the cache', async ($, on) => {
  const w = world(on)
  await start($, w)
  const ui = await $.ui.mount({
    plugin: 'context-bar',
    surface: 'terminal',
    ...BAND,
    props: { ...BAND.props, bodyColumns: 70 },
  })
  expect(await ui.find({ type: 'Text', text: /cache cold/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Opus 5\.5/ })).toBeUndefined()
  await ui.unmount()
})

async function step($: Engine, e: Parameters<Engine['turn']['step']>[0]): Promise<void> {
  const stream = $.turn.step(e)
  for await (const _ of stream) {
    // drain
  }
  await stream.result
}

function runCommand($: Engine, args: string) {
  return $.command.run({
    command: 'context-bar',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
}

test('an endpoint that stops answering for the account hands over to the API response windows', async ($, on) => {
  const w = world(on, { replies: [{ status: 200, body: PLAN }, { status: 404 }] })
  w.usage = { ...USAGE, rateLimits: [{ kind: 'seven_day', percentUsed: 36 }] }
  await start($, w)
  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: 'Fable' })).toBeDefined()

  await w.clock.advance(76_000)
  expect(await ui.find({ type: 'Text', text: 'Fable' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: / 36%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /usage unavailable/ })).toBeUndefined()

  // Not asked again every minute.
  const asked = w.fetches.length
  await w.clock.advance(3 * 60_000)
  expect(w.fetches.length).toBe(asked)
  await ui.unmount()
})

// What the review of 0.2.0 found, each held to what it should do instead.

/** The text a drawn element shows, its children's joined. */
function drawnText(node: unknown): string {
  if (typeof node === 'string') {
    return node
  }
  if (typeof node === 'object' && node !== null && Array.isArray((node as { children?: unknown }).children)) {
    return ((node as { children: unknown[] }).children).map(drawnText).join('')
  }

  return ''
}

test('a context category of a kind the mod has never seen still draws the band', async ($, on) => {
  const w = world(on)
  const categories = [...USAGE.context.breakdown!.categories, { name: 'Reserved', tokens: 2_000, color: 'inactive', isDeferred: false, kind: 'reserved' }]
  w.usage = { ...USAGE, context: { ...USAGE.context, breakdown: { ...USAGE.context.breakdown!, categories } as never } }
  await start($, w)
  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /26%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeUndefined()
  await ui.unmount()
})

test('a breakdown without a model name falls back to the session model', async ($, on) => {
  const w = world(on)
  w.usage = { ...USAGE, context: { ...USAGE.context, breakdown: { ...USAGE.context.breakdown!, model: undefined } as never } }
  await start($, w)
  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /claude-opus-5-5 \(high effort\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /undefined/ })).toBeUndefined()
  await ui.unmount()
})

test('without $.env.get the band, the polling and the countdown still work', async ($, on) => {
  const w = world(on, { broken: ['env'] })
  await start($, w)
  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND })
  await step($, MAIN)
  expect(await ui.find({ type: 'Text', text: /26%|50%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /cache 60m left/ })).toBeDefined()
  await w.clock.advance(5 * MINUTE)
  expect(w.fetches.length).toBeGreaterThan(1)
  await ui.unmount()
})

test('without $.settings.read the band draws at once and the countdown works', async ($, on) => {
  const w = world(on, { broken: ['settings'] })
  await start($, w)
  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /26%/ })).toBeDefined()
  await step($, MAIN)
  expect(await ui.find({ type: 'Text', text: /cache 60m left/ })).toBeDefined()
  await ui.unmount()
})

for (const ttl of ['30m', undefined]) {
  test(`a model switch reporting cache_ttl ${String(ttl)} keeps to the rules`, async ($, on) => {
    const w = world(on)
    const ui = await band($, w)
    await $.classic.PostModelSwitch({
      from_model: 'claude-opus-5-5',
      to_model: 'claude-sonnet-5-5',
      requested_model: 'sonnet',
      source: 'command',
      context_tokens: 100_000,
      prompt_cache_warm: true,
      cache_ttl: ttl as never,
      estimated_cache_write_usd: 0.4,
      pricing: 'catalog',
    })
    await step($, MAIN)
    expect(await ui.find({ type: 'Text', text: /cache 60m left/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /NaN|undefined/ })).toBeUndefined()
    expect((await runCommand($, 'ttl')).text).toContain('1h TTL, from the default for a subscription')
    await ui.unmount()
  })
}

test('a response with no cache activity shows the cache as off, and the next cached one brings it back', async ($, on) => {
  const w = world(on)
  const ui = await band($, w)
  w.stepUsage = { ...WARM, input_tokens: 100_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  await step($, MAIN)
  expect(await ui.find({ type: 'Text', text: /cache off/ })).toBeDefined()
  expect((await runCommand($, 'ttl')).text).toContain('off for this model')

  w.stepUsage = WARM
  await step($, MAIN)
  expect(await ui.find({ type: 'Text', text: /cache 60m left/ })).toBeDefined()
  await ui.unmount()
})

test('a subagent compaction leaves the main cache warm', async ($, on) => {
  const w = world(on)
  const ui = await band($, w)
  await step($, MAIN)
  await $.classic.PostCompact({ trigger: 'auto', compact_summary: 'summary', agent_id: 'sub-1' })
  await $.classic.SessionStart({ source: 'compact', agent_id: 'sub-1' })
  expect(await ui.find({ type: 'Text', text: /cache 60m left/ })).toBeDefined()
  await ui.unmount()
})

test('the model a resume restores keeps its warm countdown', async ($, on) => {
  const w = world(on)
  const ui = await band($, w)
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 600, prompt_cache_likely_expired: false })
  await $.classic.PostModelSwitch({
    from_model: 'claude-sonnet-5-5',
    to_model: 'claude-opus-5-5',
    requested_model: null,
    source: 'resume',
    context_tokens: 52_000,
    prompt_cache_warm: true,
    cache_ttl: '1h',
    estimated_cache_write_usd: 0,
    pricing: 'catalog',
  })
  expect(await ui.find({ type: 'Text', text: /cache 50m left/ })).toBeDefined()
  await ui.unmount()
})

test('a thinking budget shows as one, not as an effort level', async ($, on) => {
  const w = world(on)
  const ui = await band($, w)
  await step($, { ...MAIN, effort: 32_000 })
  expect(await ui.find({ type: 'Text', text: /Opus 5\.5 \(32k thinking\)/ })).toBeDefined()
  await ui.unmount()
})

test('an empty limits list beside the old fixed fields draws no meters', async ($, on) => {
  const w = world(on, { replies: [{ status: 200, body: { ...PLAN, limits: [] } }] })
  await start($, w)
  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /^Session$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Week$/ })).toBeUndefined()
  await ui.unmount()
})

test('a limit the server marks inactive is not drawn', async ($, on) => {
  const w = world(on, { replies: [{ status: 200, body: { limits: [{ ...SESSION_ROW, is_active: false }, WEEK_ROW] } }] })
  await start($, w)
  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /^Session$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Week$/ })).toBeDefined()
  await ui.unmount()
})

test('signing out of the subscription mid-session clears its meters', async ($, on) => {
  const w = world(on)
  await start($, w)
  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /^Session$/ })).toBeDefined()
  w.auth = { handle: 'k1', kind: 'api-key' }
  await w.clock.advance(76_000)
  expect(await ui.find({ type: 'Text', text: /^Session$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /API \$4\.21/ })).toBeDefined()
  await ui.unmount()
})

test('failures back off: 401s are asked at most four times in ten minutes', async ($, on) => {
  const w = world(on, { replies: [{ status: 401 }] })
  await start($, w)
  await w.clock.advance(10 * MINUTE)
  expect(w.fetches.length).toBeLessThanOrEqual(4)
})

test('turns do not break a 429 backoff', async ($, on) => {
  const w = world(on, { replies: [{ status: 429 }] })
  await start($, w)
  for (let i = 0; i < 5; i += 1) {
    await w.clock.advance(21_000)
    await $.session.measure({ context: USAGE.context, rateLimits: [], cost: { usd: 1 }, changed: ['cost'] })
  }
  expect(w.fetches).toHaveLength(1)
})

test('the band switched off asks the server nothing, and catches up when switched on', async ($, on) => {
  const w = world(on)
  await start($, w)
  await runCommand($, 'off')
  const asked = w.fetches.length
  await w.clock.advance(10 * MINUTE)
  expect(w.fetches.length).toBe(asked)
  await runCommand($, 'bar')
  await w.clock.advance(1)
  expect(w.fetches.length).toBe(asked + 1)
})

test('a -p or SDK run that draws nothing asks the server nothing', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
  await w.clock.advance(3 * MINUTE)
  expect(w.fetches).toHaveLength(0)
})

test('with nonessential traffic off the server is not asked, and the API response windows show', async ($, on) => {
  const w = world(on, { env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } })
  w.usage = { ...USAGE, rateLimits: [{ kind: 'seven_day', percentUsed: 35 }] }
  await start($, w)
  await w.clock.advance(3 * MINUTE)
  expect(w.fetches).toHaveLength(0)
  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /^Week$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /usage unavailable/ })).toBeUndefined()
  // The live figures still follow the session between turns.
  w.usage = { ...w.usage, cost: { usd: 7.5 }, rateLimits: [{ kind: 'seven_day', percentUsed: 40 }] }
  await w.clock.advance(15_000)
  expect(await ui.find({ type: 'Text', text: /API \$7\.50/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: / 40%/ })).toBeDefined()
  await ui.unmount()
})

test("another session's 429 holds this one back too, and its meters say they are stale", async ($, on) => {
  let retryAt: unknown = 0
  on('store.get', { key: 'planRetryAt' }, () => ({ value: retryAt }))
  const w = world(on)
  await start($, w)
  expect(w.fetches).toHaveLength(1)
  retryAt = NOW + 10 * MINUTE
  await w.clock.advance(4 * MINUTE)
  expect(w.fetches).toHaveLength(1)
  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /stale/ })).toBeDefined()
  await ui.unmount()
})

test('a stored wait further off than any this version sets is ignored', async ($, on) => {
  on('store.get', { key: 'planRetryAt' }, () => ({ value: NOW + 10 * 24 * 60 * MINUTE }))
  const w = world(on)
  await start($, w)
  await w.clock.advance(3 * MINUTE)
  expect(w.fetches.length).toBeGreaterThan(1)
})

test('a store that rejects does not stop the polling', async ($, on) => {
  on('store.get', { key: 'planRetryAt' }, () => {
    throw new Error('the store is locked')
  })
  const w = world(on)
  await start($, w)
  await w.clock.advance(3 * MINUTE)
  expect(w.fetches.length).toBeGreaterThan(1)
})

test('a session a surface attaches to later starts polling then', async ($, on) => {
  let surfaces: RenderSurface[] = []
  on('session.surfaces', () => ({ value: surfaces }))
  const w = world(on)
  await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
  await w.clock.advance(2 * MINUTE)
  expect(w.fetches).toHaveLength(0)
  surfaces = ['desktop']
  w.usage = { ...USAGE, cost: { usd: 9.99 } }
  await w.clock.advance(2 * MINUTE)
  expect(w.fetches.length).toBeGreaterThan(0)
  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: /API \$9\.99/ })).toBeDefined()
  await ui.unmount()
})

test('through a gateway, a reply without cache figures does not switch the countdown off', async ($, on) => {
  const w = world(on, { auth: null })
  const ui = await band($, w)
  w.stepUsage = { ...WARM, input_tokens: 100_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  await step($, MAIN)
  expect(await ui.find({ type: 'Text', text: /cache off/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /cache 5m left/ })).toBeDefined()
  await ui.unmount()
})

test('a 30-column terminal keeps the context row inside 30 columns', async ($, on) => {
  const w = world(on)
  await start($, w)
  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND, props: { ...BAND.props, bodyColumns: 30 } })
  const tree = (await ui.drawn()) as { children: unknown[] }
  expect(drawnText(tree.children[0]).length).toBeLessThanOrEqual(30)
  await ui.unmount()
})

test('a reset time written without an offset is read as UTC', async ($, on) => {
  const w = world(on, { replies: [{ status: 200, body: { limits: [{ ...WEEK_ROW, resets_at: '2026-10-03T14:14:00' }] } }] })
  await start($, w)
  const ui = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /resets 2h14m/ })).toBeDefined()
  await ui.unmount()
})

test('a clock that jumps back never shows more than the TTL', async ($, on) => {
  const w = world(on)
  // The last request's time, written before the clock went back ten minutes.
  let isSeeded = false
  on('state.get', { key: 'cache' }, (_$, e, next) => {
    if (isSeeded) {
      return next(e)
    }
    isSeeded = true

    return {
      value: { value: { ttl: '1h', why: 'x', reported: null, lastAt: NOW + 10 * MINUTE, isOff: false }, version: 1 },
    }
  })
  const ui = await band($, w)
  expect(await ui.find({ type: 'Text', text: /cache 60m left/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /cache (6[1-9]|[7-9]\d)m left/ })).toBeUndefined()
  await ui.unmount()
})

// The session's cost split between the main conversation and its subagents.

function agent(id: string, type: string, description: string): AgentInfo {
  return { id, type, description, status: 'running' }
}

/** One reply, after which Claude Code's running total reads `usd`. */
async function costStep($: Engine, w: World, usd: number, e: Parameters<Engine['turn']['step']>[0]): Promise<void> {
  w.usage = { ...w.usage, cost: { usd } }
  await step($, e)
}

test("each reply's rise in Claude Code's cost goes to the loop that made it", async ($, on) => {
  const w = world(on)
  w.agents = [agent('sub-1', 'Explore', 'find the auth middleware'), agent('sub-2', 'general-purpose', 'migrate the config loader')]
  const ui = await band($, w)
  await costStep($, w, 5.21, MAIN)
  await costStep($, w, 7.21, { ...MAIN, agentId: 'sub-1' })
  await costStep($, w, 7.71, { ...MAIN, agentId: 'sub-2' })
  expect(await ui.find({ type: 'Text', text: /API \$7\.71 \(agents \$2\.50\)/ })).toBeDefined()

  const text = (await runCommand($, 'agents')).text ?? ''
  expect(text).toContain('Subagents this session: $2.50 of $7.71 (32%)')
  expect(text).toMatch(/Explore\s+find the auth middleware\s+\$2\.00/)
  expect(text).toMatch(/general-purpose\s+migrate the config loader\s+\$0\.50/)
  expect(text.indexOf('Explore')).toBeLessThan(text.indexOf('general-purpose'))
  expect(text).toContain('The first $4.21 came before the split started')
  await ui.unmount()
})

test('replies that land together share the rise by what each one used', async ($, on) => {
  const w = world(on)
  w.agents = [agent('sub-1', 'Explore', 'find the auth middleware')]
  const ui = await band($, w)
  // Both replies arrive before the total moves (it stays at the world's
  // $4.2134); the next reading splits the rise between them.
  await step($, MAIN)
  await step($, { ...MAIN, agentId: 'sub-1' })
  w.usage = { ...w.usage, cost: { usd: 4.3134 } }
  await w.clock.advance(15_000)
  expect(await ui.find({ type: 'Text', text: /\(agents \$0\.05\)/ })).toBeDefined()
  await ui.unmount()
})

test('a rise no reply explains is kept apart from the subagents', async ($, on) => {
  const w = world(on)
  const ui = await band($, w)
  w.usage = { ...w.usage, cost: { usd: 4.71 } }
  await w.clock.advance(15_000)
  expect(await ui.find({ type: 'Text', text: /API \$4\.71$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\(agents/ })).toBeUndefined()
  expect((await runCommand($, 'agents')).text).toBe('No subagents have run in this session yet.')
  await ui.unmount()
})

test('a loop the agent list does not name, such as a fork, is not counted as a subagent', async ($, on) => {
  const w = world(on)
  const ui = await band($, w)
  await costStep($, w, 4.71, { ...MAIN, agentId: 'fork-1' })
  expect(await ui.find({ type: 'Text', text: /\(agents/ })).toBeUndefined()
  await ui.unmount()
})

test('a total that starts over starts the split over', async ($, on) => {
  const w = world(on)
  w.agents = [agent('sub-1', 'Explore', 'find the auth middleware')]
  const ui = await band($, w)
  await costStep($, w, 6.21, { ...MAIN, agentId: 'sub-1' })
  expect(await ui.find({ type: 'Text', text: /\(agents \$2\.00\)/ })).toBeDefined()
  await costStep($, w, 0.4, MAIN)
  expect(await ui.find({ type: 'Text', text: /\(agents/ })).toBeUndefined()
  await ui.unmount()
})

test('a subagent the list has since dropped keeps the cost it was given', async ($, on) => {
  const w = world(on)
  w.agents = [agent('sub-1', 'Explore', 'find the auth middleware')]
  const ui = await band($, w)
  await costStep($, w, 5.21, { ...MAIN, agentId: 'sub-1' })
  w.agents = []
  await costStep($, w, 5.71, { ...MAIN, agentId: 'sub-1' })
  expect(await ui.find({ type: 'Text', text: /\(agents \$1\.50\)/ })).toBeDefined()
  await ui.unmount()
})
