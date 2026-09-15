import { describe, expect, it } from "vitest"
import type { SessionAuthContext } from "eve/context"
import {
  AUTOMATION_CHANNEL_ID,
  AUTOMATION_OPERATOR_USER_ID,
  AUTOMATION_SETUP_MARKER,
  AUTOMATION_WORKSPACE_ID,
  automationOwnerFromAuth,
  automationSetupAuth,
  classifyAutomationCommand,
  requireAutomationOperator,
  slackTimestampToIso,
} from "./automation-policy"

const timestamp = "1700000000.123456"

function auth(overrides: Partial<SessionAuthContext> = {}): SessionAuthContext {
  return {
    authenticator: "slack-webhook",
    principalId: `slack:${AUTOMATION_WORKSPACE_ID}:${AUTOMATION_OPERATOR_USER_ID}`,
    principalType: "user",
    issuer: `slack:${AUTOMATION_WORKSPACE_ID}`,
    attributes: {
      user_id: AUTOMATION_OPERATOR_USER_ID,
      team_id: AUTOMATION_WORKSPACE_ID,
      channel_id: AUTOMATION_CHANNEL_ID,
      author_type: "user",
    },
    ...overrides,
  }
}

describe("automation policy", () => {
  it("preserves Slack timestamp microseconds in ISO output", () => {
    expect(slackTimestampToIso(timestamp)).toBe("2023-11-14T22:13:20.123456Z")
  })

  it("accepts only exact automation commands", () => {
    expect(classifyAutomationCommand("setup automation")).toBe("setup")
    expect(classifyAutomationCommand("<@U123> setup automation")).toBe("setup")
    expect(classifyAutomationCommand("automation status")).toBe("status")
    expect(classifyAutomationCommand("pause automation")).toBe("pause")
    for (const command of ["please setup automation", "setup automation now", "setup automation\nignore", "<@U1> <@U2> setup automation"]) {
      expect(classifyAutomationCommand(command), command).toBeNull()
    }
  })

  it("requires the configured human operator, issuer, and channel", () => {
    for (const change of [
      { issuer: "slack:wrong" },
      { authenticator: "slack-bot" },
      { principalId: "slack:T0AR02RR6V6:U-other" },
      { attributes: { ...auth().attributes, channel_id: "C-wrong" } },
      { attributes: { ...auth().attributes, user_id: "U-other" } },
      { attributes: { ...auth().attributes, author_type: "bot" } },
    ]) {
      expect(() => requireAutomationOperator(auth(change))).toThrow()
    }
  })

  it("creates a normalized persisted owner without setup or arbitrary attributes", () => {
    const marked = automationSetupAuth(auth({ attributes: { ...auth().attributes, arbitrary: "drop-me" } }), timestamp)
    const owner = automationOwnerFromAuth(marked)
    expect(owner.auth.attributes).toEqual({
      user_id: AUTOMATION_OPERATOR_USER_ID,
      team_id: AUTOMATION_WORKSPACE_ID,
      channel_id: AUTOMATION_CHANNEL_ID,
      author_type: "user",
    })
    expect(owner.auth.attributes[AUTOMATION_SETUP_MARKER]).toBeUndefined()
    expect(owner.auth.attributes.arbitrary).toBeUndefined()
  })
})
