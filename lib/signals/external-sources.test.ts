import { describe, expect, it } from "vitest"
import { redactedAccounts } from "./redacted-fixtures"
import { createAccountId } from "./stable-id"
import type { CareersHttpClient } from "./careers-source"
import type { CompanyNewsClient } from "./company-news-source"
import { collectExternalSignals } from "./external-sources"

const [northstar] = redactedAccounts
const window = {
  startedAt: "2026-09-01T00:00:00.000Z",
  endedAt: "2026-09-14T00:00:00.000Z",
}
const collectedAt = "2026-09-14T09:00:00.000Z"

const firstJobs = JSON.stringify({ jobs: [
  {
    id: "platform-1",
    title: "Platform Engineer",
    department: "Infrastructure",
    location: "Berlin",
    absolute_url: "/jobs/platform-1",
    posted_at: "2026-09-10T12:00:00Z",
  },
  {
    id: "designer-1",
    title: "Product Designer",
    department: "Design",
    location: "Remote",
    absolute_url: "/jobs/designer-1",
    posted_at: "2026-09-11T12:00:00Z",
  },
] })

function careersClient(body: string): CareersHttpClient {
  return async () => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body,
  })
}

const newsClient: CompanyNewsClient = {
  async fetch(account) {
    return {
      sourceUrl: `https://${account.domains[0]}/news`,
      items: [{
        sourceUrl: `https://${account.domains[0]}/news/platform-launch`,
        canonicalUrl: `https://${account.domains[0]}/news/platform-launch`,
        title: "Northstar launches its infrastructure platform",
        excerpt: "The engineering team announced a new cloud platform for production workloads.",
        publishedAt: "2026-09-13T16:30:00Z",
        author: "Northstar Engineering",
        kind: "article" as const,
      }],
      nextCursor: null,
    }
  },
}

describe("external source boundary", () => {
  it("collects relevant first-party careers and company-news evidence", async () => {
    const result = await collectExternalSignals(
      { accounts: [northstar], window },
      {
        enabled: true,
        exaApiKey: "exa-test-key",
        careersClient: careersClient(firstJobs),
        newsClient,
        now: () => collectedAt,
        checkRobots: () => true,
        checkTerms: () => true,
      },
    )

    expect(result.status).toBe("succeeded")
    expect(result.careers.status).toBe("succeeded")
    expect(result.careers.accounts[0]).toMatchObject({
      accountName: "Northstar Labs",
      currentCount: 2,
      relevantCount: 1,
      changedCount: 2,
      baselineAvailable: false,
    })
    expect(result.careers.accounts[0].items[0]).toMatchObject({
      title: "Product Designer",
      relevant: false,
      firstObserved: true,
    })
    expect(result.careers.accounts[0].items[1]).toMatchObject({
      title: "Platform Engineer",
      relevant: true,
      firstObserved: true,
    })
    expect(result.companyNews.accounts[0]).toMatchObject({
      accountName: "Northstar Labs",
      status: "succeeded",
      articleCount: 1,
    })
    expect(result.companyNews.accounts[0].items[0]).toMatchObject({
      title: "Northstar launches its infrastructure platform",
      url: "https://northstar.example/news/platform-launch",
    })
  })

  it("uses the supplied careers cache to distinguish a later opening", async () => {
    const careersCache = new Map()
    await collectExternalSignals(
      { accounts: [northstar], window },
      {
        enabled: true,
        careersClient: careersClient(firstJobs),
        careersCache,
        now: () => collectedAt,
        checkRobots: () => true,
        checkTerms: () => true,
      },
    )

    const nextJobs = JSON.stringify({ jobs: [
      {
        id: "platform-1",
        title: "Platform Engineer",
        department: "Infrastructure",
        location: "Berlin",
        absolute_url: "/jobs/platform-1",
        posted_at: "2026-09-10T12:00:00Z",
      },
      {
        id: "security-1",
        title: "Security Engineer",
        department: "Security",
        location: "London",
        absolute_url: "/jobs/security-1",
        posted_at: "2026-09-13T12:00:00Z",
      },
    ] })
    const result = await collectExternalSignals(
      { accounts: [northstar], window },
      {
        enabled: true,
        careersClient: careersClient(nextJobs),
        careersCache,
        now: () => collectedAt,
        checkRobots: () => true,
        checkTerms: () => true,
      },
    )

    expect(result.careers.accounts[0]).toMatchObject({
      baselineAvailable: true,
      currentCount: 2,
      changedCount: 2,
    })
    expect(result.careers.accounts[0].items).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Security Engineer", change: "added", firstObserved: false, relevant: true }),
      expect.objectContaining({ title: "Product Designer", change: "removed", firstObserved: false, relevant: false }),
    ]))
  })

  it("keeps careers available while reporting missing Exa configuration", async () => {
    const result = await collectExternalSignals(
      { accounts: [northstar], window },
      {
        enabled: true,
        careersClient: careersClient(firstJobs),
        now: () => collectedAt,
        checkRobots: () => true,
        checkTerms: () => true,
      },
    )

    expect(result.status).toBe("partial")
    expect(result.careers.status).toBe("succeeded")
    expect(result.companyNews.status).toBe("unavailable")
    expect(result.companyNews.accounts[0].error).toMatchObject({ code: "missing_exa_api_key" })
  })

  it("does not fetch when external collection is disabled", async () => {
    let calls = 0
    const result = await collectExternalSignals(
      { accounts: [northstar], window },
      {
        enabled: false,
        careersClient: async () => {
          calls += 1
          return { status: 500 }
        },
        now: () => collectedAt,
      },
    )

    expect(calls).toBe(0)
    expect(result.status).toBe("unavailable")
    expect(result.limitations).toContain("External source collection is disabled by deployment configuration.")
  })

  it("accepts the full verified roster beyond the former 15-account sample", async () => {
    const accounts = Array.from({ length: 16 }, (_, index) => ({
      ...northstar,
      id: createAccountId(`sf_full_roster_${index}`),
      sourceRecordId: `sf_full_roster_${index}`,
      name: `Northstar ${index}`,
      domains: [`northstar-${index}.example`],
      careersUrl: null,
    }))
    const result = await collectExternalSignals(
      { accounts, window },
      { enabled: false, now: () => collectedAt },
    )

    expect(result.careers.accounts).toHaveLength(16)
    expect(result.companyNews.accounts).toHaveLength(16)
  })
})
