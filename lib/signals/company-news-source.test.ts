import { describe, expect, it } from "vitest"
import { collectCompanyNews, normalizeCompanyNewsItem, type CompanyNewsClient } from "./company-news-source"
import { redactedAccounts } from "./redacted-fixtures"

const [northstar, harbor] = redactedAccounts
const context = {
  startedAt: "2026-09-01T00:00:00.000Z",
  endedAt: "2026-09-14T23:59:59.000Z",
  collectedAt: "2026-09-14T09:00:00.000Z",
}

const newArticle = {
  sourceUrl: "https://northstar.example/news/platform-launch?utm_source=feed#top",
  canonicalUrl: "https://northstar.example/news/platform-launch",
  title: "Northstar launches its infrastructure platform",
  excerpt: "The engineering team announced a new cloud platform for production workloads.",
  publishedAt: "2026-09-13T16:30:00Z",
  author: "Northstar Engineering",
  kind: "article" as const,
}

const repeatedArticle = {
  ...newArticle,
  sourceUrl: "https://northstar.example/news/platform-launch?utm_medium=rss",
}

const irrelevantArticle = {
  sourceUrl: "https://northstar.example/news/summer-event",
  title: "Northstar summer event",
  excerpt: "Join us for food, music, and community activities.",
  publishedAt: "2026-09-12T12:00:00Z",
  author: "Northstar Communications",
  kind: "article" as const,
}

const malformedArticle = {
  sourceUrl: "https://northstar.example/news/unknown",
  title: "A technology update without attribution",
  excerpt: "The company shared an infrastructure update.",
  publishedAt: "not-a-date",
  kind: "post" as const,
}

function clientFor(
  responses: Record<string, { sourceUrl: string; items: readonly unknown[] } | Error>,
): CompanyNewsClient {
  return {
    async fetch(account) {
      const response = responses[account.id]
      if (response instanceof Error) throw response
      return response
    },
  }
}

describe("company news source", () => {
  it("normalizes canonical/source URLs and emits a typed first-party observation and snapshot", async () => {
    const result = await collectCompanyNews(
      [northstar],
      clientFor({
        [northstar.id]: {
          sourceUrl: "https://northstar.example/news",
          items: [newArticle],
        },
      }),
      context,
    )

    expect(result.failures).toEqual([])
    expect(result.rejections).toEqual([])
    expect(result.snapshots).toHaveLength(1)
    expect(result.snapshots[0].observations).toHaveLength(1)
    expect(result.snapshots[0].observations[0].source.url).toBe(
      "https://northstar.example/news/platform-launch",
    )
    expect(result.snapshots[0].observations[0].evidence[0].kind).toBe("company_article")
    expect(result.snapshots[0].observations[0].evidence[0].excerpt).toContain("cloud platform")
  })

  it("deduplicates repeated and syndicated items by canonical URL and content fingerprint", async () => {
    const result = await collectCompanyNews(
      [northstar],
      clientFor({
        [northstar.id]: {
          sourceUrl: "https://northstar.example/news",
          items: [newArticle, repeatedArticle, { ...newArticle, canonicalUrl: null }],
        },
      }),
      context,
    )

    expect(result.snapshots[0].observations).toHaveLength(1)
    expect(result.rejections.filter(({ reason }) => reason === "duplicate")).toHaveLength(2)
  })

  it("rejects irrelevant, malformed, unattributed, and non-first-party items without emitting evidence", async () => {
    const result = await collectCompanyNews(
      [northstar],
      clientFor({
        [northstar.id]: {
          sourceUrl: "https://northstar.example/news",
          items: [
            irrelevantArticle,
            malformedArticle,
            { ...newArticle, author: null },
            { ...newArticle, sourceUrl: "https://news.example/syndicated-copy" },
          ],
        },
      }),
      context,
    )

    expect(result.snapshots[0].observations).toHaveLength(0)
    expect(result.rejections.map(({ reason }) => reason)).toEqual([
      "irrelevant",
      "malformed",
      "unattributed",
      "not_first_party",
    ])
  })

  it("isolates an account fetch failure and still returns another account snapshot", async () => {
    const result = await collectCompanyNews(
      [northstar, harbor],
      clientFor({
        [northstar.id]: new Error("temporary source timeout"),
        [harbor.id]: {
          sourceUrl: "https://harbor.example/news",
          items: [
            {
              sourceUrl: "https://harbor.example/news/security-update",
              title: "Harbor publishes a security update",
              excerpt: "The platform team described a new security control.",
              publishedAt: "2026-09-14T07:15:00Z",
              author: "Harbor Platform Team",
              kind: "post",
            },
          ],
        },
      }),
      context,
    )

    expect(result.snapshots.map(({ accountId }) => accountId)).toEqual([harbor.id])
    expect(result.failures).toEqual([
      { accountId: northstar.id, code: "fetch_failed", message: "temporary source timeout" },
    ])
  })

  it("follows cursors and reports a repeated cursor while preserving partial results", async () => {
    const calls: Array<string | undefined> = []
    const result = await collectCompanyNews([northstar], {
      async fetch(_account, pageContext) {
        calls.push(pageContext.cursor)
        return pageContext.cursor
          ? { sourceUrl: "https://northstar.example/news", items: [repeatedArticle], nextCursor: pageContext.cursor }
          : { sourceUrl: "https://northstar.example/news", items: [newArticle], nextCursor: "next" }
      },
    }, context)
    expect(calls).toEqual([undefined, "next"])
    expect(result.failures).toEqual([expect.objectContaining({ code: "incomplete_pagination", partial: true })])
    expect(result.snapshots[0].observations).toHaveLength(1)
    expect(result.snapshots[0].nextCursor).toBe("next")
  })

  it("stops at the configured page limit", async () => {
    const result = await collectCompanyNews([northstar], {
      async fetch() { return { sourceUrl: "https://northstar.example/news", items: [newArticle], nextCursor: "next" } },
    }, context, { maxPages: 1 })
    expect(result.failures[0]).toMatchObject({ code: "incomplete_pagination", partial: true })
    expect(result.snapshots).toHaveLength(1)
  })

  it("throws from the single-item normalizer for rejected input", () => {
    expect(() => normalizeCompanyNewsItem(irrelevantArticle, northstar, context)).toThrow(
      "No material IT or technology topic detected",
    )
  })
})
