import {
  SCHEMA_VERSION,
  observationSchema,
  snapshotSchema,
  type Account,
  type Observation,
  type Snapshot,
} from "./contracts"
import {
  createEvidenceId,
  createObservationId,
  createSnapshotId,
} from "./stable-id"

export type CompanyNewsWindow = {
  startedAt: string
  endedAt: string
  collectedAt: string
  cursor?: string
}

/** The boundary is deliberately client-injected: this module never performs network I/O. */
export interface CompanyNewsClient {
  fetch(
    account: Account,
    context: CompanyNewsWindow,
  ): Promise<CompanyNewsFetchResult>
}

export type CompanyNewsFetchResult = {
  /** Public first-party source scope; discovery-provider endpoints are not evidence URLs. */
  sourceUrl: string
  items: readonly unknown[]
  nextCursor?: string | null
}

export type CompanyNewsItemInput = {
  sourceUrl: string
  canonicalUrl?: string | null
  title: string
  excerpt: string
  publishedAt?: string | null
  author?: string | null
  kind?: "article" | "post"
}

export type NormalizedCompanyNewsItem = {
  canonicalUrl: string
  sourceUrl: string
  title: string
  excerpt: string
  publishedAt: string
  author: string
  observedAt: string
  kind: "article" | "post"
}

export type CompanyNewsObservationInput = Observation
export type CompanyNewsSnapshotInput = Snapshot

export type CompanyNewsRejection = {
  accountId: string
  reason:
    | "malformed"
    | "unattributed"
    | "not_first_party"
    | "irrelevant"
    | "outside_window"
    | "duplicate"
  sourceUrl: string | null
  detail: string
}

export type CompanyNewsAccountFailure = {
  accountId: string
  code: "fetch_failed" | "invalid_source" | "incomplete_pagination"
  message: string
  partial?: boolean
}

export type CompanyNewsCollectionResult = {
  snapshots: CompanyNewsSnapshotInput[]
  rejections: CompanyNewsRejection[]
  failures: CompanyNewsAccountFailure[]
}

const technologyTerms = [
  "ai",
  "cloud",
  "cybersecurity",
  "data platform",
  "engineering",
  "infrastructure",
  "machine learning",
  "platform",
  "security",
  "software",
  "technology",
]

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

function publicUrl(value: unknown): string | null {
  if (typeof value !== "string") return null
  try {
    const url = new URL(value.trim())
    if (url.protocol !== "https:") return null
    if (url.username || url.password) return null
    if (url.hostname.toLowerCase() === "linkedin.com" || url.hostname.toLowerCase().endsWith(".linkedin.com")) {
      return null
    }
    url.hash = ""
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_)/i.test(key)) url.searchParams.delete(key)
    }
    url.hostname = url.hostname.toLowerCase()
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "")
    return url.toString()
  } catch {
    return null
  }
}

function firstParty(url: string, account: Account): boolean {
  const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "")
  return account.domains.some((domain) => {
    const normalized = domain.toLowerCase().replace(/^www\./, "").replace(/\.$/, "")
    return hostname === normalized || hostname.endsWith(`.${normalized}`)
  })
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null
  const date = new Date(value)
  return date.toISOString()
}

function withinWindow(value: string, context: CompanyNewsWindow): boolean {
  const time = Date.parse(value)
  return time >= Date.parse(context.startedAt) && time <= Date.parse(context.endedAt)
}

function isRelevant(item: NormalizedCompanyNewsItem): boolean {
  const haystack = `${item.title} ${item.excerpt}`.toLowerCase()
  return technologyTerms.some((term) => haystack.includes(term))
}

function itemFingerprint(item: NormalizedCompanyNewsItem): string {
  return [
    item.title.toLowerCase().replace(/\s+/g, " "),
    item.excerpt.toLowerCase().replace(/\s+/g, " "),
    item.publishedAt.slice(0, 10),
    item.author.toLowerCase(),
  ].join("|")
}

function normalizeItem(
  value: unknown,
  account: Account,
  context: CompanyNewsWindow,
): { item: NormalizedCompanyNewsItem } | { rejection: Omit<CompanyNewsRejection, "accountId"> } {
  if (!value || typeof value !== "object") {
    return { rejection: { reason: "malformed", sourceUrl: null, detail: "Item must be an object" } }
  }

  const input = value as Record<string, unknown>
  const sourceUrl = publicUrl(input.sourceUrl)
  const canonicalUrl = publicUrl(input.canonicalUrl ?? input.sourceUrl)
  const title = text(input.title)
  const excerpt = text(input.excerpt)
  const author = text(input.author)
  const publishedAt = timestamp(input.publishedAt)
  const kind = input.kind === "post" ? "post" : input.kind === "article" ? "article" : null

  if (!sourceUrl || !canonicalUrl || !title || !excerpt || !publishedAt || !kind) {
    return {
      rejection: {
        reason: "malformed",
        sourceUrl,
        detail: "Required URL, title, excerpt, publication time, or kind is missing/invalid",
      },
    }
  }
  if (!author) {
    return { rejection: { reason: "unattributed", sourceUrl, detail: "Author or publisher is required" } }
  }
  if (!firstParty(sourceUrl, account) || !firstParty(canonicalUrl, account)) {
    return { rejection: { reason: "not_first_party", sourceUrl, detail: "URL is not on an account domain" } }
  }
  if (!withinWindow(publishedAt, context)) {
    return { rejection: { reason: "outside_window", sourceUrl, detail: "Publication time is outside the collection window" } }
  }

  const item: NormalizedCompanyNewsItem = {
    canonicalUrl,
    sourceUrl,
    title,
    excerpt,
    publishedAt,
    author,
    observedAt: publishedAt,
    kind,
  }
  if (!isRelevant(item)) {
    return { rejection: { reason: "irrelevant", sourceUrl, detail: "No material IT or technology topic detected" } }
  }
  return { item }
}

