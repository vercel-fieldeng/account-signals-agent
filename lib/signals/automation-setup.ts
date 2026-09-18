import { connect } from "@vercel/connect/eve"
import type { ToolContext } from "eve/tools"
import { requireAutomationSetup } from "./automation-policy"
import { AutomationStateStore, type AutomationJob } from "./automation-state"
import { D0_CONNECTOR_UID, d0TokenParams } from "./d0-authorization"

export const AUTOMATION_CONNECTORS = [
  { name: "d0", uid: D0_CONNECTOR_UID, tokenParams: d0TokenParams },
] as const

type SetupStore = Pick<AutomationStateStore, "beginSetup" | "completeSetup">
type SetupContext = {
  getToken: (
    provider: Parameters<ToolContext["getToken"]>[0],
    options?: Parameters<ToolContext["getToken"]>[1],
  ) => Promise<unknown>
  session: {
    auth: ToolContext["session"]["auth"]
    parent?: unknown
  }
}

export type AutomationSetupResult = {
  status: "scheduled" | "already_registered"
  scheduledFor: string
  message: string
}

function result(status: AutomationSetupResult["status"], scheduledFor: string): AutomationSetupResult {
  return {
    status,
    scheduledFor,
    message:
      status === "already_registered"
        ? "This setup request was already processed; no new job was scheduled. Daily 08:00 Europe/Berlin automation remains registered. Consult automation status for the current job state. Source retrieval remains unverified."
        : `d0 grant resolved. Initial diagnostic scheduledFor ${scheduledFor} UTC and daily 08:00 Europe/Berlin automation enabled; consult automation status for the current job state. Source retrieval remains unverified.`,
  }
}

export async function executeAutomationSetup(
  ctx: SetupContext,
  store: SetupStore = new AutomationStateStore(),
  vercelEnv: string | undefined = process.env.VERCEL_ENV,
): Promise<AutomationSetupResult> {
  if (vercelEnv !== "production") throw new Error("Automation setup is available only in production")

  const { owner, requestId, requestedAt } = requireAutomationSetup(
    ctx.session.auth.current,
    Boolean(ctx.session.parent),
  )

  const registration = await store.beginSetup(owner, requestId, requestedAt)
  if (registration.scheduledFor !== null) return result("already_registered", registration.scheduledFor)

  // d0 is the only required source. Auth-control exceptions must cross this boundary unchanged.
  const connector = AUTOMATION_CONNECTORS[0]
  await ctx.getToken(connect({
    connector: connector.uid,
    tokenParams: connector.tokenParams(),
    principalType: "user",
    autoProvision: false,
    validate: true,
    displayName: connector.name,
  }))

  const job: AutomationJob = await store.completeSetup(registration.ticket)
  return result("scheduled", job.dueAt)
}

export type { SetupContext, SetupStore }
