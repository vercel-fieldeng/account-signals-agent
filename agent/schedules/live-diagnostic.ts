import { defineSchedule } from "eve/schedules"
import slack from "../channels/slack"
import { runAutonomousDiagnostic } from "../../lib/signals/autonomous-diagnostic"

const diagnosticInitialMessage = {
  // Eve's Chat SDK CardElement is structurally represented here so the
  // proactive Slack receive has a visible root before the model runs.
  card: {
    type: "card",
    title: "Account Signals — running",
    children: [{ type: "text", content: "Resolving the verified Salesforce roster and starting source checks…" }],
  } as never,
  fallbackText: "Account Signals — running\nResolving the verified Salesforce roster and starting source checks…",
}

// The dispatcher only starts a due, explicitly authorized one-off job.
// An absent, pending, paused or already-claimed job never invokes the agent.
export default defineSchedule({
  cron: "* * * * *",
  async run({ to, waitUntil }) {
    const work = runAutonomousDiagnostic({
      dispatch: (owner, prompt) => to(slack, {
        channelId: owner.channelId,
        installationTeamId: owner.installationTeamId,
        initialMessage: diagnosticInitialMessage,
      }).send(prompt, { auth: owner.auth }),
    })
    waitUntil(work)
    await work
  },
})
