import { getToken, NoValidTokenError, UserAuthorizationRequiredError } from "@vercel/connect"
import { AUTOMATION_CONNECTORS } from "./automation-setup"
import { AUTOMATION_CHANNEL_ID, validateAutomationOwner, type AutomationOwner } from "./automation-policy"
import { AutomationStateStore } from "./automation-state"
import { SIGNAL_LOOKBACK_DAYS, signalLookbackWindow } from "./daily-schedule"
import { isReportedSignalId, ReportedSignalStore } from "./reported-signals"

export const DIAGNOSTIC_ROW_LIMIT = 25

/** Signal IDs already delivered to Slack; unavailable means exclusions could not be loaded. */
export type ReportedSignalContext = { ids: readonly string[]; available: boolean }

function exclusionClause(reported: ReportedSignalContext): string {
  const ids = reported.ids.filter(isReportedSignalId)
  if (ids.length === 0) return "No signal IDs have been reported yet; exclude nothing."
  return `Exclude rows whose ACCOUNT_INTENT_SIGNAL_ID is one of these already-reported IDs: ${ids.join(", ")}.`
}

export function diagnosticPrompt(now: Date, dailyDate?: string, reported: ReportedSignalContext = { ids: [], available: true }): string {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid diagnostic clock")
  const signalDate = dailyDate ?? now.toISOString().slice(0, 10)
  const window = signalLookbackWindow(signalDate)
  const signalEnd = window.end.toISOString()
  const signalStart = window.start.toISOString()
  const ledgerNote = reported.available
    ? ""
    : " The reported-signal ledger was unavailable, so previously reported signals may repeat; say so once in Coverage."
  return `AUTONOMOUS D0 SIGNAL BRIEF

Run one read-only d0 query and turn its result into a concise Slack brief. Use the supplied user identity unchanged. Salesforce, public web research, careers, news, and external context are optional and must not delay or block the d0 result.

Immediately call the root d0 connection in DISCOVER mode exactly once with this request:
“Using the stored definition of the semantic alert ‘New intent signals — Sam Maass SE book’ (GTM.ANALYTICS.ACCOUNT_INTENT_SIGNALS joined to GTM.ANALYTICS.ACCOUNTS on sfdc_account_id, semantic assignment ‘SE = Sam Maass’ via ACCOUNTS.sales_engineer_name, is_surfaced = TRUE), return signals for the last ${SIGNAL_LOOKBACK_DAYS} complete UTC calendar days [${signalStart}, ${signalEnd}). Replace the alert's rolling 24-hour predicate with these exact half-open midnight boundaries; signal timestamps are date-grained at 00:00 UTC, so do not substitute a rolling or Berlin-local window. The alert's paused schedule does not matter; do not run, modify, or post it. ${exclusionClause(reported)} Order by signal_date ascending (oldest first), then account, and return up to ${DIAGNOSTIC_ROW_LIMIT} rows, one per account and signal. For every row return ACCOUNT_INTENT_SIGNAL_ID, account name, signal source, person/title or entity, signal_date, full signal detail, category or family, and grain. Also return flip count/detail, fetch count/detail, source freshness, and whether more matching rows exist beyond the limit.”

Retain the invocation handle and poll that same invocation to terminal, honoring every pollAfterMs. Never restart it. Treat d0's applied filter and returned rows as the scope evidence; do not claim they prove the total size of the SE book. Source rows can load a day late; this window deliberately re-checks earlier days on every run and previously reported IDs are excluded, so never call a day final. A result is Complete when d0 returns successfully and no matching rows remain beyond the limit, including zero rows. If more rows remain, report Partial and say the remainder follows in the next brief.${ledgerNote} Do not invent accounts, owners, quantities, trends, or outreach routing.

When d0 completes, select at most three returned accounts for context enrichment. For each selected account, use the root Index connection: search up to three recent meetings across all accessible capture sources using the exact account name, verify the returned account association, retain its 18-character Salesforce Account ID, and call sfdc_lookup once for current Salesforce account/activity context. Choose the meeting most relevant to the surfaced signal and retrieve at most one speaker-attributed transcript per account. Use a bounded 0–3600 second transcript window and cite the returned Index deep link. Do not use recaps alone as customer evidence.

Index and Salesforce context are optional enrichment, not gates. If Index or sfdc_lookup fails, continue with the d0 rows, lower hypothesis confidence, and state the missing context once. Never restart d0, invent an Account ID, merge similarly named accounts, or initiate a Salesforce authorization flow. Construct an Account link only from an exact Salesforce ID returned for that account, using https://vercel.lightning.force.com/lightning/r/Account/<ID>/view.

For each account, synthesize the signal with current CRM motion and customer-stated priorities, blockers, stakeholders, and next steps. Explicitly distinguish Existing motion, Possible new motion, or Unclear. A hypothesis needs both the d0 signal and at least one attributable Salesforce or transcript fact; otherwise label it “Context unavailable; hypothesis not generated.” Confidence is High only when persona, signal, and customer-stated priority align; Medium when plausible but unconfirmed; Low when context is weak or stale.

The channel root is a scan, not a report. Keep the entire BLUF under 1,400 characters and each account card under 420 characters. Every field must be exactly one short line. Remove filler, repeated evidence, full meeting summaries, dates, and generic caveats from BLUF; retain them in DETAIL. In Contacts, name the strongest signal actor, summarize additional actors as “+N”, and name at most two existing-motion stakeholders after “Route:”.

Output exactly in Slack-compatible mrkdwn:
BLUF: <dynamic outcome headline: “N accounts worth reviewing”, “No new surfaced intent”, “Signal retrieval still running”, “Context enrichment still running”, or “Signal brief needs attention”>
Status: <Complete, Partial, Blocked, WAITING_FOR_D0, or WAITING_FOR_CONTEXT> · ${SIGNAL_LOOKBACK_DAYS}d · <N new signals> · <N accounts> · Context <N/N or partial>

*Account:* <Salesforce link if verified, otherwise account name>
*Signal:* <max 110 characters; count + compact event/person summary>
*Hypothesis:* <max 170 characters; Existing motion, Possible new motion, or Unclear + context-backed meaning> Confidence: <High, Medium, or Low>.
*Contacts:* <max 100 characters; strongest signal actor +N · Route: at most two stakeholders>
*Next:* <max 100 characters; one imperative action>

<repeat for at most three accounts; omit numbering for zero rows>
Do not include Context or Date fields in BLUF. Do not put Index links, source narration, or evidence qualifiers in BLUF.

DETAIL:
Evidence

*<Account> · <N signal/signals>*
• <Mon DD> · <signal source> · <person and title or entity> — <returned detail>
<one bullet per returned row, grouped under its account; every returned row must appear here even when its account has no BLUF card>
• *Context:* Salesforce: <verified account/opportunity/activity fact or unavailable> · Index: <descriptive meeting link and customer-stated fact or unavailable>

<repeat for every returned account>

*Coverage:* [${signalStart}, ${signalEnd}) UTC · new rows only · <d0 completeness/truncation> · Context <N/N or partial> · <aggregate flip/fetch status>. Keep this to one line.
Reported signal IDs: <comma-separated ACCOUNT_INTENT_SIGNAL_ID of every row listed in Evidence, exactly as d0 returned them, or none>

The Reported signal IDs line is machine-read and hidden from Slack; it marks those signals as delivered so later briefs skip them. Include it only in a Complete or Partial brief, list only IDs d0 actually returned, and never include it for Blocked, WAITING_FOR_D0, or WAITING_FOR_CONTEXT. If d0 did not return IDs, write none and report Partial.

If d0 is still running when this turn must end, use the retrieval headline and Status: WAITING_FOR_D0 with the existing one-sentence update in DETAIL. If d0 is terminal but context tools are still running, preserve the returned rows and use the context headline with Status: WAITING_FOR_CONTEXT; do not restart d0 on continuation. If d0 fails terminally, use the attention headline and Status: Blocked with one concrete next step; nothing is marked reported, so the next daily brief re-checks this window automatically. Do not expose tool lifecycle, SQL, credentials, internal IDs except verified Salesforce Account IDs in links and the hidden Reported signal IDs line, or raw diagnostics.

Do not call collect_external_signals or web research during this diagnostic. Salesforce and Index enrichment must remain read-only and bounded to the surfaced accounts. Do not write baselines, mutate customer systems, publish exports, call setup_automation, or create schedules.`
}

