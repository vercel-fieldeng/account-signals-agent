import { SCHEMA_VERSION, type Observation, type Snapshot, type SourceSystem } from "./contracts"
import { createEvidenceId, createObservationId, createSnapshotId, createStableId } from "./stable-id"

export type CareerJob = {
  jobId: string
  title: string
  department: string | null
  location: string | null
  url: string
  postedAt: string | null
  observedAt: string
}

export type CareersAccount = {
  accountId: string
  careersUrl: string
  sourceSystem?: "ats_feed" | "careers_page"
}

export type CareersHttpRequest = {
  url: string
  headers: Record<string, string>
  signal: AbortSignal
}

export type CareersHttpResponse = {
  status: number
  headers?: Record<string, string>
  body?: string
  /** Final URL and redirect chain supplied by the injected client. */
  url?: string
  redirectChain?: readonly string[]
}

export type CareersHttpClient = (request: CareersHttpRequest) => Promise<CareersHttpResponse>

export type CareersCacheEntry = {
  etag?: string
  lastModified?: string
  records: CareerJob[]
}

export type CareersSourceOptions = {
  client: CareersHttpClient
  accounts: readonly CareersAccount[]
  window: { startedAt: string; endedAt: string }
  receivedAt?: string
  now?: () => string
  timeoutMs?: number
  retries?: number
  concurrency?: number
  retryDelayMs?: number
  sleep?: (milliseconds: number) => Promise<void>
  cache?: Map<string, CareersCacheEntry>
  userAgent?: string
  maxResponseBytes?: number
  minRequestIntervalMs?: number
  checkRobots?: (url: string) => Promise<boolean> | boolean
  checkTerms?: (url: string) => Promise<boolean> | boolean
}

export type CareerChange =
  | { kind: "added"; job: CareerJob }
  | { kind: "removed"; job: CareerJob }
  | { kind: "changed"; previous: CareerJob; job: CareerJob }
  | { kind: "unchanged"; job: CareerJob }

export type CareersAccountResult = {
  accountId: string
  status: "succeeded" | "partial" | "unsupported"
  sourceSystem: SourceSystem
  records: CareerJob[]
  changes: CareerChange[]
  snapshot: Snapshot | null
  error?: { code: string; message: string; retryable: boolean; retryAfterMs?: number }
}

export type CareersSourceResult = {
  accounts: CareersAccountResult[]
  snapshots: Snapshot[]
  errors: Array<{
    accountId: string
    code: string
    message: string
    retryable: boolean
    retryAfterMs?: number
  }>
}

type ParsedCareers = {
  records: CareerJob[]
  sourceSystem: "ats_feed" | "careers_page"
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_RETRIES = 1
const DEFAULT_CONCURRENCY = 4
const DEFAULT_RETRY_DELAY_MS = 250

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function absoluteUrl(value: unknown, baseUrl: string): string | null {
  const candidate = text(value)
  if (!candidate) return null
  try {
    return new URL(candidate, baseUrl).toString()
  } catch {
    return null
  }
}

function isoDate(value: unknown): string | null {
  const candidate = text(value)
  if (!candidate || Number.isNaN(Date.parse(candidate))) return null
  return new Date(candidate).toISOString()
}

function field(object: Record<string, unknown>, ...names: string[]) {
  for (const name of names) {
    if (object[name] !== undefined) return object[name]
  }
  return undefined
}

function listFromJson(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== "object") return []
  const object = value as Record<string, unknown>
  for (const key of ["jobs", "jobPostings", "postings", "data", "results", "items"]) {
    if (Array.isArray(object[key])) return object[key]
  }
  const graph = object["@graph"]
  return Array.isArray(graph) ? graph : []
}

function departmentOf(value: unknown): string | null {
  if (typeof value === "string") return text(value)
  if (Array.isArray(value)) return value.map(departmentOf).filter(Boolean).join(", ") || null
  if (value && typeof value === "object") return text((value as Record<string, unknown>).name)
  return null
}

