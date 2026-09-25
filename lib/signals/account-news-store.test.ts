import { describe, expect, it, vi } from "vitest"
import { emptyNewsState, type NewsMonitorState } from "./account-news"
import { BlobNewsStateStore, NEWS_STATE_PATH, NEWS_WATCHLIST_PATH, NewsWatchlistStore } from "./account-news-store"

function blob(value: unknown, etag = "\"etag-1\"") {
  const body = typeof value === "string" ? value : JSON.stringify(value)
  return {
    statusCode: 200,
    blob: { size: new TextEncoder().encode(body).byteLength, etag },
    stream: new Response(body).body,
  }
}

function sdk(stored: unknown) {
  const get = vi.fn(async () => (stored === null ? null : blob(stored)))
  const put = vi.fn(async () => ({}))
  return { get: get as never, put: put as never, calls: { get, put } }
}

const watchlist = { schemaVersion: 1, accounts: [{ name: "Acme Energy GmbH", searchName: "Acme Energy" }] }

describe("account news blob stores", () => {
  it("returns null for a missing watchlist and rejects an invalid one", async () => {
    expect(await new NewsWatchlistStore({ sdk: sdk(null), storeId: "store" }).load()).toBeNull()
    await expect(new NewsWatchlistStore({ sdk: sdk({ schemaVersion: 1, accounts: [] }), storeId: "store" }).load()).rejects.toThrow()
    const loaded = await new NewsWatchlistStore({ sdk: sdk(watchlist), storeId: "store" }).load()
    expect(loaded?.accounts[0]).toMatchObject({ name: "Acme Energy GmbH", aliases: [], excludeOwnDomain: false })
  })

  it("replaces the watchlist privately after validation", async () => {
    const fake = sdk(null)
    await new NewsWatchlistStore({ sdk: fake, storeId: "store" }).replace(watchlist as never)
    expect(fake.calls.put).toHaveBeenCalledWith(NEWS_WATCHLIST_PATH, expect.any(String), expect.objectContaining({ access: "private", allowOverwrite: true, storeId: "store" }))
  })

  it("loads state with its etag, starts empty, and saves conditionally", async () => {
    const state: NewsMonitorState = {
      schemaVersion: 1,
      items: { "news:0123456789abcdef": { account: "Acme Energy GmbH", title: "t", url: "https://n.example/a", publisher: "n.example", publishedAt: null, firstSeenAt: "2026-09-26T06:00:00.000Z", verdict: "neutral" } },
    }
    const fake = sdk(state)
    const store = new BlobNewsStateStore({ sdk: fake, storeId: "store" })
    const loaded = await store.load()
    expect(loaded).toEqual({ state, etag: "\"etag-1\"" })
    await store.save(loaded.state, loaded.etag)
    expect(fake.calls.put).toHaveBeenCalledWith(NEWS_STATE_PATH, expect.any(String), expect.objectContaining({ access: "private", ifMatch: "\"etag-1\"", allowOverwrite: true }))

    expect(await new BlobNewsStateStore({ sdk: sdk(null), storeId: "store" }).load()).toEqual({ state: emptyNewsState() })
    await expect(new BlobNewsStateStore({ sdk: sdk({ schemaVersion: 1, items: { bad: {} } }), storeId: "store" }).load()).rejects.toThrow("unavailable")
  })

  it("refuses to write state beyond its size limit", async () => {
    const huge: NewsMonitorState = { schemaVersion: 1, items: {} }
    for (let index = 0; index < 9000; index += 1) {
      huge.items[`news:${index.toString(16).padStart(16, "0")}`] = { account: "A", title: "x".repeat(200), url: `https://n.example/${index}`, publisher: "n.example", publishedAt: null, firstSeenAt: "2026-09-26T06:00:00.000Z", verdict: "neutral" }
    }
    const fake = sdk(null)
    await expect(new BlobNewsStateStore({ sdk: fake, storeId: "store" }).save(huge)).rejects.toThrow("size limit")
    expect(fake.calls.put).not.toHaveBeenCalled()
  })
})
