import {
  SCHEMA_VERSION,
  accountSignalSummarySchema,
  normalizedSignalSchema,
  signalDigestSchema,
  type AccountSignalSummary,
  type NormalizedSignal,
  type SignalDigest,
  type SignalSeverity,
} from "./contracts"

const severityWeight: Record<SignalSeverity, number> = {
  info: 15,
  warning: 30,
  critical: 50,
}

function scoreSignals(signals: NormalizedSignal[]) {
  return Math.min(
    100,
    signals.reduce((score, signal) => score + severityWeight[signal.severity], 0),
  )
}

export function normalizeSignal(input: unknown): NormalizedSignal {
  return normalizedSignalSchema.parse(input)
}

export function summarizeAccount(
  signals: NormalizedSignal[],
  asOf: string,
): AccountSignalSummary {
  if (signals.length === 0) {
    throw new Error("Cannot summarize an account without signals")
  }

  const sortedSignals = [...signals].sort((left, right) =>
    right.observedAt.localeCompare(left.observedAt),
  )
  const [latestSignal] = sortedSignals
  const accountId = latestSignal.account.id

  if (sortedSignals.some((signal) => signal.account.id !== accountId)) {
    throw new Error("All signals in an account summary must share an account ID")
  }

  const expansionSignals = sortedSignals.filter(
    (signal) => signal.direction === "expansion",
  )
  const riskSignals = sortedSignals.filter((signal) => signal.direction === "risk")
  const neutralSignals = sortedSignals.filter(
    (signal) => signal.direction === "neutral",
  )

  return accountSignalSummarySchema.parse({
    account: latestSignal.account,
    asOf,
    expansionScore: scoreSignals(expansionSignals),
    riskScore: scoreSignals(riskSignals),
    latestSignalAt: latestSignal.observedAt,
    expansionSignals,
    riskSignals,
    neutralSignals,
  })
}

export function createSignalDigest(
  signals: NormalizedSignal[],
  windowStartedAt: string,
  windowEndedAt: string,
  generatedAt = windowEndedAt,
): SignalDigest {
  const signalsByAccount = signals.reduce<Map<string, NormalizedSignal[]>>(
    (groupedSignals, signal) => {
      const accountSignals = groupedSignals.get(signal.account.id) ?? []
      accountSignals.push(signal)
      groupedSignals.set(signal.account.id, accountSignals)
      return groupedSignals
    },
    new Map(),
  )
  const accounts = [...signalsByAccount.values()]
    .map((accountSignals) => summarizeAccount(accountSignals, windowEndedAt))
    .sort(
      (left, right) =>
        Math.max(right.riskScore, right.expansionScore) -
          Math.max(left.riskScore, left.expansionScore) ||
        right.latestSignalAt.localeCompare(left.latestSignalAt),
    )

  return signalDigestSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    windowStartedAt,
    windowEndedAt,
    accounts,
  })
}
