import { describe, expect, it } from "vitest"
import { redactedAccounts, redactedRunResult } from "./redacted-fixtures"
import {
  BLOB_SIGNAL_STATE_PATH,
  BlobSignalRepository,
  BlobSignalRepositoryConflictError,
  type BlobSignalRepositoryOptions,
} from "./blob-storage"

type BlobFixture = {
  body: string
  etag: string
  getOptions: Array<Record<string, unknown>>
  putOptions: Array<Record<string, unknown>>
  conflictOnNextPut?: boolean
  missingReads?: number
}

function fixture(initial?: string): BlobFixture {
  return { body: initial ?? "", etag: "etag-0", getOptions: [], putOptions: [] }
}

function sdk(store: BlobFixture) {
  return {
    get: async (_path: string, options: unknown) => {
      store.getOptions.push(options as Record<string, unknown>)
      if (store.missingReads && store.missingReads > 0) {
        store.missingReads--
        return null
      }
      if (!store.body) return null
      const body = new TextEncoder().encode(store.body)
      return {
        statusCode: 200 as const,
        stream: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(body); controller.close() } }),
        headers: new Headers(),
        blob: {
          url: "https://private.invalid/ignored",
          downloadUrl: "https://private.invalid/ignored",
          pathname: BLOB_SIGNAL_STATE_PATH,
          contentDisposition: "inline",
          cacheControl: "no-store",
          uploadedAt: new Date(0),
          etag: store.etag,
          contentType: "application/json",
          size: body.byteLength,
        },
      }
    },
    put: async (path: string, body: unknown, options: unknown) => {
      const putOptions = options as Record<string, unknown>
      store.putOptions.push(putOptions)
      if (path !== BLOB_SIGNAL_STATE_PATH) throw new Error("wrong path")
      if (store.conflictOnNextPut) {
        store.conflictOnNextPut = false
        const error = new Error("precondition")
        error.name = "BlobPreconditionFailedError"
        throw error
      }
      if (putOptions.ifMatch !== undefined && putOptions.ifMatch !== store.etag) throw new Error("precondition")
      if (putOptions.ifMatch === undefined && store.body) {
        const error = new Error("Blob already exists")
        error.name = "BlobPathnameMismatchError"
        throw error
      }
      store.body = String(body)
      store.etag = `etag-${store.putOptions.length}`
      return { etag: store.etag, pathname: path } as never
    },
  }
}

function options(store: BlobFixture): BlobSignalRepositoryOptions {
  return { storeId: "store-fixture", sdk: sdk(store) }
}

describe("BlobSignalRepository", () => {
  it("initializes private origin state and survives restart", async () => {
    const store = fixture()
    const first = new BlobSignalRepository(options(store))
    expect((await first.read()).listRuns()).toEqual([])
    expect(store.getOptions[0]).toMatchObject({ access: "private", useCache: false, storeId: "store-fixture" })
    expect(store.putOptions).toEqual([])

    await first.transaction((repository) => repository.saveRun(redactedRunResult))
    expect(store.putOptions[0]).toMatchObject({
      access: "private",
      allowOverwrite: false,
      addRandomSuffix: false,
      storeId: "store-fixture",
    })
    await first.transaction((repository) => repository.saveAccount(redactedAccounts[1]))
    expect(store.putOptions[1]).toMatchObject({
      access: "private",
      allowOverwrite: true,
      addRandomSuffix: false,
      ifMatch: "etag-1",
      storeId: "store-fixture",
    })
    const restarted = new BlobSignalRepository(options(store))
    const baseline = (await restarted.read()).getPreviousSuccessfulBaseline(redactedAccounts[0].id)
    expect(baseline?.run.id).toBe(redactedRunResult.id)
    expect((await restarted.read()).getAccount(redactedAccounts[1].id)).toEqual(redactedAccounts[1])
  })

  it("retains failed runs without promoting their signals", async () => {
    const store = fixture()
    const repository = new BlobSignalRepository(options(store))
    const failedRun = {
      ...redactedRunResult,
      id: `${redactedRunResult.id.slice(0, -1)}0`,
      status: "failed" as const,
      errors: [{ source: "manual" as const, code: "SOURCE_UNAVAILABLE", message: "outage", retryable: true }],
    }
    await repository.transaction((current) => current.saveRun(failedRun))
    const reloaded = await repository.read()
    expect(reloaded.getRun(failedRun.id)?.status).toBe("failed")
    expect(reloaded.listSignals({ runId: failedRun.id })).toEqual([])
  })

  it("restores a valid source baseline even when Slack delivery failed", async () => {
    const store = fixture()
    const deliveryFailure = {
      ...redactedRunResult,
      status: "partial" as const,
      errors: [{ source: null, code: "slack_delivery_failed", message: "Delivery failed", retryable: true }],
    }
    await new BlobSignalRepository(options(store)).transaction((repository) => repository.saveRun(deliveryFailure))
    const restarted = await new BlobSignalRepository(options(store)).read()
    expect(restarted.getPreviousSuccessfulBaseline(redactedAccounts[0].id)?.run.id).toBe(deliveryFailure.id)
  })

  it("rejects malformed state without replacing it or exposing its payload", async () => {
    const secret = "fixture-secret-value"
    const store = fixture(JSON.stringify({ storageVersion: 1, accounts: [{ secret }] }))
    const repository = new BlobSignalRepository(options(store))
    await expect(repository.read()).rejects.toThrow("Malformed signal repository state")
    await expect(repository.read()).rejects.not.toThrow(secret)
    expect(store.putOptions).toEqual([])
  })

  it("fails cleanly on an ETag conflict", async () => {
    const store = fixture()
    const repository = new BlobSignalRepository(options(store))
    await repository.read()
    store.conflictOnNextPut = true
    await expect(repository.transaction((current) => current.saveAccount(redactedAccounts[0]))).rejects.toBeInstanceOf(
      BlobSignalRepositoryConflictError,
    )
  })

  it("does not create on read and detects concurrent initialization", async () => {
    const store = fixture()
    const first = new BlobSignalRepository(options(store))
    const second = new BlobSignalRepository(options(store))
    await first.read()
    await second.read()
    expect(store.putOptions).toEqual([])

    store.missingReads = 2
    await first.transaction((current) => current.saveAccount(redactedAccounts[0]))
    await expect(second.transaction((current) => current.saveAccount(redactedAccounts[1]))).rejects.toBeInstanceOf(
      BlobSignalRepositoryConflictError,
    )
    expect(store.putOptions[1]).toMatchObject({ allowOverwrite: false, addRandomSuffix: false })
  })

  it("rejects an existing blob with a missing ETag instead of overwriting it", async () => {
    const store = fixture()
    await new BlobSignalRepository(options(store)).transaction((current) => current.listRuns().length)
    store.etag = ""
    store.putOptions.length = 0
    const repository = new BlobSignalRepository(options(store))
    await expect(repository.transaction((current) => current.listRuns().length)).rejects.toThrow("no usable ETag")
    expect(store.putOptions).toEqual([])
  })

  it("always reads private state from origin and bounds oversized responses", async () => {
    const store = fixture()
    const repository = new BlobSignalRepository({ ...options(store), maxBytes: 8 })
    await repository.read()
    store.body = "x".repeat(9)
    await expect(repository.read()).rejects.toThrow("size limit")
    expect(store.putOptions).toEqual([])
    expect(store.getOptions.every((entry) => entry.access === "private" && entry.useCache === false)).toBe(true)
  })
})
