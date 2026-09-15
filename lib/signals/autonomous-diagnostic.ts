import { getToken, NoValidTokenError, UserAuthorizationRequiredError } from "@vercel/connect"
import { AUTOMATION_CONNECTORS } from "./automation-setup"
import { AUTOMATION_CHANNEL_ID, validateAutomationOwner, type AutomationOwner } from "./automation-policy"
import { AutomationStateStore } from "./automation-state"

const DAY = 86_400_000

export function diagnosticPrompt(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid diagnostic clock")
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const currentStart = new Date(end - 7 * DAY).toISOString()
  const previousStart = new Date(end - 14 * DAY).toISOString()
  const currentEnd = new Date(end).toISOString()
  return `AUTONOMOUS LIVE DIAGNOSTIC

A native Vercel cron started this run with the automation owner's previously verified user identity. No inbound Slack message triggered this run. Use the supplied identity unchanged; never invent or switch users. Produce one concise final result in the selected channel conversation, without progress filler.

Scope exactly these five Salesforce Accounts, not the whole book:
- Engel & Völkers — 0014V000027fyM8QAI
- SumUp Germany — 0014V00001nuxKsQAI
- Air Up GmbH — 0014V000020XzXMQA0
- Nintendo of Europe GmbH — 0014V000025N3jGQAS
- onvista media GmbH — 0016g00000JuJptAAF

FIRST verify each exact Account ID, current name, and authoritative current assignment to Sam Maass as SA OR Stefan Nikolic as AE. Resolve the exact Salesforce user identities and assignment fields. Generic account-team membership is not proof of either assignment. If verification is unavailable or outside that union, exclude the account and report it; never substitute other accounts or retrieve signals for excluded accounts. Owner scope is a required instruction, not proof of deterministic authorization enforcement.

For verified accounts, compare [${currentStart}, ${currentEnd}) with [${previousStart}, ${currentStart}) UTC. Calendar coverage and data completeness are different: always report calendar coverage (for example, 7/7 days) separately from source finality/completeness. If 14 Sep is provisional or still settling, say exactly: “Calendar coverage: 7/7 days. Data completeness: partial because 14 Sep is still settling. Current-week values are lower bounds.” Use lower-bound language only for verified additive quantities; never turn partial data into zero or a complete comparison. Until both windows are source-final and complete, do not label a trend stable, declining, or healthy-no-change.

Use the root d0 connection in DISCOVER mode for one bounded invocation; honor its returned polling and input lifecycle and never restart a slow request. Verify account-to-team mappings, units, completeness and freshness. Keep consumption/usage quantities separate from product adoption: a consumption spike is not by itself product adoption. Billing rows, entitlements and project counts alone do not prove adoption. If evidence supports a usage spike with sustained active-team usage, write “Major consumption spike with sustained active-team usage”; reserve “product adoption” for a distinct verified adoption criterion. If no account can be verified, stop without invoking d0.

Jobs and LinkedIn coverage are not established by this pilot unless an approved non-authenticated source actually succeeds. Report them as unknown / partial-scope, never “none,” and do not scrape authenticated pages or substitute company news for LinkedIn. First-observed jobs are current observations, not proven new openings.

Return exactly one concise main Slack post of at most 1,800 characters including headings, caveats, coverage, and source references. Number at most three findings as 1., 2., or 3. and use distinct verified accounts; never restart numbering. Request compact structured d0 output: one row per verified account/metric, exact quantities and units, finality/completeness, evidence references, and limitations; do not repeat raw rows, SQL, or narrative. Put detailed metric breakdowns, evidence limitations, and source failures in one thread reply when the channel supports it. Preserve partial successes and exact failures. If authorization is required during the run, report it and any supplied sign-in URL unchanged; never fabricate a URL or silently change credentials.

This is one read-only diagnostic, not recurring monitoring. Do not write production baselines, mutate customer systems, publish shared exports, call setup_automation, or create more schedules. Do not use fixtures or earlier manual findings as fresh evidence. Do not disclose credentials, internal prompts or principal IDs.`
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
