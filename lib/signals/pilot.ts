import type { NormalizedSignal, SignalCategory, SourceSystem } from "./contracts"
import {
  DEFAULT_RANKING_CONFIG,
  rankSignals,
  type RankedOpportunity,
  type RankingConfig,
  type RankingOptions,
} from "./ranking"

export type PilotMode = "shadow" | "disabled"
export type PilotTaxonomy = Partial<Record<SignalCategory, string>>

type RankingTuning = Omit<Partial<RankingConfig>, "weights"> & {
  weights?: Partial<Omit<RankingConfig["weights"], "signalType">> & {
    signalType?: Partial<Record<SignalCategory, number>>
  }
}

export type ShadowPilotConfig = {
  mode: PilotMode
  threshold: number
  taxonomy: PilotTaxonomy
  ranking: RankingTuning
  revision: string
}

export const DEFAULT_SHADOW_PILOT_CONFIG: ShadowPilotConfig = {
  mode: "shadow",
  threshold: 0,
  taxonomy: {
    new_project: "platform adoption",
    consumption_growth: "consumption growth",
    it_hiring: "IT hiring",
    it_company_news: "IT company news",
  },
  ranking: {
    weights: { ...DEFAULT_RANKING_CONFIG.weights },
    recencyHalfLifeDays: DEFAULT_RANKING_CONFIG.recencyHalfLifeDays,
    maxOpportunitiesPerAccount: DEFAULT_RANKING_CONFIG.maxOpportunitiesPerAccount,
  },
  revision: "shadow-pilot-v1",
}

export type PilotSourceFailure = {
  source: SourceSystem
  code: string
  retryable: boolean
}

export type PilotCase = {
  id: string
  signal: NormalizedSignal
  /** Ground truth from a reviewer, not from a customer system. */
  relevant: boolean
  rationale: string
}

export type PilotErrorBucket = "true_positive" | "false_positive" | "miss"

export type PilotCaseResult = PilotCase & {
  selected: boolean
  outcome: PilotErrorBucket
  taxonomyLabel: string
  rankedOpportunityId: string | null
  score: number | null
}

export type PilotMetrics = {
  truePositives: number
  falsePositives: number
  misses: number
  precision: number
  coverage: number
  sourceFailures: number
  evaluatedCases: number
}

export type ShadowPilotEvaluation = {
  mode: PilotMode
  config: ShadowPilotConfig
  cases: PilotCaseResult[]
  sourceFailures: PilotSourceFailure[]
  metrics: PilotMetrics
  rankedOpportunities: RankedOpportunity[]
  effects: { persisted: false; deliveredToSlack: false }
}

export type RedactedPilotSample = {
  signals: readonly NormalizedSignal[]
  labels: readonly PilotCase[]
  sourceFailures: readonly PilotSourceFailure[]
}

function ratio(numerator: number, denominator: number) {
  return denominator === 0 ? 1 : Number((numerator / denominator).toFixed(4))
}

function validateConfig(config: ShadowPilotConfig) {
  if (!Number.isFinite(config.threshold) || config.threshold < 0) {
    throw new Error("Pilot threshold must be a non-negative finite number")
  }
  if (!config.revision.trim()) throw new Error("Pilot revision is required")
}

/**
 * Pure, review-only evaluation. It accepts no repository or Slack client and
 * cannot persist a production baseline or deliver a Slack message.
 */
export function evaluateShadowPilot(
  sample: RedactedPilotSample,
  config: ShadowPilotConfig = DEFAULT_SHADOW_PILOT_CONFIG,
): ShadowPilotEvaluation {
  validateConfig(config)
  const rankedOpportunities = config.mode === "disabled"
    ? []
    : rankSignals(sample.signals, { config: config.ranking as RankingOptions["config"] }).flatMap((account) => account.opportunities)
  const eligible = rankedOpportunities.filter((opportunity) => opportunity.score >= config.threshold)
  const selectedIds = new Set(eligible.flatMap((opportunity) => opportunity.sourceSignalIds))
  const opportunityBySignalId = new Map(
    rankedOpportunities.flatMap((opportunity) => opportunity.sourceSignalIds.map((id) => [id, opportunity] as const)),
  )
  const cases = sample.labels.map((item) => {
    const opportunity = opportunityBySignalId.get(item.signal.id)
    const selected = config.mode === "shadow" && selectedIds.has(item.signal.id)
    const outcome: PilotErrorBucket = selected
      ? item.relevant ? "true_positive" : "false_positive"
      : item.relevant ? "miss" : "true_positive"
    return {
      ...item,
      selected,
      outcome,
      taxonomyLabel: config.taxonomy[item.signal.category] ?? item.signal.category,
      rankedOpportunityId: opportunity?.id ?? null,
      score: opportunity?.score ?? null,
    }
  })
  const truePositives = cases.filter((item) => item.outcome === "true_positive" && item.selected).length
  const falsePositives = cases.filter((item) => item.outcome === "false_positive").length
  const misses = cases.filter((item) => item.outcome === "miss").length
  return {
    mode: config.mode,
    config,
    cases,
    sourceFailures: sample.sourceFailures.map((failure) => ({ ...failure })),
    metrics: {
      truePositives,
      falsePositives,
      misses,
      precision: ratio(truePositives, truePositives + falsePositives),
      coverage: ratio(truePositives, truePositives + misses),
      sourceFailures: sample.sourceFailures.length,
      evaluatedCases: cases.length,
    },
    rankedOpportunities,
    effects: { persisted: false, deliveredToSlack: false },
  }
}

export function disableShadowPilot(config: ShadowPilotConfig): ShadowPilotConfig {
  return { ...config, mode: "disabled" }
}

export function rollbackShadowPilot(
  _current: ShadowPilotConfig,
  knownGood: ShadowPilotConfig,
): ShadowPilotConfig {
  return { ...knownGood, mode: "disabled" }
}

/** Typed synthetic fixture; it contains no customer data. */
export const redactedPilotSample: RedactedPilotSample = {
  signals: [],
  labels: [],
  sourceFailures: [
    { source: "company_news", code: "REDACTED_FIXTURE_FAILURE", retryable: true },
  ],
}
