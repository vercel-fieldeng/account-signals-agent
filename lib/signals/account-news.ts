import { createHash } from "node:crypto"
import { z } from "zod"

/**
 * Account news monitor: a quiet daily change detector across the whole account
 * watchlist. One bounded Exa news search per account covers the trailing
 * lookback; cheap deterministic checks drop namesakes, listings, homepages, and
 * syndicated copies; an LLM judge then keeps only events that are materially
 * good (opportunity) or bad (risk) for Vercel business. Neutral is the default.
 *
 * Novelty is "not yet reported", not a strict publication date: judged items
 * are remembered in private state so they are judged once, and material events
 * stay pending until the brief's delivery ledger records them. Delivery is
 * therefore at-least-once, like the d0 signals.
 */

export const EXA_SEARCH_ENDPOINT = "https://api.exa.ai/search"
export const NEWS_LOOKBACK_DAYS = 7
export const NEWS_RESULTS_PER_ACCOUNT = 10
export const NEWS_MAX_ACCOUNTS = 150
export const NEWS_MAX_EVENTS = 6
export const NEWS_JUDGE_BATCH = 10
/** Judged items are remembered beyond the lookback so a later syndicated copy is not judged or reported again. */
export const NEWS_STATE_RETENTION_DAYS = 21
const DAY = 86_400_000
const EXCERPT_CHARS = 1500
const MAX_RESPONSE_BYTES = 2_000_000
const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_CONCURRENCY = 8
const LEAD_CHARS = 700

// ---------------------------------------------------------------------------
// Watchlist
// ---------------------------------------------------------------------------

const domainPattern = /^(?=.{3,253}$)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u

export const watchlistAccountSchema = z.object({
  /** Salesforce account name, shown in the brief. */
  name: z.string().trim().min(1).max(160),
  /** Clean brand name used in the search query and for attribution. */
  searchName: z.string().trim().min(2).max(80),
  /** Other names that attribute an item to the account (brands, subsidiaries). */
  aliases: z.array(z.string().trim().min(2).max(80)).max(10).default([]),
  /** Disambiguating words added to the query, e.g. "fitness McFIT" for RSG Group. */
  context: z.string().trim().max(80).optional(),
  domain: z.string().trim().toLowerCase().regex(domainPattern).nullable().optional(),
  salesforceAccountId: z.string().regex(/^[a-zA-Z0-9]{18}$/u).optional(),
  type: z.string().trim().max(40).optional(),
  tier: z.string().trim().max(40).optional(),
  /** Publishers (media accounts) write about other companies; their own articles are never about themselves. */
  excludeOwnDomain: z.boolean().default(false),
}).strict()

export const newsWatchlistSchema = z.object({
  schemaVersion: z.literal(1),
  accounts: z.array(watchlistAccountSchema).min(1).max(NEWS_MAX_ACCOUNTS),
}).strict().superRefine((value, context) => {
  const names = value.accounts.map((account) => account.name.toLowerCase())
  if (new Set(names).size !== names.length) context.addIssue({ code: "custom", path: ["accounts"], message: "account names must be unique" })
})

export type WatchlistAccount = z.infer<typeof watchlistAccountSchema>
export type NewsWatchlist = z.infer<typeof newsWatchlistSchema>

// ---------------------------------------------------------------------------
// Judged-item state
// ---------------------------------------------------------------------------

export type NewsDirection = "opportunity" | "risk"
export type NewsConfidence = "high" | "medium"

export type NewsEventCore = {
  direction: NewsDirection
  confidence: NewsConfidence
  whatHappened: string
  whyVercel: string
  nextStep: string
}

export type NewsStateItem = {
  account: string
  title: string
  url: string
  publisher: string
  publishedAt: string | null
  firstSeenAt: string
  verdict: "material" | "neutral"
  event?: NewsEventCore
}

export type NewsMonitorState = { schemaVersion: 1; items: Record<string, NewsStateItem> }

export function emptyNewsState(): NewsMonitorState {
  return { schemaVersion: 1, items: {} }
}