function normalizeJob(value: unknown, baseUrl: string, observedAt: string): CareerJob | null {
  if (!value || typeof value !== "object") return null
  const item = value as Record<string, unknown>
  const url = absoluteUrl(field(item, "url", "absolute_url", "hostedUrl", "applyUrl", "link"), baseUrl)
  const title = text(field(item, "title", "text", "name", "position"))
  const jobId = text(field(item, "id", "jobId", "requisitionId", "reqId")) ?? url
  if (!jobId || !title || !url) return null

  const categories = item.categories && typeof item.categories === "object"
    ? item.categories as Record<string, unknown>
    : {}
  const location = text(field(item, "location", "locations", "locationName"))
    ?? text(field(categories, "location", "locations"))
  const department = departmentOf(field(item, "department", "team", "function"))
    ?? departmentOf(field(categories, "department", "team", "function"))

  return {
    jobId,
    title,
    department,
    location,
    url,
    postedAt: isoDate(field(item, "postedAt", "posted_at", "createdAt", "created_at", "updatedAt", "updated_at", "datePosted")),
    observedAt: isoDate(field(item, "observedAt")) ?? observedAt,
  }
}

function parseJson(body: string, baseUrl: string, observedAt: string): CareerJob[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error("Malformed JSON careers payload")
  }
  const records = listFromJson(parsed).map((item) => normalizeJob(item, baseUrl, observedAt)).filter((item): item is CareerJob => item !== null)
  if (records.length === 0) throw new Error("JSON careers payload contained no valid job postings")
  return records
}

function htmlText(value: string) {
  return value.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim()
}

function parseHtml(body: string, baseUrl: string, observedAt: string): CareerJob[] {
  const records: CareerJob[] = []
  const jsonLdPattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  for (const match of body.matchAll(jsonLdPattern)) {
    try {
      const value = JSON.parse(match[1]) as unknown
      for (const item of Array.isArray(value) ? value : [value]) {
        const candidates = item && typeof item === "object" && Array.isArray((item as Record<string, unknown>)["@graph"])
          ? (item as Record<string, unknown>)["@graph"] as unknown[]
          : [item]
        for (const candidate of candidates) {
          if (candidate && typeof candidate === "object" && (candidate as Record<string, unknown>)["@type"] === "JobPosting") {
            const job = normalizeJob(candidate, baseUrl, observedAt)
            if (job) records.push(job)
          }
        }
      }
    } catch {
      // An unrelated JSON-LD block must not make valid job links unusable.
    }
  }

  const linkPattern = /<a\b([^>]*?)href=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi
  for (const match of body.matchAll(linkPattern)) {
    const attributes = `${match[1]} ${match[3]}`
    const idMatch = attributes.match(/(?:data-job-id|data-id|id)=["']([^"']+)["']/i)
    const url = absoluteUrl(match[2], baseUrl)
    const title = htmlText(match[4])
    if (!url || !title || !idMatch || title.length < 2) continue
    records.push({ jobId: idMatch[1], title, department: null, location: null, url, postedAt: null, observedAt })
  }

  const unique = new Map(records.map((record) => [record.jobId, record]))
  if (unique.size === 0) throw new Error("Careers page contained no attributable job postings")
  return [...unique.values()]
}

