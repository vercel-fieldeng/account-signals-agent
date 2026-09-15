import { defaultSlackAuth } from "eve/channels/slack"
import { describe, expect, it, vi } from "vitest"
import { handleAutomationControl } from "./automation-control"
import { AUTOMATION_CHANNEL_ID, AUTOMATION_OPERATOR_USER_ID, AUTOMATION_SETUP_MARKER, AUTOMATION_WORKSPACE_ID } from "./automation-policy"

type Message = Parameters<typeof defaultSlackAuth>[0]
type Context = Parameters<typeof defaultSlackAuth>[1]

function message(overrides: Partial<Message> = {}): Message {
  return {
    text: "<@UBOT> setup automation",
    markdown: "@bot setup automation",
    ts: "1789422117.781019",
    threadTs: "1789422117.781019",
    channelId: AUTOMATION_CHANNEL_ID,
    // Independently verified from the linked Connect connector, not copied from policy.
    teamId: "T0CAQ00TU",
    author: { userId: AUTOMATION_OPERATOR_USER_ID, userName: "operator", fullName: "Test Operator", isBot: false, isMe: false },
    attachments: [],
    raw: { type: "app_mention" },
    ...overrides,
  }
}

function context(channelId = AUTOMATION_CHANNEL_ID): Context {
  // defaultSlackAuth is pure and reads only this identity projection of SlackContext.
  // No network/session methods are supplied, so an unexpected I/O access will fail.
  return { slack: { channelId, threadTs: "1789422117.781019" } } as unknown as Context
}

function store() {
  return { read: vi.fn(async () => null), pause: vi.fn() }
}

describe("automation admission with the real Eve Slack auth helper", () => {
  it("accepts the verified operator in the connector's actual Vercel installation", async () => {
    const incoming = message()
    const auth = defaultSlackAuth(incoming, context())
    expect(AUTOMATION_WORKSPACE_ID).toBe("T0CAQ00TU")
    expect(auth).toMatchObject({
      authenticator: "slack-webhook",
      principalType: "user",
      issuer: "slack:T0CAQ00TU",
      principalId: `slack:T0CAQ00TU:${AUTOMATION_OPERATOR_USER_ID}`,
    })
    const state = store()
    const result = await handleAutomationControl(incoming.text, auth, incoming.ts, state, "production")
    expect(result?.kind).toBe("setup")
    if (result?.kind !== "setup") throw new Error("Expected setup admission")
    expect(result.auth.principalId).toBe(auth?.principalId)
    expect(result.auth.attributes[AUTOMATION_SETUP_MARKER]).toContain(incoming.ts)
    expect(state.read).not.toHaveBeenCalled()
    expect(state.pause).not.toHaveBeenCalled()
  })

  it("rejects the previously mistaken workspace without broadening the operator gate", async () => {
    const incoming = message({ teamId: "T0AR02RR6V6" })
    const state = store()
    await expect(handleAutomationControl(incoming.text, defaultSlackAuth(incoming, context()), incoming.ts, state, "production"))
      .rejects.toMatchObject({ code: "workspace_not_allowed" })
    expect(state.read).not.toHaveBeenCalled()
  })

  it("continues rejecting other users, bots, missing authors and wrong channels", async () => {
    const base = message()
    const cases = [
      { incoming: message({ author: { ...base.author!, userId: "UOTHER" } }), ctx: context(), code: "operator_not_allowed" },
      { incoming: message({ author: { ...base.author!, isBot: true } }), ctx: context(), code: "not_human_user" },
      { incoming: message({ author: undefined }), ctx: context(), code: "missing_user_identity" },
      { incoming: base, ctx: context("COTHER"), code: "channel_not_allowed" },
    ]
    for (const { incoming, ctx, code } of cases) {
      const state = store()
      await expect(handleAutomationControl(incoming.text, defaultSlackAuth(incoming, ctx), incoming.ts, state, "production"))
        .rejects.toMatchObject({ code })
      expect(state.read).not.toHaveBeenCalled()
      expect(state.pause).not.toHaveBeenCalled()
    }
  })
})
