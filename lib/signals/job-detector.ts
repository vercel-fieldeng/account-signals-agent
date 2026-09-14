import {
  SCHEMA_VERSION,
  signalSchema,
  type Account,
  type Signal,
} from "./contracts"
import { createEvidenceId, createStableId } from "./stable-id"
import type { SignalRepository } from "./storage"

/** Normalized boundary for ATS and careers-page job records. */
export type JobPostingInput = {
  providerId?: string | null
  jobId?: string | null
  title: string
  company?: string | null
  department?: string | null
  location?: string | null
  url?: string | null
  description?: string | null
  postedAt?: string | null
}

export type JobDetectorInput = {
  account: Account
  currentJobs: readonly JobPostingInput[]
  previousJobs?: readonly JobPostingInput[]
  collectedAt: string
  receivedAt?: string
  sourceSystem?: "ats_feed" | "careers_page"
  repository?: SignalRepository
}

export type JobClassification = {
  relevant: boolean
  score: number
  rationale: string
  matchedTerms: string[]
}

export type JobDetectorResult = {
  baseline: boolean
  currentJobIds: string[]
  newJobIds: string[]
  signals: Signal[]
  rejectedNonItJobs: number
}

type TaxonomyRule = {
  label: string
  terms: readonly string[]
  weight: number
}

const itTaxonomy: readonly TaxonomyRule[] = [
  { label: "software engineering", terms: ["software", "backend", "front end", "frontend", "full stack", "fullstack", "web developer", "application engineer", "developer"], weight: 35 },
  { label: "platform and infrastructure", terms: ["platform", "infrastructure", "sre", "site reliability", "devops", "cloud", "kubernetes", "systems engineer", "network engineer"], weight: 35 },
  { label: "data and AI", terms: ["data engineer", "machine learning", "ml engineer", "artificial intelligence", " ai ", "analytics engineer", "data scientist"], weight: 30 },
  { label: "security", terms: ["security engineer", "application security", "cybersecurity", "information security", "iam", "security"], weight: 30 },
  { label: "technical leadership", terms: ["chief technology officer", " vp engineering", "engineering manager", "technical lead", "technology director"], weight: 25 },
  { label: "technical product", terms: ["solutions architect", "technical program", "technical product", "developer experience", "developer relations", "technical support"], weight: 20 },
]

const nonItTerms = [
  "recruiter", "recruiting", "human resources", "people operations", "marketing", "sales", "account executive",
  "customer success", "finance", "legal", "designer", "design", "content", "copywriter", "public relations",
]

const instructionLikeText = [
  /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?/i,
  /(?:system|developer)\s+message\s*:/i,
  /reveal\s+(?:your|the)\s+(?:prompt|instructions?)/i,
  /disregard\s+the\s+(?:safety|classification)\s+rules?/i,
]

