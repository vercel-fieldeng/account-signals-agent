import type { Account } from "./contracts"
import type {
  CompanyNewsClient,
  CompanyNewsFetchResult,
  CompanyNewsWindow,
} from "./company-news-source"

export const EXA_SEARCH_ENDPOINT = "https://api.exa.ai/search"

const DEFAULT_NUM_RESULTS = 10
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000
const SEARCH_TERMS = [
  "engineering",
  "infrastructure",
  "platform",
  "technology",
  "cloud",
  "security",
  "software",
  "hiring",
  "expansion",
  "restructuring",
  "layoffs",
  "consolidation",
]

export type ExaHttpClient = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

export type ExaNewsClientOptions = {
  apiKey: string
  endpoint?: string
  httpClient?: ExaHttpClient
  pageClient?: ExaHttpClient
  numResults?: number
  maxResponseBytes?: number
  checkRobots?: (url: string) => Promise<boolean> | boolean
  checkTerms?: (url: string) => Promise<boolean> | boolean
}

export type ExaSearchRequest = {
  query: string
  type: "fast"
  category: "news"
  numResults: number
  includeDomains: string[]
  startPublishedDate: string
  endPublishedDate: string
}

type ExaSearchResult = {
  url?: unknown
}

type ParsedPage = {
  canonicalUrl: string
  title: string
  excerpt: string
  publishedAt: string
  author: string
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function searchDomain(value: string): string {
  const candidate = value.trim().replace(/^https?:\/\//i, "").split("/")[0]
  return candidate.toLowerCase().replace(/^www\./, "")
}

function accountSourceUrl(account: Account): string {
  const domain = searchDomain(account.domains[0] ?? "")
  if (!domain || domain.includes("@") || domain.includes(":")) {
    throw new Error(`Account ${account.id} has no valid public domain for Exa news search`)
  }
  return `https://${domain}/`
}

function isoTimestamp(value: string, field: string): string {
  if (Number.isNaN(Date.parse(value))) throw new Error(`${field} must be an ISO timestamp`)
  return new Date(value).toISOString()
}

function validInteger(value: number, field: string, maximum: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${field} must be an integer between 1 and ${maximum}`)
  }
  return value
}

function safeAccountName(value: string): string {
  return value.replace(/["\r\n]+/g, " ").replace(/\s+/g, " ").trim()
}

/**
 * Exa is used for account-scoped discovery. The account domain filter is
 * intentional: the canonical first-party page remains the evidence boundary.
 */
export function buildExaNewsQuery(account: Account): string {
  const name = safeAccountName(account.name)
  if (!name) throw new Error(`Account ${account.id} must have a name for Exa news search`)
  return `"${name}" public company news about ${SEARCH_TERMS.join(", ")}`
}

export function buildExaSearchRequest(
  account: Account,
  context: CompanyNewsWindow,
  options: Pick<ExaNewsClientOptions, "numResults"> = {},
): ExaSearchRequest {
  const query = buildExaNewsQuery(account)
  return {
    query,
    type: "fast",
    category: "news",
    numResults: validInteger(options.numResults ?? DEFAULT_NUM_RESULTS, "numResults", 100),
    includeDomains: [...new Set(account.domains.map(searchDomain).filter(Boolean))],
    startPublishedDate: isoTimestamp(context.startedAt, "startedAt"),
    endPublishedDate: isoTimestamp(context.endedAt, "endedAt"),
  }
}

function canonicalUrl(value: string, baseUrl: string): string | null {
  try {
    const url = new URL(value, baseUrl)
    if (url.protocol !== "https:" || url.username || url.password) return null
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
    const normalized = searchDomain(domain).replace(/\.$/, "")
    return hostname === normalized || hostname.endsWith(`.${normalized}`)
  })
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
}

function plainText(value: string): string {
  return decodeHtml(
    value
      .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  )
}

function tagAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  for (const match of tag.matchAll(/([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attributes[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? "")
  }
  return attributes
}

function metadata(body: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const match of body.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = tagAttributes(match[0])
    const key = (attributes.property ?? attributes.name)?.toLowerCase()
    const value = attributes.content?.trim()
    if (key && value) values[key] = value
  }
  return values
}

function canonicalLink(body: string, baseUrl: string): string | null {
  for (const match of body.matchAll(/<link\b[^>]*>/gi)) {
    const attributes = tagAttributes(match[0])
    if (attributes.rel?.toLowerCase().split(/\s+/).includes("canonical") && attributes.href) {
      return canonicalUrl(attributes.href, baseUrl)
    }
  }
  return canonicalUrl(baseUrl, baseUrl)
}

function jsonLdArticle(body: string): Record<string, unknown> | null {
  for (const match of body.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(match[1]) as unknown
      const candidates = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>)["@graph"])
          ? (parsed as Record<string, unknown>)["@graph"] as unknown[]
          : [parsed]
      const article = candidates.find((candidate) => {
        if (!candidate || typeof candidate !== "object") return false
        const type = (candidate as Record<string, unknown>)["@type"]
        return (Array.isArray(type) ? type : [type]).some((value) =>
          typeof value === "string" && ["article", "newsarticle", "blogposting"].includes(value.toLowerCase()),
        )
      })
      if (article && typeof article === "object") return article as Record<string, unknown>
    } catch {
      // Ignore unrelated or malformed JSON-LD; other public metadata may still be usable.
    }
  }
  return null
}

function jsonAuthor(value: unknown): string | null {
  if (typeof value === "string") return text(value)
  if (Array.isArray(value)) return value.map(jsonAuthor).filter(Boolean).join(", ") || null
  if (value && typeof value === "object") return text((value as Record<string, unknown>).name)
  return null
}

function parseCanonicalPage(body: string, requestedUrl: string): ParsedPage {
  const meta = metadata(body)
  const article = jsonLdArticle(body)
  const titleTag = body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  const title = text(meta["og:title"]) ?? text(article?.headline) ?? text(titleTag)
  const excerpt = text(meta.description)
    ?? text(meta["og:description"])
    ?? text(article?.description)
    ?? text(plainText(body.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] ?? "").slice(0, 2_000))
  const publishedAt = text(meta["article:published_time"])
    ?? text(meta["datepublished"])
    ?? text(article?.datePublished)
  const author = text(meta.author)
    ?? text(meta["article:author"])
    ?? jsonAuthor(article?.author)
  const url = canonicalLink(body, requestedUrl)
  if (!url || !title || !excerpt || !publishedAt || !author) {
    throw new Error("Canonical first-party news page lacked attributable metadata")
  }
  return {
    canonicalUrl: url,
    title: decodeHtml(title),
    excerpt: plainText(excerpt).slice(0, 1_000),
    publishedAt,
    author: decodeHtml(author),
  }
}

async function responseBody(response: Response, label: string, maxResponseBytes: number): Promise<string> {
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`)
  const body = await response.text()
  if (new TextEncoder().encode(body).byteLength > maxResponseBytes) {
    throw new Error(`${label} response exceeded ${maxResponseBytes} bytes`)
  }
  return body
}

function responseResults(value: unknown): ExaSearchResult[] {
  if (!value || typeof value !== "object") throw new Error("Exa search returned a non-object response")
  const results = (value as Record<string, unknown>).results
  if (!Array.isArray(results)) throw new Error("Exa search response did not contain results")
  return results.filter((result): result is ExaSearchResult => Boolean(result && typeof result === "object"))
}

function endpointUrl(value: string): string {
  let endpoint: URL
  try {
    endpoint = new URL(value)
  } catch {
    throw new Error("Exa endpoint must be an absolute HTTPS URL")
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) {
    throw new Error("Exa endpoint must be an absolute HTTPS URL without credentials")
  }
  return endpoint.toString()
}

/**
 * Creates the network boundary for Exa. Exa supplies candidate URLs; the
 * returned client fetches those canonical first-party pages before emitting
 * items to collectCompanyNews.
 */
export function createExaCompanyNewsClient(options: ExaNewsClientOptions): CompanyNewsClient {
  const apiKey = options.apiKey.trim()
  if (!apiKey) throw new Error("Exa apiKey is required")
  const endpoint = endpointUrl(options.endpoint ?? EXA_SEARCH_ENDPOINT)
  const httpClient = options.httpClient ?? globalThis.fetch.bind(globalThis)
  const pageClient = options.pageClient ?? httpClient
  const numResults = validInteger(options.numResults ?? DEFAULT_NUM_RESULTS, "numResults", 100)
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new Error("maxResponseBytes must be a positive integer")
  }

  return {
    async fetch(account, context): Promise<CompanyNewsFetchResult> {
      const sourceUrl = accountSourceUrl(account)
      const request = buildExaSearchRequest(account, context, { numResults })
      const response = await httpClient(endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify(request),
      })
      const body = await responseBody(response, "Exa search", maxResponseBytes)
      let parsed: unknown
      try {
        parsed = JSON.parse(body)
      } catch {
        throw new Error("Exa search returned malformed JSON")
      }

      const candidates = responseResults(parsed)
        .map((result) => text(result.url))
        .map((url) => url ? canonicalUrl(url, url) : null)
        .filter((url): url is string => Boolean(url && firstParty(url, account)))
      if (candidates.length === 0) throw new Error("Exa search returned no first-party URLs")

      const items: ParsedPage[] = []
      let firstFailure: Error | undefined
      for (const candidate of [...new Set(candidates)]) {
        try {
          if (options.checkRobots && !(await options.checkRobots(candidate))) {
            throw new Error("Canonical news page is disallowed by robots policy")
          }
          if (options.checkTerms && !(await options.checkTerms(candidate))) {
            throw new Error("Canonical news page is disallowed by terms policy")
          }
          const pageResponse = await pageClient(candidate, {
            method: "GET",
            headers: { accept: "text/html, application/xhtml+xml" },
          })
          const pageBody = await responseBody(pageResponse, "Canonical news page", maxResponseBytes)
          const page = parseCanonicalPage(pageBody, candidate)
          if (firstParty(page.canonicalUrl, account)) items.push(page)
        } catch (error) {
          firstFailure ??= error instanceof Error ? error : new Error("Canonical news page fetch failed")
        }
      }
      if (items.length === 0) {
        throw firstFailure ?? new Error("Exa search returned no attributable first-party news pages")
      }

      return {
        sourceUrl,
        items: items.map((item) => ({
          sourceUrl: item.canonicalUrl,
          canonicalUrl: item.canonicalUrl,
          title: item.title,
          excerpt: item.excerpt,
          publishedAt: item.publishedAt,
          author: item.author,
          kind: "article" as const,
        })),
        nextCursor: null,
      }
    },
  }
}