export function isNewsMonitorState(value: unknown): value is NewsMonitorState {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Record<string, unknown>
  if (candidate.schemaVersion !== 1 || typeof candidate.items !== "object" || candidate.items === null || Array.isArray(candidate.items)) return false
  return Object.entries(candidate.items as Record<string, unknown>).every(([id, item]) => {
    if (!/^news:[a-f0-9]{16}$/u.test(id) || typeof item !== "object" || item === null) return false
    const entry = item as Record<string, unknown>
    return typeof entry.account === "string" && typeof entry.title === "string" && typeof entry.url === "string" &&
      typeof entry.firstSeenAt === "string" && Number.isFinite(Date.parse(entry.firstSeenAt)) &&
      (entry.verdict === "material" || entry.verdict === "neutral")
  })
}

export function pruneNewsState(state: NewsMonitorState, now: Date): NewsMonitorState {
  const cutoff = now.getTime() - NEWS_STATE_RETENTION_DAYS * DAY
  return {
    schemaVersion: 1,
    items: Object.fromEntries(Object.entries(state.items).filter(([, item]) => Date.parse(item.firstSeenAt) >= cutoff)),
  }
}

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

const LEGAL_SUFFIXES = new Set(["gmbh", "ag", "se", "sa", "inc", "ltd", "llc", "plc", "kg", "co", "corp", "bv", "nv", "ab", "as", "oy", "spa", "srl", "sarl", "group", "holding", "international"])

// App stores, mirrors, and integration directories describe listings or third parties using the account's API.
const LISTING_HOSTS = [
  "play.google.com", "apps.apple.com", "apkcombo.com", "apkpure.com", "apkmirror.com", "uptodown.com", "apk.support",
  "appbrain.com", "40407.com", "composio.dev", "zapier.com", "pipedream.com", "n8n.io", "make.com", "rapidapi.com",
  "apify.com", "mcp.so", "smithery.ai", "glama.ai", "pulsemcp.com",
]
const REVIEW_HOSTS = ["trustpilot.com", "kununu.com", "glassdoor.com"]
const ALWAYS_EXCLUDED = ["linkedin.com", "exa.ai"]
const APP_LISTING = /\bapk\b|apps on google play|on the app store/iu

export function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/&/gu, " and ")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
}

function nameTokens(name: string): string[] {
  const tokens = normalizeText(name).split(" ").filter(Boolean)
  const meaningful = tokens.filter((token) => !LEGAL_SUFFIXES.has(token) && token !== "and")
  return meaningful.length > 0 ? meaningful : tokens
}

/** True when the text names the account: the full name as a phrase, or every meaningful token. */
export function mentionsName(name: string, haystack: string): boolean {
  const text = ` ${normalizeText(haystack)} `
  const phrase = normalizeText(name)
  if (!phrase) return false
  if (text.includes(` ${phrase} `)) return true
  const tokens = nameTokens(name)
  if (tokens.length === 0) return false
  if (tokens.length === 1) return text.includes(` ${tokens[0]} `)
  return tokens.every((token) => token.length < 2 || text.includes(` ${token} `))
}

export function mentionsAccount(account: Pick<WatchlistAccount, "name" | "searchName" | "aliases">, haystack: string): boolean {
  return [account.searchName, ...account.aliases].some((name) => mentionsName(name, haystack))
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./u, "")
  } catch {
    return ""
  }
}

