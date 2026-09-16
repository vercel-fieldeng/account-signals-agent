import { getToken } from "@vercel/connect"
import { defineSchedule } from "eve/schedules"
import slack from "../channels/slack"
import { runAutonomousDiagnostic } from "../../lib/signals/autonomous-diagnostic"
import { type AutomationOwner } from "../../lib/signals/automation-policy"
import { AutomationStateStore, type AutomationJob } from "../../lib/signals/automation-state"

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

const continuationPrompt = `Continue the existing autonomous diagnostic. Do not start a new d0 invocation and do not repeat roster discovery. Use the same d0 agent invocation handle from the previous turn and call agent_get until it reaches a terminal result, honoring every returned pollAfterMs. When d0 returns, produce the final BLUF/DETAIL response with the surfaced signal cards and AE/SA next steps. If the same invocation requires authorization, preserve it and report one concise business-facing blocker only.`

type SlackHistoryMessage = { ts?: unknown; bot_id?: unknown; subtype?: unknown; text?: unknown }

async function findDiagnosticRootTs(channelId: string, dispatchedAt: string): Promise<string | null> {
  const token = await getToken("slack/account-signals-slack", { subject: { type: "app" } })
  const oldest = Math.max(0, (Date.parse(dispatchedAt) - 30_000) / 1000)
  const response = await fetch(`https://slack.com/api/conversations.history?channel=${encodeURIComponent(channelId)}&limit=100&oldest=${oldest}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!response.ok) return null
  const payload = await response.json() as { ok?: boolean; messages?: SlackHistoryMessage[] }
  if (payload.ok !== true || !Array.isArray(payload.messages)) return null
  const candidates = payload.messages
    .filter((message) => typeof message.ts === "string" && (typeof message.bot_id === "string" || message.subtype === "bot_message"))
    .filter((message) => typeof message.text === "string" && message.text.includes("Account Signals"))
    .sort((a, b) => Number.parseFloat(String(b.ts)) - Number.parseFloat(String(a.ts)))
  return candidates.length > 0 ? String(candidates[0].ts) : null
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

// The dispatcher starts a due, explicitly authorized one-off job. If the
// previous Eve turn ended while d0 was pending, it resumes the same Slack
// session instead of starting a new d0 invocation.
export default defineSchedule({
  cron: "* * * * *",
  async run({ to, waitUntil }) {
    const diagnostic = runAutonomousDiagnostic({
      dispatch: (owner, prompt) => to(slack, {
        channelId: owner.channelId,
        installationTeamId: owner.installationTeamId,
        initialMessage: diagnosticInitialMessage,
      }).send(prompt, { auth: owner.auth }),
    })

    const store = new AutomationStateStore()
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

    const work = Promise.all([continuation, diagnostic]).then(([, result]) => result)
    waitUntil(work)
    await work
  },
})
