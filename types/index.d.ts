export type ContextSegmentKind = 'used' | 'free' | 'buffer'

export type ContextSegment = {
  name: string
  tokens: number
  color: string
  kind: ContextSegmentKind
}

export type ContextSnapshot = {
  model: string
  tokens: number
  window: number
  isEstimate: boolean
  segments: ContextSegment[]
  compactAt: number | null
}

export type ContextBarMode = 'bar' | 'legend' | 'off'

/** One of the account's usage windows, as the usage endpoint lists it. */
export type PlanWindow = {
  label: string
  percent: number
  resetsAt: string | null
}

/** The account's usage as this session last read it (from the server, or from another session's read). */
export type PlanUsage = {
  windows: PlanWindow[]
  fetchedAt: number
  error: string | null
}

/** How long the prompt cache keeps an entry after its last read or write. */
export type CacheTtl = '5m' | '1h'

/**
 * A model switch's own `cache_ttl` that differed from the documented rules,
 * kept for as long as the rules still answer what they answered then.
 */
export type ReportedTtl = {
  ttl: CacheTtl
  rulesTtl: CacheTtl | null
}

/** The main conversation's prompt cache, as the mod follows it. */
export type CacheState = {
  /** The TTL the main conversation's requests ask for; null with prompt caching off. */
  ttl: CacheTtl | null
  /** What decided it: the env var, setting or default that matched first. */
  why: string
  reported: ReportedTtl | null
  /**
   * When the last main-thread request that got a response went out, in
   * `$.clock.now()` ms; null while nothing is cached for this conversation
   * (before the first response, after /clear, a compaction or a model switch).
   */
  lastAt: number | null
  /** The last main-thread response read and wrote nothing to the cache: caching is off for this model. */
  isOff: boolean
}

/** One subagent's share of the session's cost, as the band attributed it. */
export type AgentCost = {
  id: string
  /** The agent type it was spawned as (`Explore`, `general-purpose`, `teammate`, ...). */
  type: string
  /** The Agent call's few-word description of the task. */
  description: string
  usd: number
}

/**
 * The session's cost split between the main conversation and its subagents,
 * attributed reply by reply from Claude Code's own running total: no price
 * table of the mod's own.
 */
export type CostSplit = {
  /** What the session had cost before the split started (a resumed session): not divided. */
  baseline: number
  /** Claude Code's running total at the last reading. */
  lastUsd: number
  mainUsd: number
  /** Cost no reply accounts for: Claude Code's own calls (compaction, titles), its forks and workflows. */
  otherUsd: number
  agents: AgentCost[]
}

declare module 'claude-code' {
  interface PluginState {
    'context-bar': {
      snapshot: ContextSnapshot | null
      mode: ContextBarMode
      plan: PlanUsage | null
      cost: number | null
      effort: string | null
      cache: CacheState | null
      /** Whole minutes the cache has left (0: expired), bumped so the countdown redraws. */
      cacheLeft: number | null
      /** The rate-limit windows the last API response reported, for when the usage endpoint has none. */
      limits: PlanWindow[]
      /** The session's cost, split between the main conversation and its subagents. */
      split: CostSplit | null
    }
  }
}