type RunnerStore = Pick<AutomationStateStore, "read" | "claimDue" | "authorizeDispatch" | "markDispatched" | "block">
type ReportedSignalReader = Pick<ReportedSignalStore, "listRecent">
type TokenGetter = typeof getToken
export type DiagnosticRunnerOptions = {
  dispatch: (owner: AutomationOwner, prompt: string) => Promise<{ id: string }>
  store?: RunnerStore
  reportedSignals?: ReportedSignalReader
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

/** Prefer a possible repeat over a missed signal when the ledger cannot be read. */
async function loadReportedSignals(reader: ReportedSignalReader): Promise<ReportedSignalContext> {
  try {
    return { ids: await reader.listRecent(), available: true }
  } catch {
    log("reported_signals_unavailable")
    return { ids: [], available: false }
  }
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
    const dailyDate = /^daily:(\d{4}-\d{2}-\d{2})$/.exec(claim.job.id)?.[1]
    stage = "reported_signals"
    const reported = await loadReportedSignals(options.reportedSignals ?? new ReportedSignalStore())
    stage = "handoff"
    const session = await options.dispatch(owner, diagnosticPrompt(now(), dailyDate, reported))
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
  const text = `Autonomous diagnostic blocked before customer-data retrieval: ${source} authorization could not be validated. No agent run was started. Send “setup automation” mentioning this bot from the authorized operator account to repair authorization, schedule a recovery check, and restore daily runs. Use “automation status” to inspect or “pause automation” to disable pending work.`
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
