import { describe, expect, it } from "vitest"
import { isSlackThreadRoot } from "./slack-root"

describe("Slack diagnostic root detection", () => {
  it("accepts a rehydrated root without relying on isMe", () => {
    expect(isSlackThreadRoot({ ts: "123.456", threadTs: "123.456" }, "123.456")).toBe(true)
  })

  it("rejects replies and unrelated messages", () => {
    expect(isSlackThreadRoot({ ts: "123.789", threadTs: "123.456" }, "123.456")).toBe(false)
    expect(isSlackThreadRoot({ ts: "999.000", threadTs: "999.000" }, "123.456")).toBe(false)
    expect(isSlackThreadRoot(undefined, "123.456")).toBe(false)
  })
})
