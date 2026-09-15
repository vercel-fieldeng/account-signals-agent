import { get, put, type GetBlobResult } from "@vercel/blob"
import type { CareerJob, CareersCacheEntry } from "./careers-source"

const CACHE_PATH = "account-signals/private/external-source-cache-v1.json"
const CACHE_VERSION = 1 as const
const MAX_BYTES = 2 * 1024 * 1024

export type ExternalSourceCacheState = {
  careers: Map<string, CareersCacheEntry>
  etag?: string
}

type PersistedState = {
  cacheVersion: typeof CACHE_VERSION
  careers: Record<string, CareersCacheEntry>
}

type BlobSdk = {
  get: typeof get
  put: typeof put
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validJob(value: unknown): value is CareerJob {
  if (!record(value)) return false
  return (
    typeof value.jobId === "string" && value.jobId.length > 0 &&
    typeof value.title === "string" && value.title.length > 0 &&
    (value.department === null || typeof value.department === "string") &&
    (value.location === null || typeof value.location === "string") &&
    typeof value.url === "string" && value.url.length > 0 &&
    (value.postedAt === null || typeof value.postedAt === "string") &&
    typeof value.observedAt === "string" && !Number.isNaN(Date.parse(value.observedAt))
  )
}

function validEntry(value: unknown): value is CareersCacheEntry {
  if (!record(value) || !Array.isArray(value.records) || !value.records.every(validJob)) return false
  return (
    (value.etag === undefined || typeof value.etag === "string") &&
    (value.lastModified === undefined || typeof value.lastModified === "string")
  )
}

function parseState(value: unknown): Map<string, CareersCacheEntry> {
  if (!record(value) || value.cacheVersion !== CACHE_VERSION || !record(value.careers)) {
    throw new Error("Malformed external source cache")
  }
  const careers = new Map<string, CareersCacheEntry>()
  for (const [url, entry] of Object.entries(value.careers)) {
    if (!url || !validEntry(entry)) throw new Error("Malformed external source cache")
    careers.set(url, entry)
  }
  return careers
}

async function readBody(response: GetBlobResult): Promise<string> {
  if (response.statusCode !== 200 || !Number.isSafeInteger(response.blob.size) || response.blob.size > MAX_BYTES) {
    throw new Error("External source cache is unavailable")
  }
  const reader = response.stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      total += part.value.byteLength
      if (total > MAX_BYTES) throw new Error("External source cache exceeds the size limit")
      chunks.push(part.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function options(etag: string | undefined, storeId: string | undefined) {
  return {
    access: "private" as const,
    addRandomSuffix: false,
    allowOverwrite: Boolean(etag),
    contentType: "application/json",
    ...(etag ? { ifMatch: etag } : {}),
    ...(storeId ? { storeId } : {}),
  }
}

function bodyFor(cache: Map<string, CareersCacheEntry>): string {
  const body = `${JSON.stringify({ cacheVersion: CACHE_VERSION, careers: Object.fromEntries(cache) } satisfies PersistedState)}\n`
  if (new TextEncoder().encode(body).byteLength > MAX_BYTES) throw new Error("External source cache exceeds the size limit")
  return body
}

export async function readExternalSourceCache(sdk: Partial<BlobSdk> = {}): Promise<ExternalSourceCacheState> {
  const client = { get, put, ...sdk }
  const storeId = process.env.BLOB_STORE_ID
  const response = await client.get(CACHE_PATH, { access: "private", useCache: false, ...(storeId ? { storeId } : {}) })
  if (!response) return { careers: new Map() }
  const parsed = JSON.parse(await readBody(response)) as unknown
  return { careers: parseState(parsed), etag: response.blob.etag }
}

export async function writeExternalSourceCache(
  cache: Map<string, CareersCacheEntry>,
  etag: string | undefined,
  sdk: Partial<BlobSdk> = {},
): Promise<void> {
  const client = { get, put, ...sdk }
  const storeId = process.env.BLOB_STORE_ID
  await client.put(CACHE_PATH, bodyFor(cache), options(etag, storeId))
}

export const EXTERNAL_SOURCE_CACHE_PATH = CACHE_PATH
