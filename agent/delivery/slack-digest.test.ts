import { describe, expect, it } from "vitest"
import { createSignalDigest } from "../../lib/signals/normalize"
import { redactedSignals } from "../../lib/signals/redacted-fixtures"
import {
  DEFAULT_SLACK_DIGEST_CHANNEL_ID,
  InMemorySlackDigestDeliveryStore,
  deliverSlackDigest,
  type SlackDigestClient,
  type SlackPostMessageInput,
} from "./slack-digest"

const digest = createSignalDigest(
  redactedSignals,
  "2026-09-13T09:00:00.000Z",
  "2026-09-14T09:00:00.000Z",
  "2026-09-14T09:00:01.000Z",
)

function client(value: SlackDigestClient): SlackDigestClient {
  return value
}

function options(client: SlackDigestClient, store = new InMemorySlackDigestDeliveryStore()) {
  return {
    client,
    store,
    allowedChannelId: DEFAULT_SLACK_DIGEST_CHANNEL_ID,
    now: () => "2026-09-14T10:00:00.000Z",
  }
}

describe("scheduled Slack digest delivery", () => {
  it("delivers the rendered digest successfully", async () => {
    const posts: SlackPostMessageInput[] = []
    const result = await deliverSlackDigest(
      { digest, channelId: DEFAULT_SLACK_DIGEST_CHANNEL_ID },
      options(client({ postMessage: async (input) => { posts.push(input); return { ts: "1.1" } } })),
    )

    expect(result.record.status).toBe("delivered")
    expect(result.record.attempts).toBe(1)
    expect(result.record.slackMessageTs).toBe("1.1")
    expect(posts).toHaveLength(1)
    expect(posts[0].message).toEqual(result.render.slack)
    expect(posts[0].idempotencyKey).toBe(result.record.idempotencyKey)
  })

  it("retries transient failures with the same key and posts only once successfully", async () => {
    const posts: SlackPostMessageInput[] = []
    let calls = 0
    const result = await deliverSlackDigest(
      { digest, channelId: DEFAULT_SLACK_DIGEST_CHANNEL_ID },
      {
        ...options(client({
          postMessage: async (input) => {
            posts.push(input)
            calls++
            if (calls === 1) {
              const error = Object.assign(new Error("rate limited"), { transient: true, code: "rate_limited" })
              throw error
            }
            return { ts: "2.2" }
          },
        })),
        maxAttempts: 2,
      },
    )

    expect(result.record.status).toBe("delivered")
    expect(result.record.attempts).toBe(2)
    expect(posts).toHaveLength(2)
    expect(posts[0].idempotencyKey).toBe(posts[1].idempotencyKey)
  })

  it("atomically claims a delivery so concurrent workers post only once", async () => {
    const store = new InMemorySlackDigestDeliveryStore()
    let calls = 0
    let releasePost!: () => void
    const postStarted = new Promise<void>((resolve) => {
      releasePost = resolve
    })
    const deliveryOptions = options(client({
      postMessage: async () => {
        calls++
        await postStarted
        return { ts: "concurrent.1" }
      },
    }), store)
    const request = { digest, channelId: DEFAULT_SLACK_DIGEST_CHANNEL_ID }

    const firstPromise = deliverSlackDigest(request, deliveryOptions)
    await Promise.resolve()
    const second = await deliverSlackDigest(request, deliveryOptions)
    releasePost()
    const first = await firstPromise

    expect(calls).toBe(1)
    expect(second.duplicate).toBe(true)
    expect(second.record.status).toBe("sending")
    expect(first.record.status).toBe("delivered")
  })

  it("does not post again when the same delivery is replayed", async () => {
    let calls = 0
    const store = new InMemorySlackDigestDeliveryStore()
    const deliveryOptions = options(client({
      postMessage: async () => { calls++; return { ts: "3.3" } },
    }), store)
    const request = { digest, channelId: DEFAULT_SLACK_DIGEST_CHANNEL_ID }

    const first = await deliverSlackDigest(request, deliveryOptions)
    const second = await deliverSlackDigest(request, deliveryOptions)

    expect(first.record.idempotencyKey).toBe(second.record.idempotencyKey)
    expect(second.duplicate).toBe(true)
    expect(calls).toBe(1)
  })

  it("records a permanent error and never calls Slack for a wrong channel", async () => {
    let calls = 0
    const result = await deliverSlackDigest(
      { digest, channelId: "C-not-allowlisted" },
      options(client({ postMessage: async () => { calls++; return {} } })),
    )

    expect(result.record.status).toBe("failed")
    expect(result.record.error).toMatchObject({ code: "channel_not_allowed", transient: false })
    expect(calls).toBe(0)
  })

  it("renders and records test mode without calling Slack", async () => {
    let calls = 0
    const result = await deliverSlackDigest(
      { digest, channelId: DEFAULT_SLACK_DIGEST_CHANNEL_ID, testMode: true },
      options(client({ postMessage: async () => { calls++; return {} } })),
    )

    expect(result.record.status).toBe("test")
    expect(result.record.message).toEqual(result.render.slack)
    expect(calls).toBe(0)
  })

  it("records a permanent Slack error without retrying", async () => {
    let calls = 0
    const result = await deliverSlackDigest(
      { digest, channelId: DEFAULT_SLACK_DIGEST_CHANNEL_ID },
      options(client({
        postMessage: async () => {
          calls++
          throw Object.assign(new Error("invalid_auth token=super-secret-value"), { code: "invalid_auth" })
        },
      })),
    )

    expect(result.record.status).toBe("failed")
    expect(result.record.attempts).toBe(1)
    expect(result.record.error).toMatchObject({ code: "invalid_auth", transient: false })
    expect(result.record.error?.message).toBe("invalid_auth token=[REDACTED]")
    expect(calls).toBe(1)
  })
})