function clean(value: string | null | undefined) {
  return (value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim()
}

function folded(value: string | null | undefined) {
  return clean(value).toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

function canonicalUrl(value: string | null | undefined) {
  const candidate = clean(value)
  if (!candidate) return ""
  try {
    const url = new URL(candidate)
    url.hash = ""
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|ref$|source$|gh_)/i.test(key)) url.searchParams.delete(key)
    }
    url.hostname = url.hostname.toLowerCase()
    url.pathname = url.pathname.replace(/\/+/g, "/").replace(/\/$/, "") || "/"
    return url.toString()
  } catch {
    return candidate.toLocaleLowerCase().replace(/[?#].*$/, "").replace(/\/$/, "")
  }
}

function providerId(job: JobPostingInput) {
  return clean(job.providerId) || clean(job.jobId)
}

/**
 * Returns the durable identity used for signal IDs. Provider IDs win. Without
 * one, title/company is durable across ATS URL changes; URL is retained as a
 * fallback when the source has no company identity.
 */
export function normalizedJobIdentity(job: JobPostingInput, account: Account) {
  const provider = providerId(job)
  if (provider) return `provider:${folded(provider)}`
  const title = folded(job.title)
  const company = folded(job.company) || folded(account.name)
  if (!title) throw new Error("Job titles must not be empty")
  if (company) return `title-company:${title}:${company}`
  const url = canonicalUrl(job.url)
  if (url) return `url:${url}`
  throw new Error("Jobs without a provider ID require a URL or company")
}

function identityAliases(job: JobPostingInput, account: Account) {
  const aliases = new Set<string>([normalizedJobIdentity(job, account)])
  const url = canonicalUrl(job.url)
  if (url) aliases.add(`url:${url}`)
  const title = folded(job.title)
  const company = folded(job.company) || folded(account.name)
  if (title && company) aliases.add(`title-company:${title}:${company}`)
  return aliases
}

function assertTimestamp(value: string, field: string) {
  if (Number.isNaN(Date.parse(value))) throw new Error(`${field} must be an ISO timestamp`)
}

function validateJobs(jobs: readonly JobPostingInput[], account: Account) {
  const identities = jobs.map((job) => normalizedJobIdentity(job, account))
  if (new Set(identities).size !== identities.length) throw new Error("Job identities must be unique")
  jobs.forEach((job) => {
    if (!clean(job.title)) throw new Error("Job titles must not be empty")
    if (job.postedAt) assertTimestamp(job.postedAt, `Job ${job.title} postedAt`)
  })
}

function jobText(job: JobPostingInput) {
  return ` ${[job.title, job.department, job.description].map(clean).join(" ").toLocaleLowerCase()} `
}

function isInstructionLike(job: JobPostingInput) {
  const text = [job.title, job.department, job.description].map(clean).join(" ")
  return instructionLikeText.some((pattern) => pattern.test(text))
}

/** Classifies only against the checked-in deterministic IT taxonomy. */
export function classifyJob(job: JobPostingInput): JobClassification {
  const text = jobText(job)
  if (isInstructionLike(job)) {
    return {
      relevant: false,
      score: 0,
      rationale: "Rejected as untrusted instruction-like job content.",
      matchedTerms: [],
    }
  }
  const matched = itTaxonomy.flatMap((rule) =>
    rule.terms.filter((term) => text.includes(` ${term.toLocaleLowerCase()} `) || text.includes(term.toLocaleLowerCase())),
  )
  const uniqueMatches = [...new Set(matched)].sort()
  const nonIt = nonItTerms.some((term) => text.includes(` ${term} `) || text.includes(term))
  const score = Math.min(100, itTaxonomy.reduce((total, rule) =>
    rule.terms.some((term) => text.includes(term.toLocaleLowerCase())) ? total + rule.weight : total, 0))
  const relevant = !nonIt && score >= 20
  const rationale = relevant
    ? `IT relevance score ${score}/100 from ${uniqueMatches.join(", ")}.`
    : nonIt
      ? `Rejected as non-IT: matched a non-technical role term.`
      : `Rejected as non-IT: no IT taxonomy terms matched (score ${score}/100).`
  return { relevant, score, rationale, matchedTerms: uniqueMatches }
}

function makeSignal(input: JobDetectorInput, job: JobPostingInput, identity: string, classification: JobClassification, repository?: SignalRepository) {
  const sourceSystem = input.sourceSystem ?? "careers_page"
  const recordId = providerId(job) || identity
  const source = {
    schemaVersion: SCHEMA_VERSION,
    system: sourceSystem,
    recordId,
    url: clean(job.url) || null,
    collectedAt: input.collectedAt,
  } as const
  const observedAt = job.postedAt ? new Date(job.postedAt).toISOString() : input.collectedAt
  const id = createStableId("signal", input.account.id, "it_hiring", sourceSystem, identity)
  const existing = repository?.getSignal(id)
  if (existing) return existing
  const evidence = {
    schemaVersion: SCHEMA_VERSION,
    id: createEvidenceId(sourceSystem, recordId, observedAt),
    kind: "job_posting" as const,
    source,
    capturedAt: input.collectedAt,
    summary: `IT job posting: ${clean(job.title)}`,
    excerpt: clean(job.description).slice(0, 500) || null,
    attributes: {
      jobIdentity: identity,
      title: clean(job.title),
      company: clean(job.company) || input.account.name,
      relevanceScore: classification.score,
      rationale: classification.rationale,
      ...(job.department ? { department: clean(job.department) } : {}),
      ...(job.location ? { location: clean(job.location) } : {}),
    },
  }
  const signal = signalSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    id,
    account: input.account,
    category: "it_hiring",
    source,
    observedAt,
    receivedAt: input.receivedAt ?? input.collectedAt,
    title: `IT hiring: ${clean(job.title)}`,
    detail: classification.rationale,
    direction: "expansion",
    severity: classification.score >= 50 ? "warning" : "info",
    evidence: [evidence],
    confidence: Number((classification.score / 100).toFixed(2)),
    metric: { name: "it_job_postings", value: 1, unit: "job", previousValue: 0 },
  })
  return repository ? repository.saveSignal(signal).value : signal
}

export function detectItHiring(input: JobDetectorInput): JobDetectorResult {
  validateJobs(input.currentJobs, input.account)
  if (input.previousJobs) validateJobs(input.previousJobs, input.account)
  assertTimestamp(input.collectedAt, "collectedAt")
  const receivedAt = input.receivedAt ?? input.collectedAt
  assertTimestamp(receivedAt, "receivedAt")
  const current = [...input.currentJobs]
  const currentJobIds = current.map((job) => normalizedJobIdentity(job, input.account))
  if (input.previousJobs === undefined) {
    return { baseline: true, currentJobIds: currentJobIds.sort(), newJobIds: [], signals: [], rejectedNonItJobs: 0 }
  }
  const previousJobs = input.previousJobs
  const newJobs = current.filter((job) => {
    const identity = normalizedJobIdentity(job, input.account)
    return !previousJobs.some((previous) => {
      const previousIdentity = normalizedJobIdentity(previous, input.account)
      // Provider IDs are useful primary identities, but ATS reposts often get a
      // new ID. Intersecting normalized aliases lets stable title/company and
      // canonical URL identities suppress those reposts without fuzzy matching.
      const currentAliases = identityAliases(job, input.account)
      const previousAliases = identityAliases(previous, input.account)
      return [...currentAliases].some((alias) => previousAliases.has(alias))
    })
  })
  const signals: Signal[] = []
  let rejectedNonItJobs = 0
  for (const job of newJobs) {
    const classification = classifyJob(job)
    if (!classification.relevant) {
      rejectedNonItJobs++
      continue
    }
    signals.push(makeSignal(input, job, normalizedJobIdentity(job, input.account), classification, input.repository))
  }
  return {
    baseline: false,
    currentJobIds: currentJobIds.sort(),
    newJobIds: newJobs.map((job) => normalizedJobIdentity(job, input.account)),
    signals,
    rejectedNonItJobs,
  }
}

export const detectJobSignals = detectItHiring
export const classifyItJob = classifyJob