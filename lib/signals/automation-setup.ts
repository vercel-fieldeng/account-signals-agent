import { connect } from "@vercel/connect/eve"
import type { ToolContext } from "eve/tools"
import { requireAutomationSetup } from "./automation-policy"
import { AutomationStateStore, type AutomationJob } from "./automation-state"
import { D0_CONNECTOR_UID, d0TokenParams } from "./d0-authorization"

export const AUTOMATION_CONNECTORS = [
  { name: "Salesforce", uid: "api.salesforce.com/salesforce-mcp", tokenParams: () => ({}) },
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
        ? "This setup request was already processed; no new job was scheduled. Consult automation status for the current job state. Source retrieval remains unverified."
        : `Both provider grants resolved. Native diagnostic scheduledFor ${scheduledFor} UTC; consult automation status for the current job state. Source retrieval remains unverified.`,
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

  // Deliberately resolve these grants in order. Auth-control exceptions must cross this boundary unchanged.
  await ctx.getToken(connect({
    connector: AUTOMATION_CONNECTORS[0].uid,
    tokenParams: AUTOMATION_CONNECTORS[0].tokenParams(),
    principalType: "user",
    autoProvision: false,
    validate: true,
    displayName: AUTOMATION_CONNECTORS[0].name,
  }))
  await ctx.getToken(connect({
    connector: AUTOMATION_CONNECTORS[1].uid,
    tokenParams: AUTOMATION_CONNECTORS[1].tokenParams(),
    principalType: "user",
    autoProvision: false,
    validate: true,
    displayName: AUTOMATION_CONNECTORS[1].name,
  }))

  const job: AutomationJob = await store.completeSetup(registration.ticket)
  return result("scheduled", job.dueAt)
}

export type { SetupContext, SetupStore }
