import { describe, expect, it } from "vitest"
import { readExternalSourceCache, writeExternalSourceCache } from "./external-source-cache"

const record = {
  jobId: "job-1",
  title: "Platform Engineer",
  department: "Infrastructure",
  location: "Berlin",
  url: "https://jobs.example.test/jobs/job-1",
  postedAt: "2026-09-10T12:00:00.000Z",
  observedAt: "2026-09-14T09:00:00.000Z",
}

describe("external source cache", () => {
  it("round-trips careers records through the private state boundary", async () => {
    let body = ""
    let writeOptions: Record<string, unknown> | undefined
    const sdk = {
      async get() {
        if (!body) return null
        return {
          statusCode: 200,
          blob: { size: new TextEncoder().encode(body).byteLength, etag: "etag-1" },
          stream: new Response(body).body!,
        }
      },
      async put(_path: string, value: string, options: Record<string, unknown>) {
        body = value
        writeOptions = options
        return {}
      },
    } as never

    const cache = new Map([["https://jobs.example.test/careers", { etag: "job-etag", records: [record] }]])
    await writeExternalSourceCache(cache, undefined, sdk)
    const loaded = await readExternalSourceCache(sdk)

    expect(writeOptions).toMatchObject({ access: "private", allowOverwrite: false, addRandomSuffix: false })
    expect(loaded.etag).toBe("etag-1")
    expect(loaded.careers.get("https://jobs.example.test/careers")).toEqual(cache.get("https://jobs.example.test/careers"))
  })
})
