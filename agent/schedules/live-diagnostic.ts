import { getToken } from "@vercel/connect"
import { defineSchedule } from "eve/schedules"
import slack from "../channels/slack"
import { runAutonomousDiagnostic } from "../../lib/signals/autonomous-diagnostic"
import { type AutomationOwner } from "../../lib/signals/automation-policy"
import { AutomationStateStore, type AutomationJob } from "../../lib/signals/automation-state"
import { dueDailyScheduleDate } from "../../lib/signals/daily-schedule"

const diagnosticInitialMessage = {
  // Eve's Chat SDK CardElement is structurally represented here so the
  // proactive Slack receive has a visible root before the model runs.
  card: {
    type: "card",
    title: "Account Signals — running",
    children: [{ type: "text", content: "Retrieving surfaced intent signals…" }],
  } as never,
  fallbackText: "Account Signals — running\nRetrieving surfaced intent signals…",
}

const continuationPrompt = `Continue the existing signal brief without restarting d0. If the retained d0 invocation is pending, call agent_get and honor pollAfterMs. If d0 is terminal and Salesforce/Index context enrichment is pending, reuse its returned rows and finish the bounded enrichment for at most three accounts. Return the compact Account/Signal/Hypothesis/Contacts/Next BLUF and grouped context evidence DETAIL when complete, ending with the Reported signal IDs line for every row listed in Evidence. Use Status: WAITING_FOR_D0 or Status: WAITING_FOR_CONTEXT only when that stage is still running so the session remains resumable.`

type SlackHistoryMessage = { ts?: unknown; bot_id?: unknown; user?: unknown }
type SlackAppIdentity = { user_id?: unknown; bot_id?: unknown }

export function selectDiagnosticRootTs(messages: SlackHistoryMessage[], identity: SlackAppIdentity): string | null {
  const candidates = messages
    .filter((message) => typeof message.ts === "string")
    .filter((message) =>
      (typeof identity.user_id === "string" && message.user === identity.user_id) ||
      (typeof identity.bot_id === "string" && message.bot_id === identity.bot_id))
    .sort((a, b) => Number.parseFloat(String(b.ts)) - Number.parseFloat(String(a.ts)))
  return candidates.length > 0 ? String(candidates[0].ts) : null
}

async function findDiagnosticRootTs(channelId: string, dispatchedAt: string): Promise<string | null> {
  const token = await getToken("slack/account-signals-slack", { subject: { type: "app" } })
  const headers = { authorization: `Bearer ${token}` }
  const identityResponse = await fetch("https://slack.com/api/auth.test", { headers })
  if (!identityResponse.ok) return null
  const identity = await identityResponse.json() as SlackAppIdentity & { ok?: boolean }
  if (identity.ok !== true || (typeof identity.user_id !== "string" && typeof identity.bot_id !== "string")) return null

  const oldest = Math.max(0, (Date.parse(dispatchedAt) - 30_000) / 1000)
  const response = await fetch(`https://slack.com/api/conversations.history?channel=${encodeURIComponent(channelId)}&limit=100&oldest=${oldest}`, { headers })
  if (!response.ok) return null
  const payload = await response.json() as { ok?: boolean; messages?: SlackHistoryMessage[] }
  if (payload.ok !== true || !Array.isArray(payload.messages)) return null
  return selectDiagnosticRootTs(payload.messages, identity)
}

async function continuePendingDiagnostic(
  to: (channel: typeof slack, target: { channelId: string; threadTs: string; installationTeamId?: string }) => { send: (message: string, options: { auth: AutomationOwner["auth"] }) => Promise<unknown> },
  waitUntil: (task: Promise<unknown>) => void,
  owner: AutomationOwner,
  job: AutomationJob,
): Promise<void> {
  if (!job.acceptedSessionId || !job.dispatchedAt) return
  const threadTs = await findDiagnosticRootTs(owner.channelId, job.dispatchedAt)
  if (!threadTs) {
    console.warn("autonomous_diagnostic.continuation_root_not_found")
    return
  }
  const work = to(slack, {
    channelId: owner.channelId,
    threadTs,
    installationTeamId: owner.installationTeamId,
  }).send(continuationPrompt, { auth: owner.auth })
  waitUntil(work)
  await work
  console.info(JSON.stringify({
    event: "autonomous_diagnostic.continuation_dispatched",
    jobId: job.id,
    sessionId: job.acceptedSessionId,
    continuationCount: job.continuationCount ?? 0,
  }))
}

type DailyStore = Pick<AutomationStateStore, "armDaily">

export async function armDailyDiagnostic(
  store: DailyStore,
  now: Date,
  vercelEnv: string | undefined = process.env.VERCEL_ENV,
): Promise<AutomationJob | null> {
  if (vercelEnv !== "production") return null
  const dailyDate = dueDailyScheduleDate(now)
  if (!dailyDate) return null
  return store.armDaily(dailyDate)
}

// The minute dispatcher atomically arms one run per Berlin calendar date once
// 08:00 is reached, services explicit one-off jobs, and resumes pending turns.
export default defineSchedule({
  cron: "* * * * *",
  async run({ to, waitUntil }) {
    const store = new AutomationStateStore()
    const work = (async () => {
      const armed = await armDailyDiagnostic(store, new Date())
      if (armed) {
        console.info(JSON.stringify({ event: "autonomous_diagnostic.daily_armed", jobId: armed.id, dueAt: armed.dueAt }))
      }

      const diagnostic = runAutonomousDiagnostic({
        store,
        dispatch: (owner, prompt) => to(slack, {
          channelId: owner.channelId,
          installationTeamId: owner.installationTeamId,
          initialMessage: diagnosticInitialMessage,
        }).send(prompt, { auth: owner.auth }),
      })

      const continuation = (async () => {
        try {
          const state = await store.read()
          if (state?.job?.status === "dispatched" && state.job.acceptedSessionId) {
            const claimed = await store.claimContinuation(state.job.acceptedSessionId)
            if (claimed) await continuePendingDiagnostic(to, waitUntil, claimed.owner, claimed.job)
          }
        } catch (error) {
          console.warn(`autonomous_diagnostic.continuation_state_unavailable: ${error instanceof Error ? error.message : "unknown"}`)
        }
      })()

      return Promise.all([continuation, diagnostic]).then(([, result]) => result)
    })()
    waitUntil(work)
    await work
  },
})
