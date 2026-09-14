import type { NormalizedSignal, SignalSource } from "./contracts"

export type SignalWindow = {
  startedAt: string
  endedAt: string
}

export type SignalSourceContext = {
  window: SignalWindow
  cursor?: string
}

export type SignalSourceResult = {
  signals: NormalizedSignal[]
  nextCursor?: string
}

export interface SignalSourceAdapter {
  readonly source: SignalSource
  collect(context: SignalSourceContext): Promise<SignalSourceResult>
}
