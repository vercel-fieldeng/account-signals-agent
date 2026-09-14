import {
  SCHEMA_VERSION,
  normalizedSignalSchema,
  observationSchema,
  type Account,
  type Observation,
  type Signal,
  type SourceReference,
} from "./contracts"
import { createEvidenceId, createObservationId, createSignalId } from "./stable-id"
import type { SignalRepository } from "./storage"

export const NEWS_CATEGORIES = [
  "web_modernization",
  "ai",
  "cloud",
  "developer_experience",
  "ecommerce",
  "digital_launch",
  "hiring",
  "platform_change",
] as const

export type NewsCategory = (typeof NEWS_CATEGORIES)[number]

export type CompanyNewsInput = {
  account: Account
  source: SourceReference
  observedAt: string
  receivedAt: string
  title: string
  text: string
  /** Source content kind; article is retained as the compatible default. */
  kind?: "article" | "post"
}

export type NewsClassification = {
  category: NewsCategory
  confidence: number
  rationale: string
  evidenceExcerpt: string
}

export type NewsDetectionResult = {
  signals: Signal[]
  observations: Observation[]
  skippedExisting: number
  suppressed: number
}

type TaxonomyEntry = {
  category: NewsCategory
  label: string
  keywords: readonly string[]
  direction: Signal["direction"]
  severity: Signal["severity"]
}

const taxonomy: readonly TaxonomyEntry[] = [
  {
    category: "web_modernization",
    label: "web modernization",
    keywords: ["website redesign", "web redesign", "modernize our website", "headless", "frontend rebuild", "web platform"],
    direction: "expansion",
    severity: "warning",
  },
  {
    category: "ai",
    label: "AI",
    keywords: ["artificial intelligence", "machine learning", "generative ai", "ai platform", "ai assistant", "llm"],
    direction: "expansion",
    severity: "warning",
  },
  {
    category: "cloud",
    label: "cloud",
    keywords: ["cloud migration", "cloud infrastructure", "cloud platform", "multi-cloud", "kubernetes", "serverless"],
    direction: "expansion",
    severity: "warning",
  },
  {
    category: "developer_experience",
    label: "developer experience",
    keywords: ["developer experience", "developer portal", "developer tooling", "internal developer platform", "software development kit", "sdk"],
    direction: "expansion",
    severity: "warning",
  },
  {
    category: "ecommerce",
    label: "ecommerce",
    keywords: ["e-commerce", "ecommerce", "online store", "checkout", "commerce platform", "digital storefront"],
    direction: "expansion",
    severity: "warning",
  },
  {
    category: "digital_launch",
    label: "digital launch",
    keywords: ["launches a digital", "digital product launch", "new mobile app", "new online service", "digital experience launch", "goes live online"],
    direction: "expansion",
    severity: "warning",
  },
  {
    category: "hiring",
    label: "IT hiring",
    keywords: ["hiring engineers", "engineering team", "technology hires", "software engineers", "platform engineers", "chief technology officer", "cto"],
    direction: "expansion",
    severity: "info",
  },
  {
    category: "platform_change",
    label: "platform change",
    keywords: ["infrastructure consolidation", "platform migration", "technology consolidation", "replace our platform", "deprecating", "data center exit", "vendor consolidation"],
    direction: "risk",
    severity: "warning",
  },
]

const instructionLikeText = [
  /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?/i,
  /(?:system|developer)\s+message\s*:/i,
  /reveal\s+(?:your|the)\s+(?:prompt|instructions?)/i,
  /disregard\s+the\s+(?:safety|classification)\s+rules?/i,
]

function cleanText(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim()
}

function inertText(input: CompanyNewsInput) {
  return cleanText(`${input.title}. ${input.text}`)
}

function isInstructionLike(text: string) {
  return instructionLikeText.some((pattern) => pattern.test(text))
}

function isFirstPartySource(input: CompanyNewsInput) {
  if (input.source.system !== "company_news" || !input.source.url) return false
  try {
    const hostname = new URL(input.source.url).hostname.toLowerCase().replace(/^www\./, "")
    return input.account.domains.some((domain) => {
      const normalized = domain.toLowerCase().replace(/^www\./, "").replace(/\.$/, "")
      return hostname === normalized || hostname.endsWith(`.${normalized}`)
    })
  } catch {
    return false
  }
}

function isPersistableNews(input: CompanyNewsInput) {
  return isFirstPartySource(input) && !isInstructionLike(inertText(input))
}

