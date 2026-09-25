import { get, put, type GetBlobResult } from "@vercel/blob"
import {
  emptyNewsState,
  isNewsMonitorState,
  newsWatchlistSchema,
  type NewsMonitorState,
  type NewsStateStore,
  type NewsWatchlist,
} from "./account-news"

/** Private Blob documents for the account news monitor. Customer names never live in the repository. */
export const NEWS_WATCHLIST_PATH = "account-signals/private/automation/news-watchlist-v1.json"
export const NEWS_STATE_PATH = "account-signals/private/automation/news-monitor-state-v1.json"
const MAX_WATCHLIST_BYTES = 256 * 1024
const MAX_STATE_BYTES = 2 * 1024 * 1024

type BlobSdk = { get: typeof get; put: typeof put }
type StoreOptions = { sdk?: Partial<BlobSdk>; storeId?: string }

class PrivateJsonDocument {
  private readonly sdk: BlobSdk
  private readonly storeId: string | undefined

  constructor(private readonly path: string, private readonly maxBytes: number, options: StoreOptions = {}) {
    this.sdk = { get, put, ...options.sdk }
    this.storeId = options.storeId ?? process.env.BLOB_STORE_ID
  }

  async read(): Promise<{ value: unknown; etag?: string } | null> {
    let response: GetBlobResult | null
    try {
      response = await this.sdk.get(this.path, { access: "private", useCache: false, ...(this.storeId ? { storeId: this.storeId } : {}) })
    } catch {
      throw new Error(`Unable to read ${this.path}`)
    }
    if (!response) return null
    if (response.statusCode !== 200 || !Number.isSafeInteger(response.blob.size) || response.blob.size > this.maxBytes) {
      throw new Error(`${this.path} is unavailable`)
    }
    const text = new TextDecoder().decode(await new Response(response.stream).arrayBuffer())
    try {
      return { value: JSON.parse(text), etag: response.blob.etag || undefined }
    } catch {
      throw new Error(`${this.path} is not valid JSON`)
    }
  }

  async write(value: unknown, etag?: string): Promise<void> {
    const body = `${JSON.stringify(value)}\n`
    if (new TextEncoder().encode(body).byteLength > this.maxBytes) throw new Error(`${this.path} exceeds its size limit`)
    await this.sdk.put(this.path, body, {
      access: "private",
      allowOverwrite: Boolean(etag) || this.path === NEWS_WATCHLIST_PATH,
      addRandomSuffix: false,
      contentType: "application/json",
      ...(etag ? { ifMatch: etag } : {}),
      ...(this.storeId ? { storeId: this.storeId } : {}),
    })
  }
}

export class NewsWatchlistStore {
  private readonly document: PrivateJsonDocument

  constructor(options: StoreOptions = {}) {
    this.document = new PrivateJsonDocument(NEWS_WATCHLIST_PATH, MAX_WATCHLIST_BYTES, options)
  }

  /** Null when no watchlist has been seeded; throws when it exists but is invalid. */
  async load(): Promise<NewsWatchlist | null> {
    const loaded = await this.document.read()
    if (!loaded) return null
    return newsWatchlistSchema.parse(loaded.value)
  }

  async replace(watchlist: NewsWatchlist): Promise<void> {
    await this.document.write(newsWatchlistSchema.parse(watchlist))
  }
}

export class BlobNewsStateStore implements NewsStateStore {
  private readonly document: PrivateJsonDocument

  constructor(options: StoreOptions = {}) {
    this.document = new PrivateJsonDocument(NEWS_STATE_PATH, MAX_STATE_BYTES, options)
  }

  async load(): Promise<{ state: NewsMonitorState; etag?: string }> {
    const loaded = await this.document.read()
    if (!loaded) return { state: emptyNewsState() }
    if (!isNewsMonitorState(loaded.value) || !loaded.etag) throw new Error("News monitor state is unavailable")
    return { state: loaded.value, etag: loaded.etag }
  }

  /** ETag-conditional: a concurrent scan's newer state is never overwritten. */
  async save(state: NewsMonitorState, etag?: string): Promise<void> {
    await this.document.write(state, etag)
  }
}