export function normalizeCompanyNewsItem(
  value: unknown,
  account: Account,
  context: CompanyNewsWindow,
): NormalizedCompanyNewsItem {
  const result = normalizeItem(value, account, context)
  if ("rejection" in result) throw new Error(result.rejection.detail)
  return result.item
}

export async function collectCompanyNews(
  accounts: readonly Account[],
  client: CompanyNewsClient,
  context: CompanyNewsWindow,
  options: { maxPages?: number } = {},
): Promise<CompanyNewsCollectionResult> {
  const maxPages = options.maxPages ?? 100
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error("maxPages must be a positive integer")
  const snapshots: Snapshot[] = []
  const rejections: CompanyNewsRejection[] = []
  const failures: CompanyNewsAccountFailure[] = []

  for (const account of accounts) {
    let fetched: CompanyNewsFetchResult | undefined
    let sourceUrl: string | null = null
    const items: unknown[] = []
    let cursor = context.cursor
    const seenCursors = new Set<string>()
    let paginationFailure: CompanyNewsAccountFailure | undefined
    for (let page = 0; page < maxPages; page += 1) {
      if (cursor) {
        if (seenCursors.has(cursor)) {
          paginationFailure = { accountId: account.id, code: "incomplete_pagination", message: "Company-news source returned a repeated cursor", partial: items.length > 0 }
          break
        }
        seenCursors.add(cursor)
      }
      try {
        fetched = await client.fetch(account, { ...context, ...(cursor ? { cursor } : {}) })
      } catch (error) {
        paginationFailure = { accountId: account.id, code: "fetch_failed", message: error instanceof Error ? error.message : "Company news fetch failed", ...(items.length > 0 ? { partial: true } : {}) }
        break
      }
      const pageSourceUrl = publicUrl(fetched.sourceUrl)
      if (!pageSourceUrl || !firstParty(pageSourceUrl, account)) {
        paginationFailure = { accountId: account.id, code: "invalid_source", message: "Configured company-news source must be a public first-party HTTPS URL", ...(items.length > 0 ? { partial: true } : {}) }
        break
      }
      sourceUrl ??= pageSourceUrl
      items.push(...fetched.items)
      const nextCursor = fetched.nextCursor === null || fetched.nextCursor === undefined ? undefined : text(fetched.nextCursor) ?? undefined
      if (fetched.nextCursor !== null && fetched.nextCursor !== undefined && !nextCursor) {
        paginationFailure = { accountId: account.id, code: "incomplete_pagination", message: "Company-news source returned an invalid cursor", partial: items.length > 0 }
        break
      }
      cursor = nextCursor
      if (!cursor) break
      if (page === maxPages - 1) paginationFailure = { accountId: account.id, code: "incomplete_pagination", message: `Pagination exceeded ${maxPages} pages`, partial: true }
    }
    if (paginationFailure && !sourceUrl) {
      failures.push(paginationFailure)
      continue
    }
    if (paginationFailure) failures.push(paginationFailure)
    if (!sourceUrl || !fetched) continue

    const accepted: NormalizedCompanyNewsItem[] = []
    const seen = new Set<string>()
    for (const candidate of items) {
      const normalized = normalizeItem(candidate, account, context)
      if ("rejection" in normalized) {
        rejections.push({ accountId: account.id, ...normalized.rejection })
        continue
      }
      const key = normalized.item.canonicalUrl || itemFingerprint(normalized.item)
      if (seen.has(key) || [...seen].some((seenKey) => seenKey === itemFingerprint(normalized.item))) {
        rejections.push({
          accountId: account.id,
          reason: "duplicate",
          sourceUrl: normalized.item.sourceUrl,
          detail: "Repeated or syndicated item",
        })
        continue
      }
      seen.add(key)
      seen.add(itemFingerprint(normalized.item))
      accepted.push(normalized.item)
    }

    const source = {
      schemaVersion: SCHEMA_VERSION,
      system: "company_news" as const,
      recordId: sourceUrl,
      url: sourceUrl,
      collectedAt: context.collectedAt,
    }
    const observations = accepted.map((item) => {
      const itemSource = { ...source, recordId: item.canonicalUrl, url: item.canonicalUrl }
      const evidence = {
        schemaVersion: SCHEMA_VERSION,
        id: createEvidenceId("company_news", item.canonicalUrl, context.collectedAt),
        kind: item.kind === "post" ? ("company_post" as const) : ("company_article" as const),
        source: itemSource,
        capturedAt: context.collectedAt,
        summary: item.title,
        excerpt: item.excerpt,
        attributes: {
          canonicalUrl: item.canonicalUrl,
          sourceUrl: item.sourceUrl,
          author: item.author,
          publishedAt: item.publishedAt,
        },
      }
      return observationSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        id: createObservationId(account.id, "company_news", item.canonicalUrl, item.observedAt),
        accountId: account.id,
        category: "it_company_news" as const,
        source: itemSource,
        observedAt: item.observedAt,
        receivedAt: context.collectedAt,
        evidence: [evidence],
      })
    })

    snapshots.push(snapshotSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      id: createSnapshotId(account.id, "company_news", context.startedAt, context.endedAt),
      accountId: account.id,
      source,
      windowStartedAt: context.startedAt,
      windowEndedAt: context.endedAt,
      capturedAt: context.collectedAt,
      observations,
      nextCursor: cursor ?? null,
    }))
  }

  return { snapshots, rejections, failures }
}
