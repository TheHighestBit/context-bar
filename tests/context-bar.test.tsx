import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On, SessionAuthorization, SessionUsage } from 'claude-code'

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

type Reply = { status: number; body: unknown }

type World = {
  clock: MockClock
  fetches: { url: string; auth: string | undefined }[]
}

/** Stands up what sits beneath the plugin: the engine's answers, the network, a clock. */
function world(
  on: On,
  { auth = { handle: 'h1', kind: 'bearer' }, replies = [{ status: 200, body: PLAN }] }: {
    auth?: SessionAuthorization
    replies?: Reply[]
  } = {},
): World {
  const w: World = { clock: mock.clock(on, { now: NOW }), fetches: [] }
  const queue = [...replies]
  mock.store(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('settings.read', () => ({ value: { effortLevel: 'high' } }))
  on('session.usage', () => ({ value: USAGE }))
  on('session.authorize', () => ({ value: auth }))
  on('http.fetch', (_$, e) => {
    w.fetches.push({ url: e.url, auth: e.init?.auth })
    const reply = queue.length > 1 ? queue.shift() : queue[0]
    const status = reply?.status ?? 500
    return {
      value: { status, ok: status < 300, headers: {}, text: JSON.stringify(reply?.body ?? {}) },
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
      usage: {
        model: 'claude-opus-5-5',
        input_tokens: 1_000,
        output_tokens: 50,
        cache_read_input_tokens: 51_000,
        cache_creation_input_tokens: 48_000,
      },
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

test('the context row shows fill, tokens, room to compact, the model and its effort', async ($, on) => {
  const w = world(on)
  await start($, w)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'context-bar', surface, ...BAND })
    expect((await ui.find({ type: 'Text', text: /26%/ }))?.text).toContain('52k/200k')
    expect(await ui.find({ type: 'Text', text: /115k to auto-compact/ })).toBeDefined()
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
  expect(await ui.find({ type: 'Text', text: /67k to auto-compact/ })).toBeDefined()
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
    expect(await ui.find({ type: 'Text', text: /System tools/ })).toBeUndefined()

    await runCommand($, '')
    expect(await ui.find({ type: 'Text', text: /System tools 15k/ })).toBeDefined()

    await runCommand($, '')
    expect(await ui.find({ type: 'Text', text: /%/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()

    await runCommand($, 'bar')
    expect(await ui.find({ type: 'Text', text: /26%/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the legend sits under the context row, above the usage row', async ($, on) => {
  const w = world(on)
  await start($, w)
  await runCommand($, 'legend')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'context-bar', surface, ...BAND })
    const order = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    const at = (pattern: RegExp): number => order.findIndex(text => pattern.test(text))
    expect(at(/26%/)).toBeLessThan(at(/System tools 15k/))
    expect(at(/System tools 15k/)).toBeLessThan(at(/^Session$/))
    await ui.unmount()
  }
})

test('an unknown mode is refused', async ($, on) => {
  const w = world(on)
  await start($, w)
  const result = await runCommand($, 'sideways')
  expect(result.text).toContain('Unknown mode')
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
