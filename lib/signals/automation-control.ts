import type { SessionAuthContext } from "eve/context"
import { automationOwnerFromAuth, automationSetupAuth, classifyAutomationCommand, slackTimestampToIso } from "./automation-policy"
import { AutomationStateStore, type AutomationState } from "./automation-state"

type ControlStore = Pick<AutomationStateStore, "read" | "pause"> & Partial<Pick<AutomationStateStore, "reconcileStaleDispatch">>
export type AutomationControlResult =
  | { kind: "setup"; auth: SessionAuthContext; context: readonly string[] }
  | { kind: "reply"; text: string }
  | null

export function automationStatusText(state: AutomationState | null): string {
  if (!state) return "Automation is not configured. Send ‘setup automation’ mentioning the bot to authorize Salesforce and d0 and schedule one native diagnostic."
  if (state.setup.status === "pending") return "Automation setup is pending. Complete the Salesforce/d0 sign-in steps in the setup thread. No diagnostic is armed."
  if (state.paused) return "Automation is paused. Pending setup and scheduled/checking work are cancelled. Dispatch already committed may still start; accepted runs are not cancelled."
  const job = state.job
  if (!job) return "No autonomous diagnostic is scheduled."
  if (job.status === "scheduled") return `One native diagnostic is scheduled for ${job.dueAt} (UTC). Source retrieval is not yet verified.`
  if (job.status === "checking") return "The native scheduler is validating the saved owner’s grants before starting the diagnostic."
  if (job.status === "dispatching") return "Diagnostic dispatch was claimed. Its acceptance is not yet recorded; do not retry blindly."
  if (job.status === "dispatched") return "The native scheduler accepted the diagnostic session, but its terminal result is not reconciled yet. Do not retry blindly; dispatch alone does not prove source retrieval or delivery. If this remains unchanged for at least 15 minutes, the authorized operator may send `recover automation` to mark the stale handoff failed."
  if (job.status === "completed") return `The diagnostic completed at ${job.terminalAt ?? "an unrecorded time"}. Check its channel result; completion does not change the partial-scope limitations.`
  if (job.status === "failed") return `The diagnostic reached a terminal failure (${job.failureCode ?? "unknown"}). No automatic retry is armed; inspect the run before sending a new setup request.`
  if (job.status === "blocked") return `The diagnostic is blocked (${job.failureCode ?? "unknown"}). No automatic retry is armed. Send ‘setup automation’ to repair authorization and schedule one new test.`
  return "The pending diagnostic was cancelled. No automatic retry is armed."
}

export async function handleAutomationControl(
  text: string,
  auth: SessionAuthContext | null,
  messageTs: string,
  store: ControlStore = new AutomationStateStore(),
  vercelEnv = process.env.VERCEL_ENV,
): Promise<AutomationControlResult> {
  const command = classifyAutomationCommand(text)
  if (!command) return null
  // Admission is enforced here even when the caller has already checked the channel.
  const owner = automationOwnerFromAuth(auth)
  if (vercelEnv !== "production") return { kind: "reply", text: "Automation controls are available only on the production bot. No job was armed." }
  if (command === "setup") {
    return {
      kind: "setup",
      auth: automationSetupAuth(auth!, messageTs),
      context: ["This exact, authenticated setup command authorizes the setup_automation tool to bind this operator, complete Salesforce then d0 consent, and schedule ONE native diagnostic five minutes after both grants resolve. Call setup_automation now. Do not query customer data, delegate, create other schedules, or claim success before the tool confirms it. If OAuth pauses the tool, resume the same setup; do not start an unrelated data request."],
    }
  }
  if (command === "pause") {
    const state = await store.pause(owner, slackTimestampToIso(messageTs))
    return { kind: "reply", text: automationStatusText(state) }
  }
  if (command === "recover") {
    if (!store.reconcileStaleDispatch) throw new Error("Automation recovery is unavailable")
    const result = await store.reconcileStaleDispatch(owner)
    return {
      kind: "reply",
      text: result.reconciled
        ? "The stale dispatched diagnostic was marked failed. No automatic retry was started; send `setup automation` when you are ready to schedule a new run."
        : automationStatusText(result.state),
    }
  }
  return { kind: "reply", text: automationStatusText(await store.read()) }
}
