import type { SessionAuthContext } from "eve/context"
import { ALLOWED_SLACK_CHANNEL_ID } from "./slack-commands"

// Operator allowlist, not credentials or a substitute for verified channel auth.
// Operator comes from verified Slack messages; workspace comes from the linked
// Connect Slack connector's defaultInstallationId / data.slackTeam.id (not display metadata).
export const AUTOMATION_OPERATOR_USER_ID = "U0BK7DNK999"
export const AUTOMATION_WORKSPACE_ID = "T0CAQ00TU"
export const AUTOMATION_CHANNEL_ID = ALLOWED_SLACK_CHANNEL_ID
export const AUTOMATION_SETUP_MARKER = "automation_setup_request"

export type AutomationOwner = {
  auth: SessionAuthContext
  channelId: string
  installationTeamId: string
}

export type AutomationCommand = "setup" | "status" | "pause" | null

export function classifyAutomationCommand(text: string): AutomationCommand {
  const command = text.replace(/^<@[A-Z0-9]+(?:\|[^>]+)?>\s*/i, "").trim().toLowerCase()
  if (command === "setup automation") return "setup"
  if (command === "automation status") return "status"
  if (command === "pause automation") return "pause"
  return null
}

export type AutomationAdmissionCode =
  | "missing_user_identity"
  | "unverified_slack_identity"
  | "not_human_user"
  | "operator_not_allowed"
  | "channel_not_allowed"
  | "workspace_not_allowed"
  | "principal_mismatch"

export class AutomationAdmissionError extends Error {
  constructor(readonly code: AutomationAdmissionCode) {
    super(`Automation admission rejected: ${code}`)
    this.name = "AutomationAdmissionError"
  }
}

export function requireAutomationOperator(auth: SessionAuthContext | null | undefined): SessionAuthContext {
  if (!auth) throw new AutomationAdmissionError("missing_user_identity")
  if (auth.authenticator !== "slack-webhook") throw new AutomationAdmissionError("unverified_slack_identity")
  if (auth.principalType !== "user" || auth.attributes?.author_type !== "user") {
    throw new AutomationAdmissionError("not_human_user")
  }
  if (auth.attributes?.user_id !== AUTOMATION_OPERATOR_USER_ID) throw new AutomationAdmissionError("operator_not_allowed")
  if (auth.attributes?.channel_id !== AUTOMATION_CHANNEL_ID) throw new AutomationAdmissionError("channel_not_allowed")
  if (auth.attributes?.team_id !== AUTOMATION_WORKSPACE_ID || auth.issuer !== `slack:${AUTOMATION_WORKSPACE_ID}`) {
    throw new AutomationAdmissionError("workspace_not_allowed")
  }
  if (auth.principalId !== `slack:${AUTOMATION_WORKSPACE_ID}:${AUTOMATION_OPERATOR_USER_ID}`) {
    throw new AutomationAdmissionError("principal_mismatch")
  }
  return auth
}

export function automationOwnerFromAuth(auth: SessionAuthContext | null | undefined): AutomationOwner {
  const verified = requireAutomationOperator(auth)
  return {
    auth: {
      authenticator: verified.authenticator,
      principalId: verified.principalId,
      principalType: "user",
      issuer: verified.issuer,
      attributes: {
        user_id: AUTOMATION_OPERATOR_USER_ID,
        team_id: AUTOMATION_WORKSPACE_ID,
        channel_id: AUTOMATION_CHANNEL_ID,
        author_type: "user",
      },
    },
    channelId: AUTOMATION_CHANNEL_ID,
    installationTeamId: AUTOMATION_WORKSPACE_ID,
  }
}

export function validateAutomationOwner(owner: AutomationOwner): AutomationOwner {
  if (owner.channelId !== AUTOMATION_CHANNEL_ID || owner.installationTeamId !== AUTOMATION_WORKSPACE_ID) {
    throw new Error("Automation destination is not allowed")
  }
  const normalized = automationOwnerFromAuth(owner.auth)
  // Persisted bindings must never carry setup privileges or arbitrary attributes.
  if (Object.keys(owner.auth.attributes).some((key) => !(key in normalized.auth.attributes))) {
    throw new Error("Automation owner contains unsupported attributes")
  }
  return normalized
}

export function slackTimestampToIso(timestamp: string): string {
  if (!/^\d{10,13}\.\d{6}$/.test(timestamp)) throw new Error("Invalid Slack request timestamp")
  const [seconds, microseconds] = timestamp.split(".")
  const date = new Date(Number(seconds) * 1000)
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid Slack request timestamp")
  // Slack orders events at microsecond precision; Date alone would lose a newer pause.
  return date.toISOString().replace(/\.\d{3}Z$/, `.${microseconds}Z`)
}

// Call only from Eve's verified onAppMention callback, never from a tool input.
export function automationSetupAuth(auth: SessionAuthContext, messageTs: string): SessionAuthContext {
  requireAutomationOperator(auth)
  slackTimestampToIso(messageTs)
  return {
    ...auth,
    attributes: {
      ...auth.attributes,
      [AUTOMATION_SETUP_MARKER]: `${AUTOMATION_WORKSPACE_ID}:${AUTOMATION_OPERATOR_USER_ID}:${AUTOMATION_CHANNEL_ID}:${messageTs}`,
    },
  }
}

export function requireAutomationSetup(auth: SessionAuthContext | null | undefined, delegated = false) {
  if (delegated) throw new Error("Automation setup cannot be delegated")
  const verified = requireAutomationOperator(auth)
  const requestId = verified.attributes[AUTOMATION_SETUP_MARKER]
  const prefix = `${AUTOMATION_WORKSPACE_ID}:${AUTOMATION_OPERATOR_USER_ID}:${AUTOMATION_CHANNEL_ID}:`
  if (typeof requestId !== "string" || !requestId.startsWith(prefix)) {
    throw new Error("Send the exact setup automation command to authorize this operation")
  }
  return {
    owner: automationOwnerFromAuth(verified),
    requestId,
    requestedAt: slackTimestampToIso(requestId.slice(prefix.length)),
  }
}
