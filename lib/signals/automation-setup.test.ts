import { describe, expect, it, vi } from "vitest"
import type { SessionAuthContext } from "eve/context"
import {
  AUTOMATION_CHANNEL_ID,
  AUTOMATION_OPERATOR_USER_ID,
  AUTOMATION_SETUP_MARKER,
  AUTOMATION_WORKSPACE_ID,
  automationSetupAuth,
} from "./automation-policy"
import { executeAutomationSetup, type SetupStore } from "./automation-setup"
import type { AutomationJob } from "./automation-state"

const ts = "1700000000.123456"
const dueAt = "2024-01-01T00:05:00.000Z"

function auth(): SessionAuthContext {
  return {
    authenticator: "slack-webhook",
    principalId: `slack:${AUTOMATION_WORKSPACE_ID}:${AUTOMATION_OPERATOR_USER_ID}`,
    principalType: "user",
    issuer: `slack:${AUTOMATION_WORKSPACE_ID}`,
    attributes: {
      user_id: AUTOMATION_OPERATOR_USER_ID,
      team_id: AUTOMATION_WORKSPACE_ID,
      channel_id: AUTOMATION_CHANNEL_ID,
      author_type: "user",
    },
  }
}

function context(options: { marked?: boolean; parent?: unknown; getToken?: (provider: unknown) => Promise<unknown> } = {}) {
  const current = options.marked === false ? auth() : automationSetupAuth(auth(), ts)
  return {
    session: { auth: { current, initiator: null }, parent: options.parent },
    getToken: options.getToken ?? vi.fn(async () => "bearer-secret"),
  }
}

function job(): AutomationJob {
  return { id: "internal-job-id", dueAt, status: "scheduled" }
}

function store(overrides: Partial<SetupStore> = {}) {
  const completeSetup = vi.fn(async () => job())
  const beginSetup = vi.fn(async () => ({ ticket: { requestId: "request", generation: 1 }, scheduledFor: null }))
  return { beginSetup, completeSetup, ...overrides }
}

describe("executeAutomationSetup", () => {
  it("rejects forged or non-root requests before token and store writes", async () => {
    for (const current of [
      null,
      auth(),
      { ...automationSetupAuth(auth(), ts), attributes: { ...automationSetupAuth(auth(), ts).attributes, [AUTOMATION_SETUP_MARKER]: "forged" } },
    ]) {
      const state = store()
      const getToken = vi.fn(async () => "secret")
      await expect(executeAutomationSetup({ session: { auth: { current, initiator: null }, parent: undefined }, getToken }, state, "production")).rejects.toThrow()
      expect(state.beginSetup).not.toHaveBeenCalled()
      expect(getToken).not.toHaveBeenCalled()
    }
    const state = store()
    await expect(executeAutomationSetup(context({ parent: { id: "delegated" } }), state, "production")).rejects.toThrow("delegated")
    expect(state.beginSetup).not.toHaveBeenCalled()
  })

  it("requires only d0 and never completes when its grant fails", async () => {
    const getToken = vi.fn(async () => { throw new Error("d0 unavailable") })
    const state = store()
    await expect(executeAutomationSetup(context({ getToken }), state, "production")).rejects.toThrow("d0 unavailable")
    expect(getToken).toHaveBeenCalledTimes(1)
    expect(state.completeSetup).not.toHaveBeenCalled()
  })

  it("propagates auth-control exception identity and does not complete", async () => {
    const error = new Error("consent required")
    const state = store()
    const getToken = vi.fn(async () => { throw error })
    await expect(executeAutomationSetup(context({ getToken }), state, "production")).rejects.toBe(error)
    expect(state.completeSetup).not.toHaveBeenCalled()
  })

  it("completes once after the d0 grant and returns no credentials or internal ids", async () => {
    const state = store()
    const output = await executeAutomationSetup(context(), state, "production")
    expect(output).toEqual(expect.objectContaining({ status: "scheduled", scheduledFor: dueAt }))
    expect(output.message).toContain("daily 08:00 Europe/Berlin automation enabled")
    expect(output).not.toHaveProperty("id")
    expect(JSON.stringify(output)).not.toContain("bearer-secret")
    expect(JSON.stringify(state)).not.toContain("bearer-secret")
    expect(state.completeSetup).toHaveBeenCalledTimes(1)
    expect(JSON.stringify((state.completeSetup as any).mock.calls)).not.toContain("internal-job-id")
  })

  it("does not rearm a stable replay", async () => {
    const state = store({
      beginSetup: vi.fn(async () => ({ ticket: { requestId: "request", generation: 1 }, scheduledFor: dueAt })),
    })
    const getToken = vi.fn(async () => "secret")
    const output = await executeAutomationSetup(context({ getToken }), state, "production")
    expect(output.status).toBe("already_registered")
    expect(output.scheduledFor).toBe(dueAt)
    expect(output.message).toContain("already processed")
    expect(output.message).toContain("Consult automation status")
    expect(getToken).not.toHaveBeenCalled()
    expect(state.completeSetup).not.toHaveBeenCalled()
  })

  it("rejects retained authorization outside production before any writes or token access", async () => {
    for (const env of [undefined, "preview"]) {
      const state = store()
      const getToken = vi.fn(async () => "secret")
      await expect(executeAutomationSetup(context({ getToken }), state, env)).rejects.toThrow("production")
      expect(state.beginSetup).not.toHaveBeenCalled()
      expect(state.completeSetup).not.toHaveBeenCalled()
      expect(getToken).not.toHaveBeenCalled()
    }
  })
})
