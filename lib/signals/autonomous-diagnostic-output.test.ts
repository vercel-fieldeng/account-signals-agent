import { describe, expect, it } from "vitest"
import { diagnosticSlackPost, splitDiagnosticMessage } from "./autonomous-diagnostic-output"

describe("autonomous diagnostic Slack envelope", () => {
  it("splits the BLUF root from one detail reply", () => {
    expect(splitDiagnosticMessage("BLUF:\nNo human action flagged.\nDETAIL:\nContext checked: launch evidence."))
      .toEqual({
        bluf: "BLUF:\nNo human action flagged.",
        detail: "Context checked: launch evidence.",
      })
  })

  it("preserves markdown and multiline detail", () => {
    expect(splitDiagnosticMessage("BLUF:\n*Findings*\n1. Nintendo\nDETAIL:\n*Evidence*\n- source\n- hypothesis"))
      .toEqual({
        bluf: "BLUF:\n*Findings*\n1. Nintendo",
        detail: "*Evidence*\n- source\n- hypothesis",
      })
  })

  it("renders a visual Slack header, metadata context, and sections", () => {
    const post = diagnosticSlackPost(
      "BLUF: *No human action today*\n\nComparison: current window vs previous window\nScope: 5/5 verified\n\n*Findings*\n\nNo actionable findings after context checks.",
    )
    expect(post.text).toContain("BLUF:")
    expect(post.blocks[0]).toEqual({
      type: "header",
      text: { type: "plain_text", text: "No human action today" },
    })
    expect(post.blocks[1]).toMatchObject({ type: "context" })
    expect(post.blocks[2]).toMatchObject({ type: "section" })
  })

  it("converts model Markdown to Slack mrkdwn without changing code", () => {
    const post = diagnosticSlackPost(
      "BLUF: *Signal*\n\n**Findings**\n\n1. **Nintendo**\n- **Evidence:** [announcement](https://example.com/direct)\n- `**literal**`\n- ~~superseded~~",
    )
    const sectionTexts = post.blocks
      .filter((block): block is Extract<typeof block, { type: "section" }> => block.type === "section")
      .map((block) => block.text.text)
    const finding = sectionTexts.find((text) => text.includes("Nintendo"))
    if (!finding) throw new Error("Expected a finding section")

    expect(sectionTexts).toContain("*Findings*")
    expect(finding).toContain("1. *Nintendo*")
    expect(finding).toContain("• *Evidence:* <https://example.com/direct|announcement>")
    expect(finding).toContain("`**literal**`")
    expect(finding).toContain("~superseded~")
    expect(sectionTexts.join("\n")).not.toContain("**Findings**")
    expect(post.text).not.toContain("**Findings**")
  })

  it("rejects ordinary assistant output so it remains one message", () => {
    expect(splitDiagnosticMessage("Findings\n1. Account")).toBeNull()
    expect(splitDiagnosticMessage("BLUF:\nOnly a root message")).toBeNull()
    expect(splitDiagnosticMessage("BLUF:\nRoot\nDETAIL:")).toBeNull()
  })
})
