import { describe, expect, it } from "vitest"
import { diagnosticSlackPost, isWaitingDiagnosticBluf, splitDiagnosticMessage } from "./autonomous-diagnostic-output"

describe("autonomous diagnostic Slack envelope", () => {
  it("splits the BLUF root from one detail reply", () => {
    expect(splitDiagnosticMessage("BLUF:\nNo human action flagged.\nDETAIL:\nContext checked: launch evidence."))
      .toEqual({
        bluf: "BLUF:\nNo human action flagged.",
        detail: "Context checked: launch evidence.",
      })
  })

  it("identifies d0 and context waiting roots so interim detail stays out of the thread", () => {
    expect(isWaitingDiagnosticBluf("BLUF: Running\nStatus: WAITING_FOR_D0 · Last 72h")).toBe(true)
    expect(isWaitingDiagnosticBluf("BLUF: Running\nStatus: WAITING_FOR_CONTEXT · Last 72h")).toBe(true)
    expect(isWaitingDiagnosticBluf("BLUF: Done\nStatus: Partial · Last 72h")).toBe(false)
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

  it("renders dynamic enriched account cards with a divider", () => {
    const post = diagnosticSlackPost(
      "BLUF: 2 accounts worth reviewing\nStatus: Complete · 72h · 4 signals · 2 accounts · Context 2/2\n*Account:* <https://example.test/personio|Personio>\n*Signal:* 3 signals · 2 RevOps signups + Head of RevOps webinar\n*Hypothesis:* Existing motion · RevOps may become an EAA pilot cohort. Confidence: High.\n*Contacts:* Christian Willems +2 · Route: Andru Dunn / James Arch\n*Next:* Validate whether RevOps is part of the internal-app initiative.\n*Account:* IQAir AG\n*Signal:* 1 signal · Web Tech Lead joined Agentic Shopify webinar\n*Hypothesis:* Existing motion · Adjacent to storefront and crawler-efficiency work. Confidence: Medium.\n*Contacts:* Ardit Dine · Route: Fay Lim\n*Next:* Ask whether the webinar maps to current storefront work.",
    )
    expect(post.blocks[0]).toEqual({
      type: "header",
      text: { type: "plain_text", text: "2 accounts worth reviewing" },
    })
    expect(post.blocks[1]).toMatchObject({ type: "context" })
    expect(post.blocks.filter((block) => block.type === "divider")).toHaveLength(1)
    const sections = post.blocks.filter((block): block is Extract<typeof block, { type: "section" }> => block.type === "section")
    expect(sections[0].text.text).toContain("*Account:* <https://example.test/personio|Personio>")
    expect(sections[0].text.text).toContain("*Hypothesis:*")
    expect(sections[1].text.text).toContain("*Account:* IQAir AG")
    expect(sections[1].text.text).toContain("*Next:*")
    expect(sections.map((section) => section.text.text).join("\n")).not.toContain("*Context:*")
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
