import { describe, expect, it, vi } from "vitest"
import type { SessionAuthContext } from "eve/context"
import type { AutomationOwner } from "./automation-policy"
import type { AutomationState } from "./automation-state"
import { AUTOMATION_CHANNEL_ID, AUTOMATION_OPERATOR_USER_ID, AUTOMATION_SETUP_MARKER, AUTOMATION_WORKSPACE_ID } from "./automation-policy"
import { automationStatusText, handleAutomationControl } from "./automation-control"

const ts = "1700000000.123456"
function auth(overrides: Partial<SessionAuthContext> = {}): SessionAuthContext {
  return {
    authenticator: "slack-webhook",
    principalId: `slack:${AUTOMATION_WORKSPACE_ID}:${AUTOMATION_OPERATOR_USER_ID}`,
    principalType: "user",
    issuer: `slack:${AUTOMATION_WORKSPACE_ID}`,
    attributes: { user_id: AUTOMATION_OPERATOR_USER_ID, team_id: AUTOMATION_WORKSPACE_ID, channel_id: AUTOMATION_CHANNEL_ID, author_type: "user" },
    ...overrides,
  }
}

function state(overrides: Partial<AutomationState> = {}): AutomationState {
  return {
    schemaVersion: 1,
    owner: { auth: auth(), channelId: AUTOMATION_CHANNEL_ID, installationTeamId: AUTOMATION_WORKSPACE_ID },
    paused: false,
    generation: 1,
    updatedAt: "2023-11-14T22:13:20.000Z",
    lastIntentAt: "2023-11-14T22:13:20.000Z",
    setup: { requestId: "request", requestedAt: "2023-11-14T22:13:20.000Z", status: "ready" },
    job: { id: "job", dueAt: "2023-11-14T22:18:20.000Z", status: "scheduled" },
    ...overrides,
  }
}

type ControlStore = {
  read: () => Promise<AutomationState | null>
  pause: (owner: AutomationOwner, requestedAt: string) => Promise<AutomationState>
}

describe("automation controls", () => {
  it("admits only exact setup, status, and pause commands", async () => {
    const store = { read: vi.fn(async () => null), pause: vi.fn(async () => state({ paused: true })) }
    for (const text of ["setup automation", "automation status", "pause automation"]) {
      await expect(handleAutomationControl(text, auth(), ts, store, "production")).resolves.not.toBeNull()
    }
    await expect(handleAutomationControl("setup automation now", auth(), ts, store, "production")).resolves.toBeNull()
  })

  it("recovers only through the exact operator control", async () => {
    const recovered = state({ job: { id: "job", dueAt: "2023-11-14T22:18:20.000Z", status: "failed", acceptedSessionId: "session", terminalAt: "2023-11-14T22:30:20.000Z", failureCode: "session_stale" } })
    const reconcileStaleDispatch = vi.fn(async () => ({ reconciled: true, state: recovered }))
    const store = { read: vi.fn(async () => recovered), pause: vi.fn(async () => recovered), reconcileStaleDispatch }
    await expect(handleAutomationControl("recover automation", auth(), ts, store, "production")).resolves.toEqual({
      kind: "reply",
      text: expect.stringContaining("marked failed"),
    })
    expect(reconcileStaleDispatch).toHaveBeenCalledWith(expect.objectContaining({ channelId: AUTOMATION_CHANNEL_ID }))
  })

  it("returns null for normal text without touching storage", async () => {
    const store = { read: vi.fn(async () => null), pause: vi.fn() }
    await expect(handleAutomationControl("hello", auth(), ts, store, "production")).resolves.toBeNull()
    expect(store.read).not.toHaveBeenCalled()
    expect(store.pause).not.toHaveBeenCalled()
  })

  it("rejects nonoperators, bots, and wrong channels before storage", async () => {
    const store = { read: vi.fn(async () => null), pause: vi.fn() }
    for (const candidate of [
      null,
      auth({ principalId: "wrong" }),
      auth({ authenticator: "slack-bot" }),
      auth({ attributes: { ...auth().attributes, author_type: "bot" } }),
      auth({ attributes: { ...auth().attributes, channel_id: "wrong-channel" } }),
    ]) {
      await expect(handleAutomationControl("automation status", candidate, ts, store, "production")).rejects.toThrow()
    }
    expect(store.read).not.toHaveBeenCalled()
  })

  it("returns setup context with only the marker and does not touch storage or customer APIs", async () => {
    const store = { read: vi.fn(async () => null), pause: vi.fn() }
    const result = await handleAutomationControl("setup automation", auth({ attributes: { ...auth().attributes, unrelated: "drop" } }), ts, store, "production")
    expect(result?.kind).toBe("setup")
    if (result?.kind !== "setup") throw new Error("expected setup")
    expect(result.auth.attributes[AUTOMATION_SETUP_MARKER]).toBe(`${AUTOMATION_WORKSPACE_ID}:${AUTOMATION_OPERATOR_USER_ID}:${AUTOMATION_CHANNEL_ID}:${ts}`)
    expect(result.auth.attributes.unrelated).toBe("drop")
    expect(result.context).toHaveLength(1)
    expect(result.context[0]).toContain("Call setup_automation now")
    expect(store.read).not.toHaveBeenCalled()
    expect(store.pause).not.toHaveBeenCalled()
  })

  it("keeps preview controls from writing state", async () => {
    const store = { read: vi.fn(async () => state()), pause: vi.fn() }
    const result = await handleAutomationControl("pause automation", auth(), ts, store, "preview")
    expect(result).toEqual({ kind: "reply", text: expect.stringContaining("production bot") })
    expect(store.read).not.toHaveBeenCalled()
    expect(store.pause).not.toHaveBeenCalled()
  })

  it("keeps status text safe for missing and every persisted job state", () => {
    expect(automationStatusText(null)).toContain("not configured")
    for (const jobStatus of ["scheduled", "checking", "dispatching", "dispatched", "completed", "failed", "blocked", "cancelled"] as const) {
      expect(automationStatusText(state({ job: {
        id: "job", dueAt: "2023-11-14T22:18:20.000Z", status: jobStatus,
        ...(jobStatus === "dispatched" || jobStatus === "completed" || jobStatus === "failed" ? { acceptedSessionId: "session" } : {}),
        ...(jobStatus === "completed" || jobStatus === "failed" ? { terminalAt: "2023-11-14T22:18:20.000Z" } : {}),
      } }))).toBeTypeOf("string")
    }
  })

  it("passes the exact trusted Slack message time to pause", async () => {
    const pauseTs = "1700000000.000000"
    const paused = state({ paused: true })
    const store: ControlStore = { read: vi.fn(async () => paused), pause: vi.fn(async (_owner: AutomationOwner, requestedAt: string) => { expect(requestedAt).toBe("2023-11-14T22:13:20.000000Z"); return paused }) }
    const result = await handleAutomationControl("pause automation", auth(), pauseTs, store, "production")
    expect(store.pause).toHaveBeenCalledWith(expect.objectContaining({ channelId: AUTOMATION_CHANNEL_ID, installationTeamId: AUTOMATION_WORKSPACE_ID }), "2023-11-14T22:13:20.000000Z")
    expect(result).toEqual({ kind: "reply", text: automationStatusText(paused) })
  })
})
