import { defineHook } from "eve/hooks"
import { AutomationStateStore } from "../../lib/signals/automation-state"

/**
 * Eve emits message.completed for interim assistant text before tool calls and
 * for the final answer. Only the latter may reconcile this one-shot job.
 */
export function isTerminalDiagnosticMessage(finishReason: string | undefined): boolean {
  return finishReason !== "tool-calls"
}

/**
 * Reconciles an accepted native diagnostic after its final answer or terminal
 * session event. This is intentionally idempotent and matches only the
 * persisted session ID; ordinary Slack turns are ignored by the state store.
 */
async function reconcile(sessionId: string, outcome: "completed" | "failed", failureCode?: string) {
  try {
    await new AutomationStateStore().reconcileSession(sessionId, outcome, failureCode)
  } catch {
    // Do not turn an otherwise completed customer reply into a second failure
    // when the separate automation ledger is temporarily unavailable.
    console.warn(`autonomous diagnostic lifecycle reconciliation failed (${outcome})`)
  }
}

export default defineHook({
  events: {
    // Interactive Slack sessions enter waiting after a final answer rather than
    // emitting session.completed, so reconcile the final message as well.
    "message.completed": async (event, ctx) => {
      if (!isTerminalDiagnosticMessage(event.data.finishReason)) return
      await reconcile(ctx.session.id, "completed")
    },
    "session.completed": async (_event, ctx) => {
      await reconcile(ctx.session.id, "completed")
    },
    "session.failed": async (event) => {
      await reconcile(event.data.sessionId, "failed", "session_failed")
    },
  },
})
