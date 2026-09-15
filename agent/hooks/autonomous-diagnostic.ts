import { defineHook } from "eve/hooks"
import { AutomationStateStore } from "../../lib/signals/automation-state"

/**
 * Reconciles an accepted native diagnostic when Eve has durably observed its
 * final assistant message or terminal session event. This is intentionally
 * idempotent and matches only the persisted session ID; ordinary Slack turns
 * are ignored by the state store.
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
    "message.completed": async (_event, ctx) => {
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
