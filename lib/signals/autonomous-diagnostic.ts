import { getToken, NoValidTokenError, UserAuthorizationRequiredError } from "@vercel/connect"
import { AUTOMATION_CONNECTORS } from "./automation-setup"
import { AUTOMATION_CHANNEL_ID, validateAutomationOwner, type AutomationOwner } from "./automation-policy"
import { AutomationStateStore } from "./automation-state"

const DAY = 86_400_000

export function diagnosticPrompt(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid diagnostic clock")
  const signalEnd = now.toISOString()
  const signalStart = new Date(now.getTime() - 3 * DAY).toISOString()
  return `AUTONOMOUS D0 SIGNAL BRIEF

Run one read-only d0 query and turn its result into a concise Slack brief. Use the supplied user identity unchanged. Salesforce, public web research, careers, news, and external context are optional and must not delay or block the d0 result.

Immediately call the root d0 connection in DISCOVER mode exactly once with this request:
“Run the existing semantic alert ‘New intent signals — Sam Maass SE book’ for [${signalStart}, ${signalEnd}) UTC. Use surfaced signals only and return up to 10 rows, one per account and signal. Scope by the semantic assignment ‘SE = Sam Maass’; do not require a physical signal-table column named sales_engineer_name and do not ask for account IDs. Return account name, signal/person, timestamp, full signal detail, category or family, grain, flip count/detail, fetch count/detail, source freshness/completeness, and truncation.”

Retain the invocation handle and poll that same invocation to terminal, honoring every pollAfterMs. Never restart it. Treat d0's applied filter and returned rows as the scope evidence; do not claim they prove the total size of the SE book. Do not invent accounts, owners, quantities, trends, or outreach routing.

When d0 completes, respond even if Salesforce or external context is unavailable. Rank at most three returned accounts by AE/SA usefulness, prioritizing relevant technical personas and specific use cases over raw signal count. Classify each account as CHECK NOW (concrete technical/team signal), INVESTIGATE (promising but needs validation), or WATCH (isolated soft signal). Require before/after values only if d0 returned a measured change. Put every returned row, up to the requested cap, in DETAIL grouped by account. Use human-readable dates in cards and preserve the exact UTC window only in the coverage footer. If d0 returns zero rows, say “No surfaced signals returned for this window”; do not broaden that to healthy, stable, or no opportunity.

Output exactly in Slack-compatible mrkdwn:
BLUF: <dynamic outcome headline: “N accounts worth reviewing”, “No surfaced intent in the last 72h”, “Signal retrieval still running”, or “Signal brief needs attention”>
Status: <Complete, Partial, Blocked, or WAITING_FOR_D0> · Last 72h · <N signals> · <N accounts>

1. *<CHECK NOW, INVESTIGATE, or WATCH> · <Account>*
*Why now:* <one sentence grounded in returned signals>
*Why it matters:* <one sentence for an AE/SA>
*Next:* <one specific imperative check>

<repeat for at most three accounts; omit numbering for zero rows>

Routing: <one shared sentence; use “CRM ownership not checked” unless d0 returned verified ownership>

DETAIL:
Signal evidence

*<Account> · <N signal/signals>*
• <Mon DD> · <signal source> · <person and title or entity> — <returned detail>
<one bullet per returned row, grouped under its account; do not repeat the account on every bullet>

<repeat for every returned account>

*Coverage*
Exact window: [${signalStart}, ${signalEnd}) UTC. <one compact sentence covering d0 freshness/completeness/truncation, total-book-size limits, and optional enrichment not checked>. Mention flip/fetch status on a row only when present; if all are zero, state “Flips/fetches: none” once here.

If d0 is still running when this turn must end, use the waiting headline and Status: WAITING_FOR_D0, then put exactly “No signal brief yet—retrieval is still processing; no outreach recommendation is available.” in DETAIL. This marker keeps the same session resumable. If d0 requires authorization or fails terminally, use the attention headline and Status: Blocked with one concrete next step. Do not expose tool lifecycle, SQL, credentials, internal IDs, or raw diagnostics.

Do not call collect_external_signals or Salesforce during this diagnostic. Do not write baselines, mutate customer systems, publish exports, call setup_automation, or create schedules.`
}

