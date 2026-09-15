import { describe, expect, it } from "vitest"
import { collectCompanyNews } from "./company-news-source"
import { createExaCompanyNewsClient, buildExaNewsQuery, type ExaHttpClient } from "./exa-news-client"
import { redactedAccounts } from "./redacted-fixtures"

const [northstar] = redactedAccounts
const context = {
  startedAt: "2026-09-01T00:00:00.000Z",
  endedAt: "2026-09-14T23:59:59.000Z",
  collectedAt: "2026-09-14T09:00:00.000Z",
}

const exaResponse = {
  requestId: "req_redacted",
  results: [{
    id: "https://northstar.example/news/platform-launch",
    url: "https://northstar.example/news/platform-launch?utm_source=exa",
  }],
}

const canonicalNewsPage = `<!doctype html>
<html>
  <head>
    <link rel="canonical" href="https://northstar.example/news/platform-launch" />
    <meta property="og:title" content="Northstar launches its infrastructure platform" />
    <meta name="description" content="The engineering team announced a new cloud platform for production workloads." />
    <meta property="article:published_time" content="2026-09-13T16:30:00Z" />
    <meta name="author" content="Northstar Engineering" />
  </head>
  <body><article>Northstar launches its infrastructure platform.</article></body>
</html>`

function httpClientFor(
  searchBody: unknown,
  options: { searchStatus?: number; pageBody?: string; pageStatus?: number } = {},
): {
  client: ExaHttpClient
  request: { input: RequestInfo | URL; init?: RequestInit } | null
  pageRequest: { input: RequestInfo | URL; init?: RequestInit } | null
} {
  let captured: { input: RequestInfo | URL; init?: RequestInit } | null = null
  let capturedPage: { input: RequestInfo | URL; init?: RequestInit } | null = null
  return {
    client: async (input, init) => {
      const url = String(input)
      if (url.endsWith("/search")) captured = { input, init }
      else capturedPage = { input, init }
      return url.endsWith("/search")
        ? new Response(JSON.stringify(searchBody), { status: options.searchStatus ?? 200 })
        : new Response(options.pageBody ?? canonicalNewsPage, { status: options.pageStatus ?? 200 })
    },
    get request() {
      return captured
    },
    get pageRequest() {
      return capturedPage
    },
  }
}

describe("Exa company-news client", () => {
  it("builds an account-scoped technology-news query", () => {
    expect(buildExaNewsQuery(northstar)).toContain('"Northstar Labs"')
    expect(buildExaNewsQuery(northstar)).toContain("infrastructure")
    expect(buildExaNewsQuery(northstar)).toContain("restructuring")
  })

  it("sends bounded date and first-party domain filters and parses the canonical page", async () => {
    const transport = httpClientFor(exaResponse)
    const client = createExaCompanyNewsClient({
      apiKey: "exa-test-key",
      endpoint: "https://exa.example.test/search",
      httpClient: transport.client,
      numResults: 4,
    })

    const result = await client.fetch(northstar, context)
    const request = transport.request
    expect(request).not.toBeNull()
    expect(String(request?.input)).toBe("https://exa.example.test/search")
    expect(new Headers(request?.init?.headers).get("x-api-key")).toBe("exa-test-key")
    expect(String(transport.pageRequest?.input)).toBe("https://northstar.example/news/platform-launch")
    expect(new Headers(transport.pageRequest?.init?.headers).get("x-api-key")).toBeNull()

    const body = JSON.parse(String(request?.init?.body)) as Record<string, unknown>
    expect(body).toMatchObject({
      type: "fast",
      category: "news",
      numResults: 4,
      includeDomains: ["northstar.example"],
      startPublishedDate: context.startedAt,
      endPublishedDate: context.endedAt,
    })
    expect(result.sourceUrl).toBe("https://northstar.example/")
    expect(result.nextCursor).toBeNull()
    expect(result.items[0]).toEqual({
      sourceUrl: "https://northstar.example/news/platform-launch",
      canonicalUrl: "https://northstar.example/news/platform-launch",
      title: "Northstar launches its infrastructure platform",
      excerpt: "The engineering team announced a new cloud platform for production workloads.",
      publishedAt: "2026-09-13T16:30:00Z",
      author: "Northstar Engineering",
      kind: "article",
    })
  })

  it("works with the existing first-party news collector", async () => {
    const transport = httpClientFor(exaResponse)
    const result = await collectCompanyNews(
      [northstar],
      createExaCompanyNewsClient({
        apiKey: "exa-test-key",
        endpoint: "https://exa.example.test/search",
        httpClient: transport.client,
      }),
      context,
    )

    expect(result.failures).toEqual([])
    expect(result.rejections).toEqual([])
    expect(result.snapshots[0].observations[0].source.url).toBe(
      "https://northstar.example/news/platform-launch",
    )
  })

  it("honors robots checks before fetching canonical pages", async () => {
    let pageRequests = 0
    const transport = httpClientFor(exaResponse)
    const client = createExaCompanyNewsClient({
      apiKey: "exa-test-key",
      endpoint: "https://exa.example.test/search",
      httpClient: async (input, init) => {
        if (!String(input).endsWith("/search")) pageRequests += 1
        return transport.client(input, init)
      },
      checkRobots: () => false,
    })

    await expect(client.fetch(northstar, context)).rejects.toThrow("robots policy")
    expect(pageRequests).toBe(0)
  })

  it("fails without treating an Exa error response as an empty source", async () => {
    const transport = httpClientFor({ error: "rate limited" }, { searchStatus: 429 })
    const client = createExaCompanyNewsClient({
      apiKey: "exa-test-key",
      endpoint: "https://exa.example.test/search",
      httpClient: transport.client,
    })

    await expect(client.fetch(northstar, context)).rejects.toThrow("Exa search returned HTTP 429")
  })

  it("rejects malformed Exa responses", async () => {
    const transport = httpClientFor({ items: [] })
    const client = createExaCompanyNewsClient({
      apiKey: "exa-test-key",
      endpoint: "https://exa.example.test/search",
      httpClient: transport.client,
    })

    await expect(client.fetch(northstar, context)).rejects.toThrow("did not contain results")
  })
})
