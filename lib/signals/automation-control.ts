import type { SessionAuthContext } from "eve/context"
import { automationOwnerFromAuth, automationSetupAuth, classifyAutomationCommand, slackTimestampToIso } from "./automation-policy"
import { AutomationStateStore, type AutomationState } from "./automation-state"

type ControlStore = Pick<AutomationStateStore, "read" | "pause"> & Partial<Pick<AutomationStateStore, "reconcileStaleDispatch">>
export type AutomationControlResult =
  | { kind: "setup"; auth: SessionAuthContext; context: readonly string[] }
  | { kind: "reply"; text: string }
  | null

export function automationStatusText(state: AutomationState | null): string {
  if (!state) return "Automation is not configured. Send ‘setup automation’ mentioning the bot to authorize d0, schedule an initial diagnostic, and enable daily 08:00 Europe/Berlin runs."
  if (state.setup.status === "pending") return "Automation setup is pending. Complete the d0 sign-in step in the setup thread. No diagnostic is armed and daily runs are not enabled yet."
  if (state.paused) return "Automation is paused. Daily arming and pending scheduled/checking work are disabled. Dispatch already committed may still start; accepted runs are not cancelled."
  const job = state.job
  if (!job) return "Daily 08:00 Europe/Berlin automation is enabled. No diagnostic is currently scheduled."
  if (job.status === "scheduled") return `A diagnostic is scheduled for ${job.dueAt} (UTC). Daily 08:00 Europe/Berlin automation is enabled; source retrieval is not yet verified.`
  if (job.status === "checking") return "The native scheduler is validating the saved owner’s grants before starting the diagnostic. Daily 08:00 Europe/Berlin automation is enabled."
  if (job.status === "dispatching") return "Diagnostic dispatch was claimed. Its acceptance is not yet recorded; do not retry blindly. Daily automation remains enabled."
  if (job.status === "dispatched") return "The native scheduler accepted the diagnostic session, but its terminal result is not reconciled yet. Do not retry blindly; dispatch alone does not prove source retrieval or delivery. If this remains unchanged for at least 15 minutes, the authorized operator may send `recover automation` to mark the stale handoff failed."
  if (job.status === "completed") return `The diagnostic completed at ${job.terminalAt ?? "an unrecorded time"}. Daily 08:00 Europe/Berlin automation remains enabled; check the channel result.`
  if (job.status === "failed") return `The diagnostic reached a terminal failure (${job.failureCode ?? "unknown"}). This job will not retry; daily automation will arm the next eligible Berlin date.`
  if (job.status === "blocked" && job.failureCode?.endsWith("authorization_required")) return `The diagnostic is blocked (${job.failureCode}). Daily runs will remain blocked until ‘setup automation’ repairs authorization.`
  if (job.status === "blocked") return `The diagnostic is blocked (${job.failureCode ?? "unknown"}). This job will not retry; daily automation will arm the next eligible Berlin date.`
  return "The pending diagnostic was cancelled. Daily automation remains enabled and will arm the next eligible Berlin date."
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
      context: ["This exact, authenticated setup command authorizes the setup_automation tool to bind this operator, complete d0 consent, schedule one initial native diagnostic after five minutes, and enable one daily 08:00 Europe/Berlin diagnostic. Call setup_automation now. Do not query customer data, delegate, create other schedules, or claim success before the tool confirms it. If OAuth pauses the tool, resume the same setup; do not start an unrelated data request."],
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
        ? result.state?.paused
          ? "The stale dispatched diagnostic was marked failed. Automation remains paused; no daily run will arm until setup is completed again."
          : "The stale dispatched diagnostic was marked failed. That job will not retry; daily automation remains enabled for the next eligible Berlin date."
        : automationStatusText(result.state),
    }
  }
  return { kind: "reply", text: automationStatusText(await store.read()) }
}
