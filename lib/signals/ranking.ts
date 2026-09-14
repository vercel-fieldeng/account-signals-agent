import type {
  Account,
  NormalizedSignal,
  SignalCategory,
  SignalSeverity,
} from "./contracts"

export type RankingWeights = {
  signalType: Record<SignalCategory, number>
  magnitude: number
  recency: number
  confidence: number
  corroboration: number
  recurrence: number
  materialChange: number
}

export type RankingConfig = {
  weights: RankingWeights
  recencyHalfLifeDays: number
  maxOpportunitiesPerAccount: number
}

export const DEFAULT_RANKING_CONFIG: RankingConfig = {
  weights: {
    signalType: {
      new_project: 25,
      consumption_growth: 30,
      it_hiring: 20,
      it_company_news: 15,
    },
    magnitude: 15,
    recency: 15,
    confidence: 15,
    corroboration: 10,
    recurrence: 5,
    materialChange: 5,
  },
  recencyHalfLifeDays: 30,
  maxOpportunitiesPerAccount: 5,
}

export type ScoreBreakdown = {
  signalType: number
  magnitude: number
  recency: number
  confidence: number
  corroboration: number
  recurrence: number
  materialChange: number
  total: number
}

export type RankedOpportunity = {
  id: string
  account: Account
  theme: string
  score: number
  scoreBreakdown: ScoreBreakdown
  sourceSignals: NormalizedSignal[]
  sourceSignalIds: string[]
  deduplicatedSignalIds: string[]
  recurrenceCount: number
  corroboratingSourceSystems: string[]
  materialChangeCount: number
}

export type RankedAccountOpportunities = {
  account: Account
  opportunities: RankedOpportunity[]
  omittedOpportunityCount: number
  omittedOpportunityIds: string[]
  omittedSignalCount: number
}

export type RankedSignalDigestInput = {
  generatedAt: string
  windowStartedAt: string
  windowEndedAt: string
  accounts: RankedAccountOpportunities[]
}

export type RankingOptions = {
  asOf?: string
  config?: Omit<Partial<RankingConfig>, "weights"> & {
    weights?: Omit<Partial<RankingWeights>, "signalType"> & {
      signalType?: Partial<Record<SignalCategory, number>>
    }
  }
}

type Event = {
  identity: string
  materialIdentity: string
  signals: NormalizedSignal[]
  representative: NormalizedSignal
}

const severityFactor: Record<SignalSeverity, number> = {
  info: 0.45,
  warning: 0.7,
  critical: 1,
}

const themeKeywords: readonly [string, readonly string[]][] = [
  ["ai", ["artificial intelligence", "machine learning", "generative ai", "ai platform", "ai assistant", "llm"]],
  ["cloud", ["cloud", "kubernetes", "serverless", "infrastructure"]],
  ["web-modernization", ["website", "web redesign", "frontend", "headless", "web platform"]],
  ["developer-experience", ["developer experience", "developer portal", "developer tooling", "sdk"]],
  ["ecommerce", ["e-commerce", "ecommerce", "checkout", "digital storefront"]],
  ["platform-change", ["platform migration", "vendor consolidation", "deprecating", "data center exit"]],
]

const signalCategories: readonly SignalCategory[] = [
  "new_project",
  "consumption_growth",
  "it_hiring",
  "it_company_news",
]

