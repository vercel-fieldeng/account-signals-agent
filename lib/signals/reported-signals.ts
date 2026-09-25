import { get, put, type GetBlobResult } from "@vercel/blob"

/**
 * Private ledger of intent-signal IDs already delivered to Slack by the daily
 * brief. The brief re-queries a trailing multi-day window, so a signal that was
 * missed (blocked run, truncated result, late-loading source row) is delivered
 * on a later run, while already delivered signals are excluded.
 *
 * Delivery is at-least-once: IDs are recorded only after Slack accepts the
 * brief, so a failed recording can repeat a signal but never drops one.
 */
const LEDGER_PATH = "account-signals/private/automation/reported-signals-v1.json"
const MAX_BYTES = 256 * 1024
const MAX_RETRIES = 3
const MAX_IDS_PER_RECORD = 100
const DAY = 86_400_000
/** Must exceed the query lookback: reportedAt >= signal date, so older IDs can no longer match. */
export const REPORTED_SIGNAL_RETENTION_DAYS = 21
const SIGNAL_ID = /^[^\s,<>`*|]{1,128}$/u

export type ReportedSignalLedger = {
  schemaVersion: 1
  signals: Record<string, string>
}

type BlobSdk = { get: typeof get; put: typeof put }

export function isReportedSignalId(value: unknown): value is string {
  return typeof value === "string" && SIGNAL_ID.test(value)
}

function validLedger(value: unknown): value is ReportedSignalLedger {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  if (candidate.schemaVersion !== 1) return false
  const signals = candidate.signals
  if (typeof signals !== "object" || signals === null || Array.isArray(signals)) return false
  return Object.entries(signals).every(([id, reportedAt]) =>
    isReportedSignalId(id) && typeof reportedAt === "string" && Number.isFinite(Date.parse(reportedAt)))
}

function isConcurrency(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const candidate = error as Record<string, unknown>
  const name = typeof candidate.name === "string" ? candidate.name : ""
  const message = typeof candidate.message === "string" ? candidate.message : ""
  return name === "BlobPreconditionFailedError" || name === "BlobPathnameMismatchError" ||
    candidate.status === 412 || candidate.statusCode === 412 || /already exists|pathname mismatch/i.test(message)
}

async function readText(response: GetBlobResult): Promise<string> {
  if (response.statusCode !== 200 || !Number.isSafeInteger(response.blob.size) || response.blob.size > MAX_BYTES) {
    throw new Error("Reported signal ledger is unavailable")
  }
  return new TextDecoder().decode(await new Response(response.stream).arrayBuffer())
}

export class ReportedSignalStore {
  private readonly sdk: BlobSdk
  private readonly storeId: string | undefined
  private readonly now: () => Date

  constructor(options: { sdk?: Partial<BlobSdk>; storeId?: string; now?: () => Date } = {}) {
    this.sdk = { get, put, ...options.sdk }
    this.storeId = options.storeId ?? process.env.BLOB_STORE_ID
    this.now = options.now ?? (() => new Date())
  }

  /** IDs delivered within the retention period, oldest first. */
  async listRecent(): Promise<string[]> {
    const { ledger } = await this.load()
    return Object.entries(this.prune(ledger).signals)
      .sort(([, a], [, b]) => Date.parse(a) - Date.parse(b))
      .map(([id]) => id)
  }

  /** Records delivered IDs; invalid IDs are ignored. Returns the number of newly recorded IDs. */
  async record(ids: readonly string[]): Promise<number> {
    const unique = [...new Set(ids.filter(isReportedSignalId))].slice(0, MAX_IDS_PER_RECORD)
    if (unique.length === 0) return 0

    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      const loaded = await this.load()
      const next = this.prune(loaded.ledger)
      const reportedAt = this.now().toISOString()
      let added = 0
      for (const id of unique) {
        if (next.signals[id]) continue
        next.signals[id] = reportedAt
        added += 1
      }
      if (added === 0 && Object.keys(next.signals).length === Object.keys(loaded.ledger.signals).length) return 0

      const body = `${JSON.stringify(next)}\n`
      if (new TextEncoder().encode(body).byteLength > MAX_BYTES) throw new Error("Reported signal ledger is full")
      try {
        await this.sdk.put(LEDGER_PATH, body, {
          access: "private",
          allowOverwrite: Boolean(loaded.etag),
          addRandomSuffix: false,
          contentType: "application/json",
          ...(loaded.etag ? { ifMatch: loaded.etag } : {}),
          ...(this.storeId ? { storeId: this.storeId } : {}),
        })
        return added
      } catch (error) {
        if (isConcurrency(error) && attempt + 1 < MAX_RETRIES) continue
        throw new Error(isConcurrency(error) ? "Reported signal ledger changed concurrently" : "Unable to persist reported signal ledger")
      }
    }
    throw new Error("Reported signal ledger changed concurrently")
  }

  private prune(ledger: ReportedSignalLedger): ReportedSignalLedger {
    const cutoff = this.now().getTime() - REPORTED_SIGNAL_RETENTION_DAYS * DAY
    return {
      schemaVersion: 1,
      signals: Object.fromEntries(Object.entries(ledger.signals).filter(([, reportedAt]) => Date.parse(reportedAt) >= cutoff)),
    }
  }

  private async load(): Promise<{ ledger: ReportedSignalLedger; etag?: string }> {
    let response: GetBlobResult | null
    try {
      response = await this.sdk.get(LEDGER_PATH, { access: "private", useCache: false, ...(this.storeId ? { storeId: this.storeId } : {}) })
    } catch {
      throw new Error("Unable to read reported signal ledger")
    }
    if (!response) return { ledger: { schemaVersion: 1, signals: {} } }
    let value: unknown
    try {
      value = JSON.parse(await readText(response))
    } catch {
      throw new Error("Reported signal ledger is unavailable")
    }
    if (!validLedger(value) || !response.blob.etag?.trim()) throw new Error("Reported signal ledger is unavailable")
    return { ledger: value, etag: response.blob.etag }
  }
}

export const REPORTED_SIGNALS_PATH = LEDGER_PATH
