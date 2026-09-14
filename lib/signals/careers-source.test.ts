import { describe, expect, it } from "vitest"
import { snapshotSchema } from "./contracts"
import { collectCareers, parseCareersResponse, type CareersHttpClient, type CareersHttpRequest } from "./careers-source"
import { createAccountId } from "./stable-id"

const window = { startedAt: "2026-09-01T00:00:00.000Z", endedAt: "2026-09-14T00:00:00.000Z" }
const account = { accountId: createAccountId("sf_careers_fixture"), careersUrl: "https://jobs.example.test/api/jobs" }
const observedAt = "2026-09-14T09:00:00.000Z"

const firstFeed = JSON.stringify({ jobs: [
  { id: "eng-1", title: "Platform Engineer", department: "Infrastructure", location: "Berlin", absolute_url: "/jobs/eng-1", posted_at: "2026-09-10T12:00:00Z" },
  { id: "eng-2", title: "Product Designer", department: "Design", location: "Remote", absolute_url: "/jobs/eng-2", posted_at: "2026-09-11T12:00:00Z" },
] })

function clientFor(body: string, headers: Record<string, string> = {}) {
  return async (_request: CareersHttpRequest) => ({ status: 200, headers: { "content-type": "application/json", ...headers }, body })
}

function baseOptions(client: CareersHttpClient) {
  return {
    client,
    accounts: [account],
    window,
    now: () => observedAt,
    receivedAt: observedAt,
    retries: 0,
    sleep: async () => undefined,
  }
}

describe("careers source parser", () => {
  it("normalizes a public ATS JSON fixture", () => {
    const result = parseCareersResponse({ body: firstFeed, contentType: "application/json", url: account.careersUrl, observedAt })
    expect(result.sourceSystem).toBe("ats_feed")
    expect(result.records).toEqual([
      { jobId: "eng-1", title: "Platform Engineer", department: "Infrastructure", location: "Berlin", url: "https://jobs.example.test/jobs/eng-1", postedAt: "2026-09-10T12:00:00.000Z", observedAt },
      { jobId: "eng-2", title: "Product Designer", department: "Design", location: "Remote", url: "https://jobs.example.test/jobs/eng-2", postedAt: "2026-09-11T12:00:00.000Z", observedAt },
    ])
  })

  it("parses attributable first-party JobPosting HTML", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", identifier: { value: "html-1" }, title: "SRE", url: "/jobs/sre", datePosted: "2026-09-12", hiringOrganization: { name: "Example" } })}</script>`
    const result = parseCareersResponse({ body: html, contentType: "text/html", url: "https://example.test/careers", observedAt })
    expect(result.sourceSystem).toBe("careers_page")
    expect(result.records[0]).toMatchObject({ title: "SRE", url: "https://example.test/jobs/sre", postedAt: "2026-09-12T00:00:00.000Z" })
  })
})

