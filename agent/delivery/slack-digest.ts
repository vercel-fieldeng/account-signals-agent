import { createHash } from "node:crypto"
import type { DailyDigestInput, DailyDigestRender, SlackDigestMessage } from "../../lib/signals/digest"
import { renderDailyDigest } from "../../lib/signals/digest"
import type { DailyDigestSource } from "../../lib/signals/digest"
import { sanitizeLogMessage } from "../../lib/signals/observability"

export const DEFAULT_SLACK_DIGEST_CHANNEL_ID = "C0C1GJNPV0V"
export const DEFAULT_MAX_ATTEMPTS = 3

export type SlackDigestDeliveryStatus =
  | "pending"
  | "sending"
  | "delivered"
  | "test"
  | "failed"

export type SlackDigestDeliveryRecord = {
  idempotencyKey: string
  channelId: string
  status: SlackDigestDeliveryStatus
  attempts: number
  createdAt: string
  updatedAt: string
  message?: SlackDigestMessage
  slackMessageTs?: string
  error?: { code: string; message: string; transient: boolean }
}

export type SlackPostMessageInput = {
  channelId: string
  message: SlackDigestMessage
  idempotencyKey: string
}

export type SlackPostMessageResult = { ts?: string }

/** The narrow connector boundary. Production code can adapt Eve's Slack client to this interface. */
export interface SlackDigestClient {
  postMessage(input: SlackPostMessageInput): Promise<SlackPostMessageResult>
}

export type SlackDigestDeliveryClaim = {
  claimed: boolean
  record: SlackDigestDeliveryRecord
}

export interface SlackDigestDeliveryStore {
  get(idempotencyKey: string): SlackDigestDeliveryRecord | undefined
  save(record: SlackDigestDeliveryRecord): void
  /**
   * Atomically claims a pending/new delivery, or returns the current record.
   * Durable implementations must back this with a database CAS/transaction;
   * get-then-save is not safe when multiple workers deliver the same key.
   */
  claimOrGet(record: SlackDigestDeliveryRecord): SlackDigestDeliveryClaim
}

export class InMemorySlackDigestDeliveryStore implements SlackDigestDeliveryStore {
  private readonly records = new Map<string, SlackDigestDeliveryRecord>()

  get(idempotencyKey: string) {
    const record = this.records.get(idempotencyKey)
    return record && structuredClone(record)
  }

  save(record: SlackDigestDeliveryRecord) {
    this.records.set(record.idempotencyKey, structuredClone(record))
  }

  claimOrGet(record: SlackDigestDeliveryRecord): SlackDigestDeliveryClaim {
    const existing = this.records.get(record.idempotencyKey)
    if (existing && existing.status !== "pending") {
      return { claimed: false, record: structuredClone(existing) }
    }
    const claimed = { ...record, status: "sending" as const }
    this.records.set(record.idempotencyKey, structuredClone(claimed))
    return { claimed: true, record: structuredClone(claimed) }
  }
}

export type SlackDigestDeliveryOptions = {
  client: SlackDigestClient
  store: SlackDigestDeliveryStore
  allowedChannelId?: string
  now?: () => string
  maxAttempts?: number
  sleep?: (milliseconds: number) => Promise<void>
  retryDelayMs?: number | ((attempt: number) => number)
}

export type DeliverSlackDigestRequest = {
  digest: DailyDigestSource | DailyDigestInput
  channelId: string
  idempotencyKey?: string
  testMode?: boolean
}

export type SlackDigestDeliveryResult = {
  record: SlackDigestDeliveryRecord
  render: DailyDigestRender
  duplicate: boolean
}