/** Parse only public JSON/ATS payloads or attributable first-party careers HTML. */
export function parseCareersResponse(input: {
  body: string
  contentType?: string
  url: string
  observedAt?: string
  sourceSystem?: "ats_feed" | "careers_page"
}): ParsedCareers {
  const observedAt = input.observedAt ?? new Date().toISOString()
  const isJson = input.contentType?.toLowerCase().includes("json") || /^\s*[\[{]/.test(input.body)
  const sourceSystem = input.sourceSystem ?? (isJson ? "ats_feed" : "careers_page")
  return {
    records: isJson ? parseJson(input.body, input.url, observedAt) : parseHtml(input.body, input.url, observedAt),
    sourceSystem,
  }
}

function materiallyEqual(left: CareerJob, right: CareerJob) {
  return ["jobId", "title", "department", "location", "url", "postedAt"].every((key) => left[key as keyof CareerJob] === right[key as keyof CareerJob])
}

function changes(previous: CareerJob[], current: CareerJob[]): CareerChange[] {
  const before = new Map(previous.map((job) => [job.jobId, job]))
  const after = new Map(current.map((job) => [job.jobId, job]))
  const result: CareerChange[] = []
  for (const job of current) {
    const prior = before.get(job.jobId)
    result.push(prior ? (materiallyEqual(prior, job) ? { kind: "unchanged", job } : { kind: "changed", previous: prior, job }) : { kind: "added", job })
  }
  for (const job of previous) if (!after.has(job.jobId)) result.push({ kind: "removed", job })
  return result
}

function retryAfterMs(headers: Record<string, string> | undefined, now = Date.now()): number | undefined {
  const value = headers?.["retry-after"] ?? headers?.["Retry-After"]
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined
}

function validateCareersUrl(value: string, field: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new Error(`${field} must be an absolute URL`) }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error(`${field} must be an HTTPS URL without credentials`)
  return url
}

function validateRedirects(response: CareersHttpResponse, original: URL) {
  const urls = [ ...(response.redirectChain ?? []), ...(response.url ? [response.url] : []) ]
  for (const value of urls) {
    const redirect = validateCareersUrl(value, "careers redirect")
    if (redirect.hostname.toLowerCase() !== original.hostname.toLowerCase()) throw new Error("Careers source redirect left the first-party host")
  }
}

async function requestWithPolicy(options: CareersSourceOptions, account: CareersAccount, cache?: CareersCacheEntry) {
  const originalUrl = validateCareersUrl(account.careersUrl, "careersUrl")
  if (options.maxResponseBytes !== undefined && (!Number.isInteger(options.maxResponseBytes) || options.maxResponseBytes < 1)) throw new Error("maxResponseBytes must be a positive integer")
  if (options.minRequestIntervalMs !== undefined && (!Number.isFinite(options.minRequestIntervalMs) || options.minRequestIntervalMs < 0)) throw new Error("minRequestIntervalMs must be non-negative")
  if (options.checkRobots && !(await options.checkRobots(account.careersUrl))) throw new Error("Careers source is disallowed by robots policy")
  if (options.checkTerms && !(await options.checkTerms(account.careersUrl))) throw new Error("Careers source is disallowed by terms policy")
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retries = options.retries ?? DEFAULT_RETRIES
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  let lastError: unknown
  let nextRequestAt = 0
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const wait = Math.max(0, nextRequestAt - Date.now())
    if (wait > 0) await sleep(wait)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    const headers: Record<string, string> = { Accept: "application/json, text/html", "User-Agent": options.userAgent ?? "account-signals-careers/1.0" }
    if (cache?.etag) headers["If-None-Match"] = cache.etag
    if (cache?.lastModified) headers["If-Modified-Since"] = cache.lastModified
    try {
      const response = await options.client({ url: account.careersUrl, headers, signal: controller.signal })
      validateRedirects(response, originalUrl)
      if (options.maxResponseBytes !== undefined && response.body !== undefined && new TextEncoder().encode(response.body).byteLength > options.maxResponseBytes) {
        throw Object.assign(new Error(`Careers response exceeded ${options.maxResponseBytes} bytes`), { retryable: false })
      }
      nextRequestAt = Date.now() + (options.minRequestIntervalMs ?? 0)
      if (response.status === 304) return { response, cache }
      if (response.status >= 200 && response.status < 300) return { response }
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500
      const retryAfter = retryAfterMs(response.headers)
      if (!retryable || attempt === retries) throw Object.assign(new Error(`Careers source returned HTTP ${response.status}`), { retryable, ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }) })
      lastError = Object.assign(new Error(`Careers source returned HTTP ${response.status}`), { retryable, ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }) })
    } catch (error) {
      lastError = error
      const retryable = (error as { retryable?: boolean }).retryable !== false
      if (!retryable || attempt === retries) throw error
    } finally {
      clearTimeout(timeout)
    }
    const retryAfter = (lastError as { retryAfterMs?: number } | undefined)?.retryAfterMs
    await sleep(Math.max(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS * 2 ** attempt, retryAfter ?? 0))
  }
  throw lastError ?? new Error("Careers request failed")
}

