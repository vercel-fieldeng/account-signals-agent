import type { Snapshot, SourceSystem } from "./contracts"

export type SignalWindow = {
  startedAt: string
  endedAt: string
}

export type SignalSourceContext = {
  window: SignalWindow
  cursor?: string
}

export type SignalSourceResult = {
  snapshots: Snapshot[]
  nextCursor?: string
}

export interface SignalSourceAdapter {
  readonly source: SourceSystem
  collect(context: SignalSourceContext): Promise<SignalSourceResult>
}
