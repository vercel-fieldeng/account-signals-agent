import { defineSchedule } from "eve/schedules"
import slack from "../channels/slack"
import { runAutonomousDiagnostic } from "../../lib/signals/autonomous-diagnostic"

// The dispatcher only starts a due, explicitly authorized one-off job.
// An absent, pending, paused or already-claimed job never invokes the agent.
export default defineSchedule({
  cron: "* * * * *",
  async run({ to, waitUntil }) {
    const work = runAutonomousDiagnostic({
      dispatch: (owner, prompt) => to(slack, {
        channelId: owner.channelId,
        installationTeamId: owner.installationTeamId,
      }).send(prompt, { auth: owner.auth }),
    })
    waitUntil(work)
    await work
  },
})