function clean(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim()
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`
}

function signalText(signal: NormalizedSignal) {
  return clean([
    signal.title,
    signal.detail,
    ...signal.evidence.map((evidence) => `${evidence.summary} ${evidence.excerpt ?? ""}`),
  ].join(" "))
}

export function opportunityTheme(signal: NormalizedSignal): string {
  if (signal.category === "new_project") return "platform-adoption"
  if (signal.category === "consumption_growth") return "consumption-growth"
  if (signal.category === "it_hiring") return "it-hiring"

  const text = signalText(signal)
  if (text.includes("hiring") || text.includes("engineer") || text.includes("cto")) return "it-hiring"
  return themeKeywords.find(([, keywords]) => keywords.some((keyword) => text.includes(keyword)))?.[0] ?? "company-news"
}

function evidenceIdentity(signal: NormalizedSignal) {
  const stableAttributes = ["projectId", "jobIdentity", "canonicalUrl", "url", "title"]
    .map((key) => signal.evidence.flatMap((evidence) => evidence.attributes[key] ?? []).find((value) => value !== undefined))
    .find((value) => value !== undefined)
  return String(stableAttributes ?? `${signal.source.system}:${signal.source.recordId}`)
}

function materialIdentity(signal: NormalizedSignal) {
  const evidence = signal.evidence.map((item) => {
    const attributes = Object.fromEntries(
      Object.entries(item.attributes).filter(([key]) => !["windowStart", "windowEnd", "creationTime"].includes(key)),
    )
    return { kind: item.kind, summary: item.summary, attributes }
  })
  return stableJson({
    category: signal.category,
    title: signal.title,
    metric: signal.metric,
    evidence,
  })
}

function makeEvents(signals: NormalizedSignal[]): Event[] {
  const byMaterial = new Map<string, Event>()
  for (const signal of signals) {
    const theme = opportunityTheme(signal)
    const identity = `${signal.account.id}|${theme}|${signal.category}|${evidenceIdentity(signal)}`
    const material = `${identity}|${materialIdentity(signal)}`
    const existing = byMaterial.get(material)
    if (existing) {
      existing.signals.push(signal)
      if (Date.parse(signal.observedAt) > Date.parse(existing.representative.observedAt)) existing.representative = signal
    } else {
      byMaterial.set(material, { identity, materialIdentity: material, signals: [signal], representative: signal })
    }
  }
  return [...byMaterial.values()]
}

function mergeConfig(options?: RankingOptions): RankingConfig {
  const requested = options?.config
  const weights = requested?.weights
  const merged = {
    ...DEFAULT_RANKING_CONFIG,
    ...requested,
    weights: {
      ...DEFAULT_RANKING_CONFIG.weights,
      ...weights,
      signalType: { ...DEFAULT_RANKING_CONFIG.weights.signalType, ...weights?.signalType },
    },
  }

  const invalidSignalTypes = Object.keys(merged.weights.signalType).filter(
    (category) => !signalCategories.includes(category as SignalCategory),
  )
  const numericValues = [
    ...Object.values(merged.weights.signalType),
    merged.weights.magnitude,
    merged.weights.recency,
    merged.weights.confidence,
    merged.weights.corroboration,
    merged.weights.recurrence,
    merged.weights.materialChange,
    merged.recencyHalfLifeDays,
    merged.maxOpportunitiesPerAccount,
  ]
  if (
    invalidSignalTypes.length > 0 ||
    numericValues.some((value) => !Number.isFinite(value) || value < 0) ||
    merged.recencyHalfLifeDays === 0 ||
    !Number.isInteger(merged.maxOpportunitiesPerAccount)
  ) {
    throw new Error("Invalid ranking configuration or signal type")
  }

  return merged
}

function magnitude(signal: NormalizedSignal) {
  if (signal.metric) {
    if (signal.metric.previousValue !== null && signal.metric.previousValue !== 0) {
      return Math.min(1, Math.abs(signal.metric.value - signal.metric.previousValue) / Math.abs(signal.metric.previousValue))
    }
    return Math.min(1, Math.abs(signal.metric.value) / 10)
  }
  return severityFactor[signal.severity]
}

function recency(signal: NormalizedSignal, asOf: number, halfLifeDays: number) {
  const age = Math.max(0, asOf - Date.parse(signal.observedAt)) / 86_400_000
  return Math.pow(0.5, age / halfLifeDays)
}

function scoreEventGroup(events: Event[], config: RankingConfig, asOf: number): ScoreBreakdown {
  const representatives = events.map((event) => event.representative)
  const latest = representatives.reduce((left, right) => Date.parse(left.observedAt) >= Date.parse(right.observedAt) ? left : right)
  const sourceSystems = new Set(representatives.map((signal) => signal.source.system))
  const recurrenceCount = events.reduce((total, event) => total + event.signals.length, 0)
  const weights = config.weights
  const components = {
    signalType: weights.signalType[latest.category],
    magnitude: weights.magnitude * Math.max(...representatives.map(magnitude)),
    recency: weights.recency * recency(latest, asOf, config.recencyHalfLifeDays),
    confidence: weights.confidence * (representatives.reduce((sum, signal) => sum + signal.confidence, 0) / representatives.length),
    corroboration: weights.corroboration * Math.min(1, sourceSystems.size / 2),
    recurrence: weights.recurrence * Math.min(1, Math.max(0, recurrenceCount - 1) / 2),
    materialChange: weights.materialChange * Math.min(1, Math.max(0, events.length - 1) / 2),
  }
  return { ...components, total: Number(Object.values(components).reduce((sum, value) => sum + value, 0).toFixed(4)) }
}

function compareOpportunities(left: RankedOpportunity, right: RankedOpportunity) {
  return right.score - left.score || right.sourceSignals.length - left.sourceSignals.length || left.theme.localeCompare(right.theme) || left.id.localeCompare(right.id)
}

export function rankSignals(signals: readonly NormalizedSignal[], options: RankingOptions = {}): RankedAccountOpportunities[] {
  const config = mergeConfig(options)
  if (signals.some((signal) => !signalCategories.includes(signal.category))) {
    throw new Error("Invalid signal type")
  }
  const asOf = Date.parse(options.asOf ?? signals.reduce((latest, signal) => Date.parse(signal.observedAt) > Date.parse(latest) ? signal.observedAt : latest, signals[0]?.observedAt ?? new Date(0).toISOString()))
  if (!Number.isFinite(asOf) || config.recencyHalfLifeDays <= 0 || !Number.isInteger(config.maxOpportunitiesPerAccount) || config.maxOpportunitiesPerAccount < 0) {
    throw new Error("Invalid ranking configuration or timestamp")
  }

  const byAccount = new Map<string, NormalizedSignal[]>()
  for (const signal of signals) byAccount.set(signal.account.id, [...(byAccount.get(signal.account.id) ?? []), signal])
  return [...byAccount.values()].map((accountSignals) => {
    const events = makeEvents(accountSignals)
    const byTheme = new Map<string, Event[]>()
    for (const event of events) {
      const theme = opportunityTheme(event.representative)
      byTheme.set(theme, [...(byTheme.get(theme) ?? []), event])
    }
    const account = accountSignals[0].account
    const opportunities = [...byTheme.entries()].map(([theme, themeEvents]) => {
      const sourceSignals = themeEvents.map((event) => event.representative).sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt) || left.id.localeCompare(right.id))
      const allSignals = themeEvents.flatMap((event) => event.signals)
      const scoreBreakdown = scoreEventGroup(themeEvents, config, asOf)
      return {
        id: `opportunity:${account.id}:${theme}`,
        account,
        theme,
        score: scoreBreakdown.total,
        scoreBreakdown,
        sourceSignals,
        sourceSignalIds: sourceSignals.map((signal) => signal.id),
        deduplicatedSignalIds: allSignals.map((signal) => signal.id).sort(),
        recurrenceCount: allSignals.length,
        corroboratingSourceSystems: [...new Set(sourceSignals.map((signal) => signal.source.system))].sort(),
        materialChangeCount: themeEvents.length,
      }
    }).sort(compareOpportunities)
    const retained = opportunities.slice(0, config.maxOpportunitiesPerAccount)
    const omitted = opportunities.slice(config.maxOpportunitiesPerAccount)
    return {
      account,
      opportunities: retained,
      omittedOpportunityCount: omitted.length,
      omittedOpportunityIds: omitted.map((opportunity) => opportunity.id),
      omittedSignalCount: omitted.reduce((count, opportunity) => count + opportunity.deduplicatedSignalIds.length, 0),
    }
  }).sort((left, right) => right.opportunities[0]?.score - (left.opportunities[0]?.score ?? 0) || left.account.id.localeCompare(right.account.id))
}

export function createRankedSignalDigestInput(
  signals: readonly NormalizedSignal[],
  windowStartedAt: string,
  windowEndedAt: string,
  generatedAt = windowEndedAt,
  options: RankingOptions = {},
): RankedSignalDigestInput {
  return { generatedAt, windowStartedAt, windowEndedAt, accounts: rankSignals(signals, { ...options, asOf: options.asOf ?? windowEndedAt }) }
}
