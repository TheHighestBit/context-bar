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

/** The account's usage as last read from the server, shared by every session. */
export type PlanUsage = {
  windows: PlanWindow[]
  fetchedAt: number
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'context-bar': {
      snapshot: ContextSnapshot | null
      mode: ContextBarMode
      plan: PlanUsage | null
      cost: number | null
      effort: string | null
    }
  }
}