function accountSnapshot(account: CareersAccount, sourceSystem: "ats_feed" | "careers_page", records: CareerJob[], changeset: CareerChange[], capturedAt: string, receivedAt: string, window: CareersSourceOptions["window"]): Snapshot {
  const source = { schemaVersion: SCHEMA_VERSION, system: sourceSystem, recordId: createStableId("careers", account.accountId, account.careersUrl), url: account.careersUrl, collectedAt: capturedAt }
  const observations: Observation[] = changeset.filter((change) => change.kind === "added" || change.kind === "changed").map((change) => {
    const job = change.kind === "changed" ? change.job : change.job
    const recordId = job.jobId
    const observedAt = job.postedAt ?? job.observedAt
    const evidenceSource = { ...source, recordId, url: job.url }
    return {
      schemaVersion: SCHEMA_VERSION,
      id: createObservationId(account.accountId, sourceSystem, recordId, observedAt),
      accountId: account.accountId,
      category: "it_hiring" as const,
      source: evidenceSource,
      observedAt,
      receivedAt,
      evidence: [{
        schemaVersion: SCHEMA_VERSION,
        id: createEvidenceId(sourceSystem, recordId, observedAt),
        kind: "job_posting" as const,
        source: evidenceSource,
        capturedAt,
        summary: `${job.title}${job.location ? ` — ${job.location}` : ""}`,
        excerpt: null,
        attributes: { jobId: job.jobId, title: job.title, department: job.department, location: job.location, url: job.url, postedAt: job.postedAt },
      }],
    }
  })
  return { schemaVersion: SCHEMA_VERSION, id: createSnapshotId(account.accountId, sourceSystem, window.startedAt, window.endedAt), accountId: account.accountId, source, windowStartedAt: window.startedAt, windowEndedAt: window.endedAt, capturedAt, observations, nextCursor: null }
}

/** Collects accounts independently; one malformed or unsupported account cannot erase another account's records. */
export async function collectCareers(options: CareersSourceOptions): Promise<CareersSourceResult> {
  const now = options.now ?? (() => new Date().toISOString())
  const receivedAt = options.receivedAt ?? now()
  const cache = options.cache ?? new Map<string, CareersCacheEntry>()
  const limit = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY)
  const results: CareersAccountResult[] = []
  let next = 0
  const worker = async () => {
    while (next < options.accounts.length) {
      const account = options.accounts[next++]
      const prior = cache.get(account.careersUrl)
      try {
        const { response, cache: unchangedCache } = await requestWithPolicy(options, account, prior)
        const system = account.sourceSystem ?? (response.status === 304 ? "ats_feed" : undefined)
        const capturedAt = now()
        if (response.status === 304 && unchangedCache) {
          const changeset = unchangedCache.records.map((job) => ({ kind: "unchanged", job }) as CareerChange)
          const snapshot = accountSnapshot(account, system ?? "ats_feed", unchangedCache.records, changeset, capturedAt, receivedAt, options.window)
          results.push({ accountId: account.accountId, status: "succeeded", sourceSystem: system ?? "ats_feed", records: unchangedCache.records, changes: changeset, snapshot })
          continue
        }
        const parsed = parseCareersResponse({ body: response.body ?? "", contentType: response.headers?.["content-type"] ?? response.headers?.["Content-Type"], url: account.careersUrl, observedAt: capturedAt, sourceSystem: account.sourceSystem })
        const changeset = changes(prior?.records ?? [], parsed.records)
        cache.set(account.careersUrl, { etag: response.headers?.etag ?? response.headers?.ETag, lastModified: response.headers?.["last-modified"] ?? response.headers?.["Last-Modified"], records: parsed.records })
        const snapshot = accountSnapshot(account, parsed.sourceSystem, parsed.records, changeset, capturedAt, receivedAt, options.window)
        results.push({ accountId: account.accountId, status: "succeeded", sourceSystem: parsed.sourceSystem, records: parsed.records, changes: changeset, snapshot })
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown careers source failure"
        const malformed = message.includes("Malformed") || message.includes("no valid") || message.includes("no attributable")
        const policyBlocked = message.includes("HTTP 401") || message.includes("HTTP 403") || message.includes("must be an HTTPS URL") || message.includes("robots policy") || message.includes("terms policy") || message.includes("redirect left") || message.includes("response exceeded")
        const retryable = policyBlocked || malformed ? false : (error as { retryable?: boolean }).retryable ?? true
        const code = malformed ? "malformed" : policyBlocked ? "unsupported" : "source_unavailable"
        const retryAfterMs = (error as { retryAfterMs?: number }).retryAfterMs
        results.push({ accountId: account.accountId, status: malformed || policyBlocked ? "unsupported" : "partial", sourceSystem: account.sourceSystem ?? "careers_page", records: prior?.records ?? [], changes: [], snapshot: null, error: { code, message, retryable, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) } })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, options.accounts.length) }, worker))
  results.sort((left, right) => options.accounts.findIndex((account) => account.accountId === left.accountId) - options.accounts.findIndex((account) => account.accountId === right.accountId))
  return { accounts: results, snapshots: results.flatMap((result) => result.snapshot ? [result.snapshot] : []), errors: results.flatMap((result) => result.error ? [{ accountId: result.accountId, ...result.error }] : []) }
}