describe("collectCareers", () => {
  it("emits added records and contract-valid composable snapshots", async () => {
    const result = await collectCareers(baseOptions(clientFor(firstFeed)))
    expect(result.accounts[0].changes.map((change) => change.kind)).toEqual(["added", "added"])
    expect(result.accounts[0].snapshot).not.toBeNull()
    expect(snapshotSchema.parse(result.snapshots[0]).observations).toHaveLength(2)
    expect(result.snapshots[0].observations[0].evidence[0].kind).toBe("job_posting")
  })

  it("isolates malformed content to its account", async () => {
    const result = await collectCareers({
      ...baseOptions(clientFor(firstFeed)),
      accounts: [account, { accountId: createAccountId("bad"), careersUrl: "https://bad.example.test/careers" }],
      client: async ({ url }) => url.includes("bad.example")
        ? { status: 200, headers: { "content-type": "application/json" }, body: "{not-json" }
        : { status: 200, headers: { "content-type": "application/json" }, body: firstFeed },
    })
    expect(result.accounts.map((item) => item.status)).toEqual(["succeeded", "unsupported"])
    expect(result.snapshots).toHaveLength(1)
    expect(result.errors[0].code).toBe("malformed")
  })

  it("isolates an unsupported access response to its account", async () => {
    const result = await collectCareers({
      ...baseOptions(async ({ url }) => url.includes("blocked.example") ? { status: 403 } : { status: 200, headers: { "content-type": "application/json" }, body: firstFeed }),
      accounts: [account, { accountId: createAccountId("blocked"), careersUrl: "https://blocked.example.test/careers" }],
    })
    expect(result.accounts.map((item) => item.status)).toEqual(["succeeded", "unsupported"])
    expect(result.errors[0].code).toBe("unsupported")
  })

  it("reports removed, unchanged, and added postings without losing the prior cache", async () => {
    const cache = new Map<string, { records: ReturnType<typeof parseCareersResponse>["records"] }>()
    const initial = await collectCareers({ ...baseOptions(clientFor(firstFeed)), cache })
    expect(initial.accounts[0].changes.every((change) => change.kind === "added")).toBe(true)
    const nextFeed = JSON.stringify({ jobs: [
      { id: "eng-1", title: "Platform Engineer", department: "Infrastructure", location: "Berlin", absolute_url: "/jobs/eng-1", posted_at: "2026-09-10T12:00:00Z" },
      { id: "eng-3", title: "Security Engineer", department: "Security", location: "London", absolute_url: "/jobs/eng-3", posted_at: "2026-09-13T12:00:00Z" },
    ] })
    const next = await collectCareers({ ...baseOptions(clientFor(nextFeed)), cache })
    expect(next.accounts[0].changes.map((change) => change.kind)).toEqual(["unchanged", "added", "removed"])
    expect(next.accounts[0].records.map((job) => job.jobId)).toEqual(["eng-1", "eng-3"])
  })

  it("uses conditional requests and returns unchanged cached records on 304", async () => {
    const cache = new Map<string, { etag: string; records: ReturnType<typeof parseCareersResponse>["records"] }>()
    await collectCareers({ ...baseOptions(clientFor(firstFeed, { etag: "v1" })), cache })
    let requestHeaders: Record<string, string> | undefined
    const result = await collectCareers({
      ...baseOptions(async (request) => {
        requestHeaders = request.headers
        return { status: 304, headers: { etag: "v1" } }
      }),
      cache,
    })
    expect(requestHeaders?.["If-None-Match"]).toBe("v1")
    expect(result.accounts[0].changes.every((change) => change.kind === "unchanged")).toBe(true)
    expect(result.accounts[0].records).toHaveLength(2)
  })

  it("enforces HTTPS, robots, terms, redirect, and response-size policy gates", async () => {
    await expect(collectCareers({ ...baseOptions(clientFor(firstFeed)), accounts: [{ ...account, careersUrl: "http://jobs.example.test/jobs" }] })).resolves.toMatchObject({ accounts: [expect.objectContaining({ status: "unsupported" })] })
    const blocked = await collectCareers({ ...baseOptions(clientFor(firstFeed)), checkRobots: () => false })
    expect(blocked.accounts[0].error?.message).toContain("robots")
    const termsBlocked = await collectCareers({ ...baseOptions(clientFor(firstFeed)), checkTerms: () => false })
    expect(termsBlocked.accounts[0].error?.message).toContain("terms")
    const redirected = await collectCareers({ ...baseOptions(async () => ({ status: 200, url: "https://other.example.test/jobs", body: firstFeed })), })
    expect(redirected.accounts[0].error?.message).toContain("redirect")
    const oversized = await collectCareers({ ...baseOptions(clientFor(firstFeed)), maxResponseBytes: 2 })
    expect(oversized.accounts[0].error?.message).toContain("exceeded")
  })

  it("uses Retry-After when retrying and exposes retry metadata", async () => {
    let attempts = 0
    let active = 0
    let maximum = 0
    const sleeps: number[] = []
    const result = await collectCareers({
      ...baseOptions(async () => {
        attempts += 1
        active += 1
        maximum = Math.max(maximum, active)
        await new Promise((resolve) => setTimeout(resolve, 1))
        active -= 1
        return attempts === 1 ? { status: 503, headers: { "Retry-After": "2" } as Record<string, string>, body: "" } : { status: 200, headers: { "content-type": "application/json" } as Record<string, string>, body: firstFeed }
      }),
      accounts: [account, { accountId: createAccountId("second"), careersUrl: "https://second.example.test/jobs" }],
      retries: 1,
      concurrency: 1,
      retryDelayMs: 0,
      sleep: async (milliseconds) => { sleeps.push(milliseconds) },
    })
    expect(result.accounts.every((item) => item.status === "succeeded")).toBe(true)
    expect(sleeps).toContain(2000)
    expect(attempts).toBe(3)
    expect(maximum).toBe(1)
  })
})