function errorDetails(error: unknown, fallbackCode: string) {
  if (typeof error === "object" && error !== null) {
    const candidate = error as {
      code?: unknown
      message?: unknown
      transient?: unknown
      status?: unknown
      statusCode?: unknown
    }
    const status = candidate.status ?? candidate.statusCode
    const transient = candidate.transient === true ||
      (typeof status === "number" && (status === 429 || status >= 500))
    return {
      code: sanitizeLogMessage(typeof candidate.code === "string" ? candidate.code : fallbackCode),
      message: sanitizeLogMessage(typeof candidate.message === "string" ? candidate.message : String(error)),
      transient,
    }
  }
  return { code: sanitizeLogMessage(fallbackCode), message: sanitizeLogMessage(String(error)), transient: false }
}

export function createSlackDigestIdempotencyKey(
  digest: DailyDigestSource | DailyDigestInput,
  channelId: string,
): string {
  const source = "digest" in digest ? digest.digest : digest
  const identity = [
    channelId,
    source.generatedAt,
    source.windowStartedAt,
    source.windowEndedAt,
  ].join("\u0000")
  return `slack_digest_${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`
}

function update(
  store: SlackDigestDeliveryStore,
  record: SlackDigestDeliveryRecord,
  now: () => string,
  changes: Partial<SlackDigestDeliveryRecord>,
) {
  const next = { ...record, ...changes, updatedAt: now() }
  store.save(next)
  return next
}

export async function deliverSlackDigest(
  request: DeliverSlackDigestRequest,
  options: SlackDigestDeliveryOptions,
): Promise<SlackDigestDeliveryResult> {
  const now = options.now ?? (() => new Date().toISOString())
  const allowedChannelId = options.allowedChannelId ?? DEFAULT_SLACK_DIGEST_CHANNEL_ID
  const key = request.idempotencyKey ?? createSlackDigestIdempotencyKey(request.digest, request.channelId)
  const renderInput = "digest" in request.digest ? request.digest : { digest: request.digest }
  const render = renderDailyDigest(renderInput)
  const existing = options.store.get(key)

  if (existing?.status === "delivered" || existing?.status === "test" || existing?.status === "failed" || existing?.status === "sending") {
    return { record: existing, render, duplicate: true }
  }

  const initial: SlackDigestDeliveryRecord = existing ?? {
    idempotencyKey: key,
    channelId: request.channelId,
    status: "pending",
    attempts: 0,
    createdAt: now(),
    updatedAt: now(),
  }
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("maxAttempts must be a positive integer")
  }
  const claim = options.store.claimOrGet(initial)
  if (!claim.claimed) return { record: claim.record, render, duplicate: true }
  let record = claim.record

  if (request.channelId !== allowedChannelId) {
    const error = {
      code: "channel_not_allowed",
      message: `Slack digest delivery is only allowed to channel ${allowedChannelId}`,
      transient: false,
    }
    record = update(options.store, record, now, { status: "failed", error })
    return { record, render, duplicate: false }
  }

  if (request.testMode) {
    record = update(options.store, record, now, {
      status: "test",
      message: render.slack,
    })
    return { record, render, duplicate: false }
  }

  const sleep = options.sleep ?? (async () => undefined)

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    record = update(options.store, record, now, {
      status: "sending",
      attempts: attempt,
      message: render.slack,
      error: undefined,
    })
    try {
      const response = await options.client.postMessage({
        channelId: request.channelId,
        message: render.slack,
        idempotencyKey: key,
      })
      record = update(options.store, record, now, {
        status: "delivered",
        slackMessageTs: response.ts,
      })
      return { record, render, duplicate: false }
    } catch (error) {
      const details = errorDetails(error, "slack_post_failed")
      if (!details.transient || attempt === maxAttempts) {
        record = update(options.store, record, now, { status: "failed", error: details })
        return { record, render, duplicate: false }
      }
      // Keep the claim in `sending` during backoff so another worker cannot post concurrently.
      record = update(options.store, record, now, { status: "sending", error: details })
      const delay = typeof options.retryDelayMs === "function"
        ? options.retryDelayMs(attempt)
        : options.retryDelayMs ?? 0
      await sleep(delay)
    }
  }

  throw new Error("Unreachable Slack digest delivery state")
}

export const sendSlackDigest = deliverSlackDigest
