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
    reportedSignals: { listRecent: async () => [] },
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

  it("uses the daily job date for a trailing complete UTC lookback across DST", async () => {
    const dailyClaim = claim()
    dailyClaim.job.id = "daily:2026-10-25"
    const dispatch = vi.fn(async () => ({ id: "daily-session" }))
    await runAutonomousDiagnostic(options({
      now: () => new Date("2026-10-25T12:00:00.000Z"),
      store: store({ claimDue: async () => dailyClaim }),
      dispatch,
    }))
    expect(dispatch).toHaveBeenCalledWith(owner, expect.stringContaining("[2026-10-18T00:00:00.000Z, 2026-10-25T00:00:00.000Z)"))
  })

  it("excludes already reported signal IDs from the d0 request", async () => {
    const dispatch = vi.fn(async () => ({ id: "session" }))
    await runAutonomousDiagnostic(options({ dispatch, reportedSignals: { listRecent: async () => ["sig-a", "sig-b"] } }))
    const prompt = String((dispatch.mock.calls[0] as unknown[])[1])
    expect(prompt).toContain("already-reported IDs: sig-a, sig-b.")
    expect(prompt).not.toContain("ledger was unavailable")
  })

  it("still dispatches without exclusions when the reported-signal ledger is unavailable", async () => {
    const dispatch = vi.fn(async () => ({ id: "session" }))
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const result = await runAutonomousDiagnostic(options({ dispatch, reportedSignals: { listRecent: async () => { throw new Error("blob down") } } }))
    log.mockRestore()
    expect(result).toEqual({ kind: "dispatched", sessionId: "session" })
    const prompt = String((dispatch.mock.calls[0] as unknown[])[1])
    expect(prompt).toContain("No signal IDs have been reported yet")
    expect(prompt).toContain("ledger was unavailable, so previously reported signals may repeat")
  })

  it("checks only d0 with the stable user subject and forceRefresh, without exposing tokens", async () => {
    const getToken = tokenGetter()
    const state = store()
    const dispatch = vi.fn(async () => ({ id: "accepted" }))
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined)
    const result = await runAutonomousDiagnostic(options({ store: state, getToken: getToken as DiagnosticRunnerOptions["getToken"], dispatch }))
    expect(result.kind).toBe("dispatched")
    expect(getToken).toHaveBeenCalledTimes(1)
    expect(getToken).toHaveBeenCalledWith("d0-web.vercel.tools/d0", {
      scopes: ["d0:invoke"],
      resources: ["https://d0-web.vercel.tools/eve/v1/mcp"],
      subject: { type: "user", id: ownerAuth.principalId, issuer: ownerAuth.issuer },
    }, { forceRefresh: true })
    expect(JSON.stringify(getToken.mock.calls)).not.toContain("secret-token")
    expect(JSON.stringify(dispatch.mock.calls)).not.toContain("secret-token")
    expect(log.mock.calls.flat()).not.toContain("secret-token")
    log.mockRestore()
  })

  it("blocks on d0 failure and sends only a sanitized notification", async () => {
    const state = store()
    const getToken = vi.fn(async () => { throw new Error("secret-d0-token leaked") })
    const notifyBlocked = vi.fn(async (code: string) => { expect(code).toBe("d0_grant_check_failed") })
    const dispatch = vi.fn(async () => ({ id: "never" }))
    const result = await runAutonomousDiagnostic(options({ store: state, getToken: getToken as DiagnosticRunnerOptions["getToken"], notifyBlocked, dispatch }))
    expect(result).toEqual({ kind: "blocked", code: "d0_grant_check_failed" })
    expect(getToken).toHaveBeenCalledTimes(1)
    expect(dispatch).not.toHaveBeenCalled()
    expect(state.block).toHaveBeenCalledWith(expect.anything(), "d0_grant_check_failed")
    expect(notifyBlocked).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(notifyBlocked.mock.calls)).not.toContain("secret-d0-token")
  })

  it("does not dispatch when d0 preflight fails", async () => {
    const getToken = vi.fn(async () => { throw new Error("d0 secret") })
    const dispatch = vi.fn(async () => ({ id: "never" }))
    const state = store()
    const result = await runAutonomousDiagnostic(options({ store: state, getToken: getToken as DiagnosticRunnerOptions["getToken"], dispatch, notifyBlocked: async () => undefined }))
    expect(result).toEqual({ kind: "blocked", code: "d0_grant_check_failed" })
    expect(getToken).toHaveBeenCalledTimes(1)
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

  it("uses one d0 request followed by bounded optional Salesforce and Index enrichment", () => {
    const prompt = diagnosticPrompt(new Date("2026-09-14T23:59:59.999Z"))
    expect(prompt).toContain("[2026-09-07T00:00:00.000Z, 2026-09-14T00:00:00.000Z)")
    expect(prompt).toContain("date-grained at 00:00 UTC")
    expect(prompt).toContain("never call a day final")
    expect(prompt).toContain("say the remainder follows in the next brief")
    expect(prompt).toContain("No new surfaced intent")
    expect(prompt).toContain("· 7d ·")
    expect(prompt).toContain("New intent signals — Sam Maass SE book")
    expect(prompt).toContain("SE = Sam Maass")
    expect(prompt).toContain("is_surfaced = TRUE")
    expect(prompt).toContain("do not run, modify, or post it")
    expect(prompt).toContain("Order by signal_date ascending (oldest first)")
    expect(prompt).toContain("return up to 25 rows")
    expect(prompt).toContain("ACCOUNT_INTENT_SIGNAL_ID")
    expect(prompt).toContain("Reported signal IDs: <comma-separated ACCOUNT_INTENT_SIGNAL_ID")
    expect(prompt).toContain("never include it for Blocked")
    expect(prompt).toContain("every returned row must appear here")
    expect(prompt).toContain("No signal IDs have been reported yet; exclude nothing.")
    expect(prompt).toContain("DISCOVER mode exactly once")
    expect(prompt).toContain("poll that same invocation to terminal")
    expect(prompt).toContain("select at most three returned accounts for context enrichment")
    expect(prompt).toContain("call sfdc_lookup once")
    expect(prompt).toContain("at most one speaker-attributed transcript per account")
    expect(prompt).toContain("Do not use recaps alone as customer evidence")
    expect(prompt).toContain("Salesforce context are optional enrichment, not gates")
    expect(prompt).toContain("Existing motion")
    expect(prompt).toContain("Context unavailable; hypothesis not generated")
    expect(prompt).toContain("Status: WAITING_FOR_D0")
    expect(prompt).toContain("Status: WAITING_FOR_CONTEXT")
    expect(prompt).toContain("BLUF: <dynamic outcome headline")
    for (const field of ["*Account:*", "*Signal:*", "*Hypothesis:*", "*Contacts:*", "*Next:*"]) {
      expect(prompt).toContain(field)
    }
    expect(prompt).toContain("entire BLUF under 2,000 characters")
    expect(prompt).toContain("call scan_account_news exactly once with no arguments")
    expect(prompt).toContain("public news from the last 7 days")
    expect(prompt).toContain("omit news from the brief entirely and never write that there was no news")
    expect(prompt).toContain("*News:* <Opportunity or Risk>")
    expect(prompt).toContain("followed by the id of every news event listed in Account news")
    expect(prompt).toContain("Still include returned news events in a Blocked brief")
    expect(prompt).toContain("Do not call collect_external_signals or any web research other than the single scan_account_news call")
    expect(prompt).toContain("each account card under 420 characters")
    expect(prompt).toContain("Do not include Context or Date fields in BLUF")
    expect(prompt).toContain("• *Context:* Salesforce:")
    expect(prompt).toContain("*Coverage:*")
    expect(prompt).not.toContain("After the Salesforce roster is verified")
    expect(prompt).not.toContain("full requested SE book")

    const dstPrompt = diagnosticPrompt(new Date("2026-10-25T12:00:00.000Z"), "2026-10-25")
    expect(dstPrompt).toContain("[2026-10-18T00:00:00.000Z, 2026-10-25T00:00:00.000Z)")
  })
})
