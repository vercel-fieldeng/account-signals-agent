import { describe, expect, it, vi } from "vitest"
import { AUTOMATION_CHANNEL_ID, AUTOMATION_OPERATOR_USER_ID, AUTOMATION_WORKSPACE_ID, AutomationAdmissionError } from "./automation-policy"

type AppMention = (ctx: { thread: { post: (text: string) => Promise<void> } }, message: { channelId: string; text: string; ts: string }) => Promise<unknown>
const defaultSlackAuth = vi.hoisted(() => vi.fn())
const control = vi.hoisted(() => vi.fn())
const slackChannel = vi.hoisted(() => vi.fn((definition: Record<string, unknown>) => definition))

vi.doMock("@vercel/connect/eve", () => ({ connectSlackCredentials: vi.fn(() => "credentials") }))
vi.doMock("eve/channels/slack", () => ({
  defaultSlackAuth,
  slackChannel,
}))
vi.doMock("../../lib/signals/automation-control", () => ({ handleAutomationControl: control }))
vi.doMock("../../lib/signals/slack-commands", () => ({ ALLOWED_SLACK_CHANNEL_ID: "C0C1GJNPV0V", isAllowedSlackChannel: vi.fn(() => true), slackCommandResponse: vi.fn(() => null) }))

await import("../../agent/channels/slack")
const definition = slackChannel.mock.calls[0]?.[0]
const onAppMention = definition?.onAppMention
if (typeof onAppMention !== "function") throw new Error("Slack channel did not register onAppMention")
const auth = { authenticator: "slack-webhook", principalId: `slack:${AUTOMATION_WORKSPACE_ID}:${AUTOMATION_OPERATOR_USER_ID}`, principalType: "user", issuer: `slack:${AUTOMATION_WORKSPACE_ID}`, attributes: { user_id: AUTOMATION_OPERATOR_USER_ID, team_id: AUTOMATION_WORKSPACE_ID, channel_id: AUTOMATION_CHANNEL_ID, author_type: "user" } }

describe("automation Slack channel integration", () => {
  it("uses verified defaultSlackAuth and opens an agent only for exact setup", async () => {
    const thread = { post: vi.fn(async () => undefined) }
    const ctx = { thread }
    defaultSlackAuth.mockReturnValue(auth)
    control.mockResolvedValue({ kind: "setup", auth, context: ["setup context"] })
    const result = await onAppMention(ctx, { channelId: AUTOMATION_CHANNEL_ID, text: "setup automation", ts: "1700000000.123456" })
    expect(defaultSlackAuth).toHaveBeenCalledWith(expect.objectContaining({ text: "setup automation" }), ctx)
    expect(result).toEqual({ auth, context: ["setup context"], title: "Automation authorization setup" })
    expect(thread.post).not.toHaveBeenCalled()
  })

  it("returns null after posting status and pause replies", async () => {
    const thread = { post: vi.fn(async () => undefined) }
    const ctx = { thread }
    defaultSlackAuth.mockReturnValue(auth)
    for (const command of ["automation status", "pause automation"]) {
      control.mockResolvedValueOnce({ kind: "reply", text: `${command} reply` })
      await expect(onAppMention(ctx, { channelId: AUTOMATION_CHANNEL_ID, text: command, ts: "1700000000.123456" })).resolves.toBeNull()
    }
    expect(thread.post).toHaveBeenNthCalledWith(1, "automation status reply")
    expect(thread.post).toHaveBeenNthCalledWith(2, "pause automation reply")
  })

  it("reports a specific safe admission code without leaking arbitrary errors", async () => {
    const thread = { post: vi.fn(async () => undefined) }
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      defaultSlackAuth.mockReturnValue(auth)
      control.mockRejectedValueOnce(new AutomationAdmissionError("workspace_not_allowed"))
      await onAppMention({ thread }, { channelId: AUTOMATION_CHANNEL_ID, text: "setup automation", ts: "1700000000.123456" })
      expect(warning).toHaveBeenLastCalledWith("automation_control_failed: workspace_not_allowed")
      expect(thread.post).toHaveBeenLastCalledWith(expect.stringContaining("workspace_not_allowed"))

      control.mockRejectedValueOnce(new Error("token=do-not-disclose"))
      await onAppMention({ thread }, { channelId: AUTOMATION_CHANNEL_ID, text: "setup automation", ts: "1700000000.123456" })
      expect(warning).toHaveBeenLastCalledWith("automation_control_failed: state_or_message")
      expect(JSON.stringify(thread.post.mock.calls)).not.toContain("do-not-disclose")
      expect(JSON.stringify(warning.mock.calls)).not.toContain("do-not-disclose")
    } finally {
      warning.mockRestore()
    }
  })
})