type RunnerStore = Pick<AutomationStateStore, "read" | "claimDue" | "authorizeDispatch" | "markDispatched" | "block">
type TokenGetter = typeof getToken
export type DiagnosticRunnerOptions = {
  dispatch: (owner: AutomationOwner, prompt: string) => Promise<{ id: string }>
  store?: RunnerStore
  getToken?: TokenGetter
  notifyBlocked?: (code: string) => Promise<void>
  now?: () => Date
  vercelEnv?: string
}
export type DiagnosticRunResult =
  | { kind: "disabled" | "idle" | "cancelled" }
  | { kind: "blocked"; code: string }
  | { kind: "dispatched"; sessionId: string }

function log(event: string, details: Record<string, string> = {}) {
  console.info(JSON.stringify({ event: `autonomous_diagnostic.${event}`, ...details }))
}

export async function runAutonomousDiagnostic(options: DiagnosticRunnerOptions): Promise<DiagnosticRunResult> {
  if ((options.vercelEnv ?? process.env.VERCEL_ENV) !== "production") return { kind: "disabled" }
  const store = options.store ?? new AutomationStateStore()
  const tokens = options.getToken ?? getToken
  const now = options.now ?? (() => new Date())
  let stage = "claim"
  try {
    const claim = await store.claimDue()
    if (!claim) return { kind: "idle" }
    stage = "owner_validation"
    const owner = validateAutomationOwner(claim.owner)

    for (const connector of AUTOMATION_CONNECTORS) {
      stage = `${connector.name.toLowerCase()}_grant_check`
      try {
        // Resolve the current workload OIDC at call time; never save either token.
        await tokens(connector.uid, {
          ...connector.tokenParams(),
          subject: { type: "user", id: owner.auth.principalId, issuer: owner.auth.issuer },
        }, { forceRefresh: true })
      } catch (error) {
        const suffix = error instanceof UserAuthorizationRequiredError || error instanceof NoValidTokenError
          ? "authorization_required" : "grant_check_failed"
        const code = `${connector.name.toLowerCase()}_${suffix}`
        await store.block(claim, code)
        const current = await store.read()
        if (current?.job?.id === claim.job.id && current.job.status === "blocked" && !current.paused) {
          await (options.notifyBlocked ?? postAutomationBlockedMessage)(code)
        }
        log("blocked", { jobId: claim.job.id, code })
        return { kind: "blocked", code }
      }
    }

    stage = "dispatch_authorization"
    // A pause during the grant checks invalidates the claim before any agent starts.
    if (!await store.authorizeDispatch(claim)) return { kind: "cancelled" }
    stage = "handoff"
    const session = await options.dispatch(owner, diagnosticPrompt(now()))
    if (!session || typeof session.id !== "string" || !session.id) throw new Error("Missing session")
    log("handoff_accepted", { jobId: claim.job.id, sessionId: session.id })
    stage = "record_handoff"
    await store.markDispatched(claim, session.id)
    log("dispatched", { jobId: claim.job.id, sessionId: session.id })
    return { kind: "dispatched", sessionId: session.id }
  } catch {
    // Keep ambiguous claims in place; never dispatch again merely because recording failed.
    log("failed", { stage })
    throw new Error(`Autonomous diagnostic failed at ${stage}; no automatic retry`)
  }
}

export async function postAutomationBlockedMessage(code: string): Promise<void> {
  const source = code.startsWith("salesforce_") ? "Salesforce" : "d0"
  const text = `Autonomous diagnostic blocked before customer-data retrieval: ${source} authorization could not be validated. No agent run was started. Send “setup automation” mentioning this bot from the authorized operator account to repair authorization and schedule a new one-off test. Use “automation status” to inspect or “pause automation” to disable pending work.`
  try {
    const token = await getToken("slack/account-signals-slack", { subject: { type: "app" } })
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ channel: AUTOMATION_CHANNEL_ID, text }),
    })
    if (!response.ok || (await response.json() as { ok?: boolean }).ok !== true) throw new Error("Slack notification failed")
  } catch {
    throw new Error("Automation authorization failure notification could not be delivered")
  }
}