function excerptFor(text: string, keyword: string) {
  const lower = text.toLocaleLowerCase()
  const index = lower.indexOf(keyword.toLocaleLowerCase())
  if (index < 0) return text.slice(0, 280)
  const start = Math.max(0, index - 100)
  return text.slice(start, Math.min(text.length, start + 300)).trim()
}

/**
 * Classifies only by the checked-in taxonomy. News text is data: it is never
 * interpolated into code, evaluated, or treated as an instruction.
 */
export function classifyCompanyNews(input: Pick<CompanyNewsInput, "title" | "text">): NewsClassification | null {
  const text = inertText(input as CompanyNewsInput)
  if (!text || isInstructionLike(text)) return null

  const candidates = taxonomy
    .map((entry) => ({
      entry,
      matches: entry.keywords.filter((keyword) => text.toLocaleLowerCase().includes(keyword)),
    }))
    .filter((candidate) => candidate.matches.length > 0)
    .sort((left, right) => right.matches.length - left.matches.length || left.entry.category.localeCompare(right.entry.category))

  const winner = candidates[0]
  if (!winner) return null

  const confidence = Math.min(0.99, 0.45 + winner.matches.length * 0.16 + (winner.matches.length > (candidates[1]?.matches.length ?? 0) ? 0.08 : 0))
  if (confidence < 0.7) return null

  const matched = winner.matches.join(", ")
  return {
    category: winner.entry.category,
    confidence: Number(confidence.toFixed(2)),
    rationale: `Deterministic taxonomy match for ${winner.entry.label}: ${matched}.`,
    evidenceExcerpt: excerptFor(text, winner.matches[0]),
  }
}

function makeObservation(input: CompanyNewsInput): Observation {
  const excerpt = cleanText(input.text).slice(0, 500) || cleanText(input.title)
  const evidence = {
    schemaVersion: SCHEMA_VERSION,
    id: createEvidenceId(input.source.system, input.source.recordId, input.source.collectedAt),
    kind: input.kind === "post" ? ("company_post" as const) : ("company_article" as const),
    source: input.source,
    capturedAt: input.source.collectedAt,
    summary: `Company news ${input.kind === "post" ? "post" : "article"}: ${cleanText(input.title)}`,
    excerpt,
    attributes: { title: cleanText(input.title), fetchedTextIsData: true },
  }
  return observationSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    id: createObservationId(input.account.id, input.source.system, input.source.recordId, input.observedAt),
    accountId: input.account.id,
    category: "it_company_news",
    source: input.source,
    observedAt: input.observedAt,
    receivedAt: input.receivedAt,
    evidence: [evidence],
  })
}

function makeSignal(input: CompanyNewsInput, observation: Observation, classification: NewsClassification): Signal {
  const entry = taxonomy.find((candidate) => candidate.category === classification.category) as TaxonomyEntry
  const evidence = observation.evidence.map((item) => ({ ...item, excerpt: classification.evidenceExcerpt }))
  return normalizedSignalSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    id: createSignalId(input.account.id, "it_company_news", input.source.system, input.source.recordId, input.observedAt),
    account: input.account,
    category: "it_company_news",
    source: input.source,
    observedAt: input.observedAt,
    receivedAt: input.receivedAt,
    title: `${entry.label}: ${cleanText(input.title)}`,
    detail: `${classification.rationale} Evidence: ${classification.evidenceExcerpt}`,
    direction: entry.direction,
    severity: entry.severity,
    evidence,
    confidence: classification.confidence,
    metric: null,
  })
}

/** Detects new company-news observations and persists only validated signals. */
export function detectCompanyNews(
  repository: SignalRepository,
  inputs: readonly CompanyNewsInput[],
): NewsDetectionResult {
  const result: NewsDetectionResult = { signals: [], observations: [], skippedExisting: 0, suppressed: 0 }
  for (const input of inputs) {
    // Validate provenance and quarantine prompt-like content before constructing
    // or persisting any observation/evidence excerpt.
    if (!isPersistableNews(input)) {
      result.suppressed += 1
      continue
    }
    const observation = makeObservation(input)
    if (repository.getObservation(observation.id)) {
      result.skippedExisting += 1
      continue
    }
    repository.saveObservation(observation)
    result.observations.push(observation)
    const classification = classifyCompanyNews(input)
    if (!classification) {
      result.suppressed += 1
      continue
    }
    const signal = makeSignal(input, observation, classification)
    const saved = repository.saveSignal(signal)
    if (saved.inserted) result.signals.push(saved.value)
  }
  return result
}

export const classifyItCompanyNews = classifyCompanyNews
export const detectItCompanyNews = detectCompanyNews
