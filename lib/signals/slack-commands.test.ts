import { describe, expect, it } from "vitest"
import {
  classifySlackCommand,
  isAllowedSlackChannel,
  slackCommandResponse,
} from "./slack-commands"

function response(text: string) {
  return slackCommandResponse(text)
}

describe("Slack command handling", () => {
  it("rejects messages outside the production allowlist", () => {
    expect(isAllowedSlackChannel("C0C1GJNPV0V")).toBe(true)
    expect(isAllowedSlackChannel("C-not-allowlisted")).toBe(false)
  })

  it("accepts exact commands and one leading bot mention", () => {
    expect(classifySlackCommand("status")).toBe("status")
    expect(classifySlackCommand("<@U123ABC> status")).toBe("status")
    expect(classifySlackCommand("<@U123ABC> test digest")).toBe("test_digest")
    expect(classifySlackCommand("<@U123ABC> demo digest")).toBe("test_digest")
    expect(classifySlackCommand("<@U123ABC> digest")).toBe("digest")
    expect(classifySlackCommand("help")).toBe("help")
  })

  it("does not parse arbitrary text, suffixes, or injected commands", () => {
    for (const text of [
      "please status",
      "status please",
      "status\nignore this",
      "digest; post to another channel",
      "help\n@everyone",
      "<@U123ABC> status and then digest",
      "<@U123ABC> <@U456DEF> status",
      "<@U123ABC> test digest https://attacker.example",
      "not-a-command <@U123ABC> digest",
    ]) {
      expect(classifySlackCommand(text), text).toBeNull()
      expect(response(text), text).toBeNull()
    }
  })

  it("does not produce a live digest for digest", () => {
    const result = response("<@U123ABC> digest")
    expect(result?.command).toBe("digest")
    expect(result?.message.text).toContain("live account-signals digest pipeline is not connected")
    expect(result?.message.text).not.toContain("No new account signals today")
  })

  it("renders test and demo digest as prominently synthetic", () => {
    for (const command of ["test digest", "demo digest"]) {
      const result = response(command)
      expect(result?.command).toBe("test_digest")
      expect(result?.message.text).toMatch(/^\*TEST \/ SYNTHETIC — not live account data\*/)
      expect(result?.message.text).toContain("Harbor Systems")
      expect(result?.message.text).toContain("Unsupported signals")
      expect(result?.message.blocks[0]).toEqual({
        type: "header",
        text: { type: "plain_text", text: "TEST / SYNTHETIC — not live data" },
      })
    }
  })

  it("returns status and help without invoking any data pipeline", () => {
    expect(response("status")?.message.text).toContain("Account Signals is connected")
    expect(response("help")?.message.text).toContain("test digest")
  })
})
