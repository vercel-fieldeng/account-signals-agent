import { randomUUID } from "node:crypto"
import { defineChannel, POST, type RouteHandlerArgs } from "eve/channels"
import slack from "./slack"
import { AUTOMATION_CHANNEL_ID } from "../../lib/signals/automation-policy"
import { runAutonomousDiagnostic } from "../../lib/signals/autonomous-diagnostic"
import { AutomationStateStore } from "../../lib/signals/automation-state"

type TriggerBody = { channelId?: unknown }

function conflictMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Automation trigger could not be accepted"
  if (message.includes("busy")) return "A diagnostic is already scheduled or running."
  if (message.includes("cooldown")) return "The previous diagnostic is still in its cooldown window."
  if (message.includes("not ready")) return "Automation is not configured or is paused."
  return "The diagnostic trigger could not be accepted."
}

async function trigger(request: Request, { to, waitUntil }: RouteHandlerArgs): Promise<Response> {
  let body: TriggerBody
  try {
    body = await request.json() as TriggerBody
  } catch {
    return Response.json({ ok: false, error: "invalid_json" }, { status: 400 })
  }

  if (body.channelId !== AUTOMATION_CHANNEL_ID) {
    return Response.json({ ok: false, error: "channel_not_allowed" }, { status: 400 })
  }

  const store = new AutomationStateStore()
  try {
    await store.armImmediate(`web:${randomUUID()}`)
    const work = runAutonomousDiagnostic({
      store,
      dispatch: (owner, prompt) => to(slack, {
        channelId: owner.channelId,
        installationTeamId: owner.installationTeamId,
      }).send(prompt, { auth: owner.auth }),
    })
    waitUntil(work)
    const result = await work
    if (result.kind === "dispatched") {
      return Response.json({ ok: true, status: "accepted" }, { status: 202 })
    }
    return Response.json({ ok: false, status: result.kind }, { status: 409 })
  } catch (error) {
    console.warn(`web_diagnostic_trigger_rejected: ${conflictMessage(error)}`)
    return Response.json({ ok: false, error: conflictMessage(error) }, { status: 409 })
  }
}

export default defineChannel({
  routes: [POST("/eve/v1/diagnostic-trigger", trigger)],
})
