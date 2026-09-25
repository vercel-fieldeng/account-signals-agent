import { describe, expect, it } from "vitest"
import { REPORTED_SIGNALS_PATH, ReportedSignalStore } from "./reported-signals"

type Fixture = {
  body?: string
  etag: string
  puts: Record<string, unknown>[]
  failGet?: boolean
  conflictsRemaining?: number
}

function sdk(store: Fixture) {
  return {
    get: async (path: string) => {
      expect(path).toBe(REPORTED_SIGNALS_PATH)
      if (store.failGet) throw new Error("private backend failure")
      if (!store.body) return null
      const bytes = new TextEncoder().encode(store.body)
      return {
        statusCode: 200 as const,
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes)
            controller.close()
          },
        }),
        headers: new Headers(),
        blob: { pathname: path, etag: store.etag, size: bytes.byteLength, contentType: "application/json" },
      } as never
    },
    put: async (path: string, body: unknown, options: unknown) => {
      expect(path).toBe(REPORTED_SIGNALS_PATH)
      const putOptions = options as Record<string, unknown>
      store.puts.push(putOptions)
      if (store.conflictsRemaining) {
        store.conflictsRemaining -= 1
        const error = new Error("conflict")
        error.name = "BlobPreconditionFailedError"
        throw error
      }
      store.body = String(body)
      store.etag = `etag-${store.puts.length}`
      return {} as never
    },
  }
}

function ledger(fixture: Fixture, now: string) {
  return new ReportedSignalStore({ sdk: sdk(fixture), storeId: "test-store", now: () => new Date(now) })
}

describe("reported signal ledger", () => {
  it("starts empty and records delivered IDs privately without overwriting blindly", async () => {
    const fixture: Fixture = { etag: "etag-0", puts: [] }
    const store = ledger(fixture, "2026-09-25T06:05:00.000Z")
    expect(await store.listRecent()).toEqual([])
    expect(await store.record(["sig-1", "sig-2", "sig-1", "bad id"])).toBe(2)
    expect(fixture.puts[0]).toMatchObject({ access: "private", allowOverwrite: false, addRandomSuffix: false, storeId: "test-store" })
    expect(fixture.puts[0]).not.toHaveProperty("ifMatch")
    expect(await store.listRecent()).toEqual(["sig-1", "sig-2"])
  })

  it("is idempotent and uses the current ETag for later writes", async () => {
    const fixture: Fixture = { etag: "etag-0", puts: [] }
    await ledger(fixture, "2026-09-24T06:05:00.000Z").record(["sig-1"])
    const store = ledger(fixture, "2026-09-25T06:05:00.000Z")
    expect(await store.record(["sig-1"])).toBe(0)
    expect(fixture.puts).toHaveLength(1)
    expect(await store.record(["sig-3"])).toBe(1)
    expect(fixture.puts[1]).toMatchObject({ allowOverwrite: true, ifMatch: "etag-1" })
    expect(await store.listRecent()).toEqual(["sig-1", "sig-3"])
  })

  it("prunes IDs older than the retention period, which exceeds the query lookback", async () => {
    const fixture: Fixture = {
      etag: "etag-0",
      puts: [],
      body: JSON.stringify({ schemaVersion: 1, signals: { old: "2026-09-01T06:00:00.000Z", recent: "2026-09-20T06:00:00.000Z" } }),
    }
    const store = ledger(fixture, "2026-09-25T06:05:00.000Z")
    expect(await store.listRecent()).toEqual(["recent"])
    await store.record(["new"])
    expect(JSON.parse(fixture.body!).signals).toEqual({ recent: "2026-09-20T06:00:00.000Z", new: "2026-09-25T06:05:00.000Z" })
  })

  it("retries a concurrent write and fails closed on malformed or unreadable state", async () => {
    const racing: Fixture = { etag: "etag-0", puts: [], conflictsRemaining: 1, body: JSON.stringify({ schemaVersion: 1, signals: {} }) }
    expect(await ledger(racing, "2026-09-25T06:05:00.000Z").record(["sig-1"])).toBe(1)
    expect(racing.puts).toHaveLength(2)

    const malformed: Fixture = { etag: "etag-0", puts: [], body: JSON.stringify({ schemaVersion: 2, signals: [] }) }
    await expect(ledger(malformed, "2026-09-25T06:05:00.000Z").listRecent()).rejects.toThrow("unavailable")
    await expect(ledger(malformed, "2026-09-25T06:05:00.000Z").record(["sig-1"])).rejects.toThrow("unavailable")
    expect(malformed.puts).toHaveLength(0)

    const down: Fixture = { etag: "etag-0", puts: [], failGet: true }
    await expect(ledger(down, "2026-09-25T06:05:00.000Z").listRecent()).rejects.toThrow("Unable to read reported signal ledger")
  })
})
