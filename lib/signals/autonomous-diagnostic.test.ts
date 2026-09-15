import { describe, expect, it, vi } from "vitest"
import type { SessionAuthContext } from "eve/context"
import { AUTOMATION_CHANNEL_ID, AUTOMATION_OPERATOR_USER_ID, AUTOMATION_WORKSPACE_ID } from "./automation-policy"
import { diagnosticPrompt, runAutonomousDiagnostic, type DiagnosticRunnerOptions } from "./autonomous-diagnostic"
import type { AutomationOwner } from "./automation-policy"
import type { AutomationState, ClaimedAutomationJob } from "./automation-state"

const ownerAuth: SessionAuthContext = {
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
const owner: AutomationOwner = { auth: ownerAuth, channelId: AUTOMATION_CHANNEL_ID, installationTeamId: AUTOMATION_WORKSPACE_ID }
const appAuth: SessionAuthContext = { authenticator: "app", principalId: "eve:app", principalType: "runtime", attributes: {} }

function claim(): ClaimedAutomationJob {
  return {
    job: { id: "job-1", dueAt: "2026-09-14T13:00:00.000Z", status: "checking", claimToken: "claim-token" },
    owner,
    generation: 3,
  }
}
function state(overrides: Partial<AutomationState> = {}): AutomationState {
  return {
    schemaVersion: 1,
    owner,
    paused: false,
    generation: 3,
    updatedAt: "2026-09-14T13:00:00.000Z",
    lastIntentAt: "2026-09-14T13:00:00.000Z",
    setup: { requestId: "request", requestedAt: "2026-09-14T12:55:00.000Z", status: "ready" },
    job: { id: "job-1", dueAt: "2026-09-14T13:00:00.000Z", status: "checking", claimToken: "claim-token" },
    ...overrides,
  }
}
function store(overrides: Partial<{
  claimDue: () => Promise<ClaimedAutomationJob | null>
  read: () => Promise<AutomationState | null>
  authorizeDispatch: (value: ClaimedAutomationJob) => Promise<boolean>
  markDispatched: (value: ClaimedAutomationJob, id: string) => Promise<void>
  block: (value: ClaimedAutomationJob, code: string) => Promise<void>
}> = {}) {
  return {
    claimDue: vi.fn(async () => claim()),
    read: vi.fn(async () => state({ job: { id: "job-1", dueAt: "2026-09-14T13:00:00.000Z", status: "blocked", claimToken: undefined } })),
    authorizeDispatch: vi.fn(async () => true),
    markDispatched: vi.fn(async () => undefined),
    block: vi.fn(async () => undefined),
    ...overrides,
  }
}

function tokenGetter() {
  return vi.fn(async (_uid: string, _subject: { subject: { type: string; id: string; issuer: string } }, _options: { forceRefresh: boolean }) => "secret-token")
}

function options(overrides: Partial<DiagnosticRunnerOptions> = {}): DiagnosticRunnerOptions {
  return {
    vercelEnv: "production",
    store: store(),
    getToken: tokenGetter() as DiagnosticRunnerOptions["getToken"],
    dispatch: vi.fn(async () => ({ id: "session-1" })),
    now: () => new Date("2026-09-14T13:42:00.000Z"),
    ...overrides,
  }
}

describe("owner-bound autonomous diagnostic", () => {
  it("is disabled outside production without claiming, tokens, or an agent", async () => {
    const state = store()
    const getToken = tokenGetter()
    const dispatch = vi.fn(async () => ({ id: "never" }))
    const result = await runAutonomousDiagnostic(options({ vercelEnv: "preview", store: state, getToken: getToken as DiagnosticRunnerOptions["getToken"], dispatch }))
    expect(result).toEqual({ kind: "disabled" })
    expect(state.claimDue).not.toHaveBeenCalled()
    expect(getToken).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("stays idle without token calls or an agent", async () => {
    const state = store({ claimDue: async () => null })
    const getToken = tokenGetter()
    const dispatch = vi.fn(async () => ({ id: "never" }))
    const result = await runAutonomousDiagnostic(options({ store: state, getToken: getToken as DiagnosticRunnerOptions["getToken"], dispatch }))
    expect(result).toEqual({ kind: "idle" })
    expect(getToken).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("passes the trusted owner unchanged, including user identity and installation destination", async () => {
    const state = store()
    const getToken = tokenGetter()
    const dispatch = vi.fn(async (actualOwner: typeof owner) => {
      expect(actualOwner).toEqual(owner)
      expect(actualOwner.auth).not.toEqual(appAuth)
      return { id: "accepted" }
    })
    const result = await runAutonomousDiagnostic(options({ store: state, getToken: getToken as DiagnosticRunnerOptions["getToken"], dispatch }))
    expect(result).toEqual({ kind: "dispatched", sessionId: "accepted" })
    expect(dispatch).toHaveBeenCalledWith(owner, expect.any(String))
    expect(state.authorizeDispatch).toHaveBeenCalledWith(expect.objectContaining({ owner, generation: 3 }))
    expect(state.markDispatched).toHaveBeenCalledWith(expect.anything(), "accepted")
  })

  it("checks Salesforce then d0 with stable user subject and forceRefresh, without exposing tokens", async () => {
    const getToken = tokenGetter()
    const state = store()
    const dispatch = vi.fn(async () => ({ id: "accepted" }))
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const result = await runAutonomousDiagnostic(options({ store: state, getToken: getToken as DiagnosticRunnerOptions["getToken"], dispatch }))
    expect(result.kind).toBe("dispatched")
    expect(getToken).toHaveBeenNthCalledWith(1, "api.salesforce.com/salesforce-mcp", { subject: { type: "user", id: ownerAuth.principalId, issuer: ownerAuth.issuer } }, { forceRefresh: true })
    expect(getToken).toHaveBeenNthCalledWith(2, "d0-web.vercel.tools/d0", {
      scopes: ["d0:invoke"],
      resources: ["https://d0-web.vercel.tools/eve/v1/mcp"],
      subject: { type: "user", id: ownerAuth.principalId, issuer: ownerAuth.issuer },
    }, { forceRefresh: true })
    expect(getToken.mock.invocationCallOrder[0]).toBeLessThan(getToken.mock.invocationCallOrder[1])
    expect(JSON.stringify(getToken.mock.calls)).not.toContain("secret-token")
    expect(JSON.stringify(dispatch.mock.calls)).not.toContain("secret-token")
    expect(log.mock.calls.flat()).not.toContain("secret-token")
    log.mockRestore()
  })

  it("blocks on Salesforce, skips d0 and dispatch, and sends only a sanitized notification", async () => {
    const state = store()
    const getToken = vi.fn(async (uid: string) => { if (uid.includes("salesforce")) throw new Error("secret-sf-token leaked") ; return "d0-secret" })
    const notifyBlocked = vi.fn(async (code: string) => { expect(code).toBe("salesforce_grant_check_failed") })
    const dispatch = vi.fn(async () => ({ id: "never" }))
    const result = await runAutonomousDiagnostic(options({ store: state, getToken: getToken as DiagnosticRunnerOptions["getToken"], notifyBlocked, dispatch }))
    expect(result).toEqual({ kind: "blocked", code: "salesforce_grant_check_failed" })
    expect(getToken).toHaveBeenCalledTimes(1)
    expect(dispatch).not.toHaveBeenCalled()
    expect(state.block).toHaveBeenCalledWith(expect.anything(), "salesforce_grant_check_failed")
    expect(notifyBlocked).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(notifyBlocked.mock.calls)).not.toContain("secret-sf-token")
  })

  it("does not dispatch when d0 fails", async () => {
    const getToken = vi.fn(async (uid: string) => { if (uid.includes("d0")) throw new Error("d0 secret") ; return "salesforce-token" })
    const dispatch = vi.fn(async () => ({ id: "never" }))
    const state = store()
    const result = await runAutonomousDiagnostic(options({ store: state, getToken: getToken as DiagnosticRunnerOptions["getToken"], dispatch, notifyBlocked: async () => undefined }))
    expect(result).toEqual({ kind: "blocked", code: "d0_grant_check_failed" })
    expect(getToken).toHaveBeenCalledTimes(2)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("cancels after a pause during preflight and never starts an agent", async () => {
    const state = store({ authorizeDispatch: async () => false })
    const dispatch = vi.fn(async () => ({ id: "never" }))
    const result = await runAutonomousDiagnostic(options({ store: state, dispatch }))
    expect(result).toEqual({ kind: "cancelled" })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("omits blocked notification when the claim is paused or cancelled", async () => {
    const pausedStore = store({ read: async () => state({ paused: true, job: { id: "job-1", dueAt: "2026-09-14T13:00:00.000Z", status: "blocked" } }) })
    const getToken = vi.fn(async () => { throw new Error("failure") })
    const notifyBlocked = vi.fn(async () => undefined)
    await runAutonomousDiagnostic(options({ store: pausedStore, getToken: getToken as DiagnosticRunnerOptions["getToken"], notifyBlocked }))
    expect(notifyBlocked).not.toHaveBeenCalled()
  })

  it("does not retry handoff or finalization failures", async () => {
    const state = store()
    const dispatch = vi.fn(async () => { throw new Error("handoff failed") })
    await expect(runAutonomousDiagnostic(options({ store: state, dispatch }))).rejects.toThrow("no automatic retry")
    expect(dispatch).toHaveBeenCalledTimes(1)
    const markDispatched = vi.fn(async () => { throw new Error("finalization failed") })
    const second = store({ markDispatched })
    await expect(runAutonomousDiagnostic(options({ store: second, dispatch: vi.fn(async () => ({ id: "accepted" })) }))).rejects.toThrow("no automatic retry")
    expect(second.claimDue).toHaveBeenCalledTimes(1)
  })

  it("calculates the preceding seven complete UTC days and defines a deterministic 15-account roster", () => {
    const prompt = diagnosticPrompt(new Date("2026-09-14T23:59:59.999Z"))
    expect(prompt).toContain("[2026-09-07T00:00:00.000Z, 2026-09-14T00:00:00.000Z)")
    expect(prompt).toContain("[2026-08-31T00:00:00.000Z, 2026-09-07T00:00:00.000Z)")
    expect(prompt).toContain("FIRST resolve and verify each selected exact Account ID")
    expect(prompt).toContain("Sam Maass as SA OR Stefan Nikolic as AE")
    expect(prompt).toContain("Scope exactly 15 distinct Salesforce Accounts")
    expect(prompt).toContain("LastActivityDate descending")
    expect(prompt).toContain("Name ascending")
    expect(prompt).toContain("Salesforce Account ID ascending")
    expect(prompt).toContain("Do not use a hardcoded name/ID list")
    expect(prompt).toContain("Deduplicate the SA ∪ AE union by Salesforce Account ID")
    expect(prompt).toContain("Calendar coverage and data completeness are different")
    expect(prompt).toContain("Current-week values are lower bounds")
    expect(prompt).toContain("2026-09-13 is still settling")
    expect(prompt).toContain("do not label a trend stable, declining, or healthy-no-change")
    expect(prompt).toContain("Major consumption spike with sustained active-team usage")
    expect(prompt).toContain("at or below 1,800 characters")
    expect(prompt).toContain("unknown / partial-scope")
    expect(prompt).toContain("Number findings once as a contiguous `1.`, `2.`, `3.` prefix")
    expect(prompt).toContain("Comparison:")
    expect(prompt).toContain("Scope:")
    expect(prompt).toContain("Evidence:")
    expect(prompt).toContain("Reach out:")
    expect(prompt).toContain("Deep dive:")
    expect(prompt).toContain("bounded context pass")
    expect(prompt).toContain("explained/expected")
    expect(prompt).toContain("Only actionable findings should be routed to a human")
    expect(prompt).toContain("BLUF:")
    expect(prompt).toContain("DETAIL:")
    expect(prompt).toContain("Do not call a consumption spike “product adoption”")
    expect(prompt).toContain("provisional / not trend-eligible")
  })
})