function matchesHost(host: string, domains: readonly string[]): boolean {
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`))
}

/** Site roots and locale roots such as /en-gb-gbp describe the company, not an event. */
export function isHomepage(url: string): boolean {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean)
    return parts.length === 0 || parts.every((part) => /^[a-z]{2}(?:[-_][a-z]{2}(?:[-_][a-z]{3})?)?$/iu.test(part))
  } catch {
    return false
  }
}

export function canonicalUrl(value: unknown): string | null {
  if (typeof value !== "string") return null
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    if (url.username || url.password) return null
    url.hash = ""
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_)/iu.test(key)) url.searchParams.delete(key)
    }
    return url.toString()
  } catch {
    return null
  }
}

export function newsItemId(url: string): string {
  return `news:${createHash("sha256").update(url).digest("hex").slice(0, 16)}`
}

/** Syndicated copies of one press release carry near-identical titles with different prefixes or suffixes. */
export function sameStory(a: string, b: string): boolean {
  const words = (value: string) => new Set(normalizeText(value).split(" ").filter((word) => word.length > 3))
  const left = words(a)
  const right = words(b)
  if (left.size < 3 || right.size < 3) return false
  const shared = [...left].filter((word) => right.has(word)).length
  return shared / Math.min(left.size, right.size) >= 0.7
}

// ---------------------------------------------------------------------------
// Exa request and transport
// ---------------------------------------------------------------------------

export type ExaNewsRequest = {
  query: string
  type: "auto"
  category: "news"
  numResults: number
  startPublishedDate: string
  endPublishedDate: string
  excludeDomains: string[]
  contents: { highlights: { query: string; maxCharacters: number } }
}

export type ExaFetch = (input: string, init: RequestInit) => Promise<Response>
type ExaResult = { title?: unknown; url?: unknown; publishedDate?: unknown; highlights?: unknown; text?: unknown }

function safe(value: string): string {
  return value.replace(/["\r\n]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 120)
}

export function buildNewsRequest(account: WatchlistAccount, now: Date): ExaNewsRequest {
  const name = safe(account.searchName)
  const context = account.context ? ` ${safe(account.context)}` : ""
  const exclude = ALWAYS_EXCLUDED.flatMap((domain) => [domain, `*.${domain}`])
  if (account.excludeOwnDomain && account.domain) exclude.push(account.domain, `*.${account.domain}`)
  return {
    query: `${name}${context} news`,
    type: "auto",
    category: "news",
    numResults: NEWS_RESULTS_PER_ACCOUNT,
    startPublishedDate: new Date(now.getTime() - NEWS_LOOKBACK_DAYS * DAY).toISOString(),
    endPublishedDate: now.toISOString(),
    excludeDomains: exclude,
    contents: {
      highlights: {
        query: `What changed at ${name}: launches, relaunches, leadership changes, acquisitions, funding, layoffs, restructuring, technology or platform decisions?`,
        maxCharacters: 1200,
      },
    },
  }
}

class SearchError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

async function search(request: ExaNewsRequest, runtime: { exaApiKey: string; fetch: ExaFetch; timeoutMs: number; signal?: AbortSignal }): Promise<ExaResult[]> {
  const timeout = AbortSignal.timeout(runtime.timeoutMs)
  let response: Response
  try {
    response = await runtime.fetch(EXA_SEARCH_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "x-api-key": runtime.exaApiKey },
      body: JSON.stringify(request),
      signal: runtime.signal ? AbortSignal.any([runtime.signal, timeout]) : timeout,
    })
  } catch (error) {
    const name = error instanceof Error ? error.name : ""
    throw new SearchError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network_error")
  }
  if (!response.ok) throw new SearchError(`http_${response.status}`)
  const body = await response.text()
  if (body.length > MAX_RESPONSE_BYTES) throw new SearchError("response_too_large")
  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    throw new SearchError("invalid_response")
  }
  const results = (payload as { results?: unknown })?.results
  if (!Array.isArray(results)) throw new SearchError("invalid_response")
  return results as ExaResult[]
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

export type NewsCandidate = {
  id: string
  title: string
  url: string
  publisher: string
  publishedAt: string | null
  excerpt: string
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : ""
}

function segmentsOf(result: ExaResult): string[] {
  const raw = Array.isArray(result.highlights) ? result.highlights.filter((item): item is string => typeof item === "string") : []
  const body = raw.length > 0 ? raw : [typeof result.text === "string" ? result.text : ""]
  return body
    .flatMap((item) => item.split(/\n\s*\.\.\.\s*\n|\n{2,}/u))
    .map((segment) => segment.replace(/^[#>*\s-]+/u, "").replace(/\s+/gu, " ").trim())
    .filter(Boolean)
}

function publishedAt(value: unknown): string | null {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null
  return new Date(value).toISOString()
}

/** Deterministic checks before the judge. Returns null for results that can never be an account event. */
export function toCandidate(result: ExaResult, account: WatchlistAccount, now: Date): NewsCandidate | null {
  const url = canonicalUrl(result.url)
  const title = clean(result.title).slice(0, 240)
  if (!url || !title) return null
  const host = hostOf(url)
  if (!host || matchesHost(host, [...ALWAYS_EXCLUDED, ...LISTING_HOSTS, ...REVIEW_HOSTS])) return null
  if (account.excludeOwnDomain && account.domain && matchesHost(host, [account.domain])) return null
  if (isHomepage(url) || APP_LISTING.test(title)) return null
  const published = publishedAt(result.publishedDate)
  if (published && Date.parse(published) < now.getTime() - (NEWS_LOOKBACK_DAYS + 1) * DAY) return null
  const segments = segmentsOf(result)
  const body = segments.join(" ")
  // The account must be the subject: named in the title or the lead, not merely somewhere in the page.
  if (!mentionsAccount(account, `${title} ${body.slice(0, LEAD_CHARS)}`)) return null
  const excerpt = body.length > EXCERPT_CHARS ? `${body.slice(0, EXCERPT_CHARS - 1).trimEnd()}…` : body
  return { id: newsItemId(url), title, url, publisher: host, publishedAt: published, excerpt }
}

// ---------------------------------------------------------------------------
// Judge contract
// ---------------------------------------------------------------------------

export type JudgeItem = { index: number; title: string; publisher: string; publishedAt: string | null; excerpt: string }

export type JudgeVerdict = {
  index: number
  aboutAccount: boolean
  datedEvent: boolean
  /** Index of an earlier item in the same batch that reports the same event, or null. */
  duplicateOf: number | null
  /** True when the item reports an event already known for this account. */
  repeatsKnownEvent: boolean
  impact: "opportunity" | "risk" | "neutral"
  confidence: "high" | "medium" | "low"
  /** Verbatim sentence from the item that states the development. */
  evidence: string
  whatHappened: string
  whyVercel: string
  nextStep: string
}

export type KnownEvent = { title: string; whatHappened: string }

export type NewsJudge = (
  account: WatchlistAccount,
  items: readonly JudgeItem[],
  known: readonly KnownEvent[],
  signal?: AbortSignal,
) => Promise<JudgeVerdict[]>

/** The quoted evidence must really occur in the item, so a verdict cannot rest on invented facts. */
export function evidenceSupported(evidence: string, item: Pick<JudgeItem, "title" | "excerpt">): boolean {
  const quote = normalizeText(evidence)
  if (quote.split(" ").length < 4) return false
  return normalizeText(`${item.title} ${item.excerpt}`).includes(quote)
}

/**
 * Material only when about the account, a new dated event (not a repeat or duplicate), non-neutral,
 * at least medium confidence, and backed by a verbatim quote from the item.
 */
export function materialEvent(verdict: JudgeVerdict | undefined, item: Pick<JudgeItem, "title" | "excerpt">): NewsEventCore | null {
  if (!verdict || !verdict.aboutAccount || !verdict.datedEvent) return null
  if (verdict.duplicateOf !== null || verdict.repeatsKnownEvent) return null
  if (verdict.impact === "neutral" || verdict.confidence === "low") return null
  if (!evidenceSupported(verdict.evidence, item)) return null
  const line = (value: string, max: number) => value.replace(/\s+/gu, " ").trim().slice(0, max)
  const whatHappened = line(verdict.whatHappened, 280)
  const whyVercel = line(verdict.whyVercel, 220)
  if (!whatHappened || !whyVercel) return null
  return { direction: verdict.impact, confidence: verdict.confidence, whatHappened, whyVercel, nextStep: line(verdict.nextStep, 140) }
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

export type NewsEvent = NewsEventCore & {
  id: string
  accountName: string
  salesforceAccountId: string | null
  title: string
  url: string
  publisher: string
  publishedAt: string | null
  firstSeenAt: string
  /** Detected by an earlier scan but not yet recorded as delivered. */
  carriedOver: boolean
}

export type NewsScanResult = {
  status: "succeeded" | "partial" | "failed" | "unavailable"
  scannedAt: string
  lookback: { start: string; end: string }
  accounts: { total: number; searched: number; failed: string[] }
  counts: { results: number; candidates: number; judged: number; alreadyJudged: number; material: number }
  events: NewsEvent[]
  pendingBeyondLimit: number
  stateSaved: boolean
  limitations: string[]
}

export type NewsStateStore = {
  load(): Promise<{ state: NewsMonitorState; etag?: string }>
  save(state: NewsMonitorState, etag?: string): Promise<void>
}

export type NewsScanOptions = {
  enabled: boolean
  exaApiKey?: string
  loadWatchlist: () => Promise<NewsWatchlist | null>
  loadReportedIds: () => Promise<readonly string[]>
  stateStore: NewsStateStore
  judge: NewsJudge
  fetch?: ExaFetch
  now?: () => Date
  signal?: AbortSignal
  timeoutMs?: number
  concurrency?: number
}

async function pool<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await run(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

function unavailable(now: Date, reason: string): NewsScanResult {
  return {
    status: "unavailable",
    scannedAt: now.toISOString(),
    lookback: { start: new Date(now.getTime() - NEWS_LOOKBACK_DAYS * DAY).toISOString(), end: now.toISOString() },
    accounts: { total: 0, searched: 0, failed: [] },
    counts: { results: 0, candidates: 0, judged: 0, alreadyJudged: 0, material: 0 },
    events: [],
    pendingBeyondLimit: 0,
    stateSaved: false,
    limitations: [reason],
  }
}

const CONFIDENCE_RANK: Record<NewsConfidence, number> = { high: 2, medium: 1 }

export async function scanAccountNews(options: NewsScanOptions): Promise<NewsScanResult> {
  const now = (options.now ?? (() => new Date()))()
  if (!options.enabled) return unavailable(now, "Account news is disabled because EXTERNAL_SOURCES_ENABLED or EXTERNAL_SOURCE_TERMS_APPROVED is not 1.")
  if (!options.exaApiKey?.trim()) return unavailable(now, "Account news is unavailable because EXA_API_KEY is not configured.")

  let watchlist: NewsWatchlist | null
  try {
    watchlist = await options.loadWatchlist()
  } catch {
    return unavailable(now, "Account news is unavailable because the watchlist could not be read.")
  }
  if (!watchlist) return unavailable(now, "Account news is unavailable because no watchlist is configured.")

  const limitations: string[] = []
  let reported = new Set<string>()
  try {
    reported = new Set(await options.loadReportedIds())
  } catch {
    limitations.push("Delivery ledger was unavailable; previously reported news may repeat.")
  }

  let loaded: { state: NewsMonitorState; etag?: string }
  let stateAvailable = true
  try {
    loaded = await options.stateStore.load()
  } catch {
    stateAvailable = false
    loaded = { state: emptyNewsState() }
    limitations.push("News state was unavailable; items are judged again and nothing is remembered this run.")
  }
  const state = pruneNewsState(loaded.state, now)
  const runtime = { exaApiKey: options.exaApiKey, fetch: options.fetch ?? fetch, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal: options.signal }
  const firstSeenAt = now.toISOString()
  const counts = { results: 0, candidates: 0, judged: 0, alreadyJudged: 0, material: 0 }
  const failed: string[] = []
  let searched = 0

  await pool(watchlist.accounts, options.concurrency ?? DEFAULT_CONCURRENCY, async (account) => {
    let results: ExaResult[]
    try {
      results = await search(buildNewsRequest(account, now), runtime)
    } catch {
      failed.push(account.name)
      return
    }
    searched += 1
    counts.results += results.length
    const known = Object.values(state.items).filter((item) => item.account === account.name)
    const fresh: NewsCandidate[] = []
    for (const result of results) {
      const candidate = toCandidate(result, account, now)
      if (!candidate) continue
      counts.candidates += 1
      if (state.items[candidate.id] || known.some((item) => sameStory(item.title, candidate.title))) {
        counts.alreadyJudged += 1
        continue
      }
      if (fresh.some((item) => sameStory(item.title, candidate.title))) continue
      fresh.push(candidate)
    }
    for (let offset = 0; offset < fresh.length; offset += NEWS_JUDGE_BATCH) {
      const batch = fresh.slice(offset, offset + NEWS_JUDGE_BATCH)
      let verdicts: JudgeVerdict[]
      try {
        const knownEvents = Object.values(state.items)
          .filter((item) => item.account === account.name && item.verdict === "material" && item.event)
          .map((item) => ({ title: item.title, whatHappened: item.event?.whatHappened ?? "" }))
        verdicts = await options.judge(account, batch.map((item, index) => ({
          index,
          title: item.title,
          publisher: item.publisher,
          publishedAt: item.publishedAt,
          excerpt: item.excerpt,
        })), knownEvents, options.signal)
      } catch {
        // Unjudged items are not remembered, so the next scan judges them again.
        if (!failed.includes(account.name)) failed.push(account.name)
        return
      }
      counts.judged += batch.length
      batch.forEach((item, index) => {
        const event = materialEvent(verdicts.find((verdict) => verdict.index === index), item)
        state.items[item.id] = {
          account: account.name,
          title: item.title,
          url: item.url,
          publisher: item.publisher,
          publishedAt: item.publishedAt,
          firstSeenAt,
          verdict: event ? "material" : "neutral",
          ...(event ? { event } : {}),
        }
        if (event) counts.material += 1
      })
    }
  })

  let stateSaved = false
  if (stateAvailable) {
    try {
      await options.stateStore.save(state, loaded.etag)
      stateSaved = true
    } catch {
      limitations.push("News state could not be saved; the next scan judges these items again.")
    }
  }

  const byName = new Map(watchlist.accounts.map((account) => [account.name, account]))
  const lookbackStart = now.getTime() - NEWS_LOOKBACK_DAYS * DAY
  const pending = Object.entries(state.items)
    .filter(([id, item]) => item.verdict === "material" && item.event && !reported.has(id) && byName.has(item.account))
    // Carry undelivered events for the lookback so a blocked brief delays, but never drops, them.
    .filter(([, item]) => Date.parse(item.firstSeenAt) >= lookbackStart)
    .map(([id, item]): NewsEvent => ({
      ...(item.event as NewsEventCore),
      id,
      accountName: item.account,
      salesforceAccountId: byName.get(item.account)?.salesforceAccountId ?? null,
      title: item.title,
      url: item.url,
      publisher: item.publisher,
      publishedAt: item.publishedAt,
      firstSeenAt: item.firstSeenAt,
      carriedOver: item.firstSeenAt !== firstSeenAt,
    }))
    .sort((a, b) =>
      Date.parse(a.firstSeenAt) - Date.parse(b.firstSeenAt) ||
      CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] ||
      a.accountName.localeCompare(b.accountName))

  if (failed.length > 0) limitations.push(`${failed.length} account(s) could not be scanned or judged this run and are retried next run.`)
  const status = searched === 0 ? "failed" : failed.length > 0 ? "partial" : "succeeded"
  return {
    status,
    scannedAt: now.toISOString(),
    lookback: { start: new Date(lookbackStart).toISOString(), end: now.toISOString() },
    accounts: { total: watchlist.accounts.length, searched, failed: failed.slice(0, 20) },
    counts,
    events: pending.slice(0, NEWS_MAX_EVENTS),
    pendingBeyondLimit: Math.max(0, pending.length - NEWS_MAX_EVENTS),
    stateSaved,
    limitations,
  }
}
