import { describe, expect, it } from "vitest"
import { createSignalDigest } from "./normalize"
import { redactedSignals } from "./redacted-fixtures"
import { renderDailyDigest } from "./digest"
import { createAccountId } from "./stable-id"

const digest = createSignalDigest(
  redactedSignals,
  "2026-09-13T09:00:00.000Z",
  "2026-09-14T09:00:00.000Z",
  "2026-09-14T09:00:01.000Z",
)

describe("daily digest rendering", () => {
  it("renders deterministic ranked plain text and Slack payloads", () => {
    const result = renderDailyDigest({
      digest,
      run: { status: "succeeded", errors: [] },
    })

    expect(result.text).toContain("Daily account signals — 2026-09-14")
    expect(result.text).toContain("Account coverage: 2/2")
    expect(result.text).toContain("IT company news")
    expect(result.text).toContain("Why: Infrastructure consolidation announced")
    expect(result.text).toContain("Evidence: Company-authored infrastructure update")
    expect(result.text).toContain("Observed: 2026-09-14")
    expect(result.text).toContain("<https://harbor.example/news/infrastructure-update|source>")
    expect(result.slack.blocks[0]).toEqual({
      type: "header",
      text: { type: "plain_text", text: "Daily account signals — 2026-09-14" },
    })
    expect(result.slack.text).toBe(result.text)
    expect(result.text.length).toBeLessThanOrEqual(1_800)
    expect(result.text).toContain("1. *Harbor Systems*")
    expect(result.text).not.toContain("2. *Harbor Systems*")
  })

  it("keeps visible finding numbers contiguous and account-distinct", () => {
    const signals = redactedSignals.slice(0, 3).map((signal, index) => {
      const source = { ...signal.source, url: `https://example.test/source-${index}` }
      return {
        ...signal,
        account: { ...signal.account, id: createAccountId(`digest-account-${index}`), name: `Account ${index + 1}` },
        source,
        evidence: signal.evidence.map((evidence) => ({ ...evidence, source })),
      }
    })
    const result = renderDailyDigest(createSignalDigest(
      signals,
      "2026-09-13T09:00:00.000Z",
      "2026-09-14T09:00:00.000Z",
      "2026-09-14T09:00:01.000Z",
    ))
    const findingLines = result.text.split("\n").filter((line) => /^\d+\. /.test(line))
    expect(findingLines.map((line) => line.slice(0, 2))).toEqual(["1.", "2.", "3."])
    expect(result.text).not.toMatch(/\n4\. /)
    expect(result.text.length).toBeLessThanOrEqual(1_800)
  })

  it("labels partial runs visibly", () => {
    const result = renderDailyDigest({
      digest,
      run: {
        status: "partial",
        errors: [
          {
            source: "company_news",
            code: "timeout",
            message: "timed out",
            retryable: true,
          },
        ],
      },
    })

    expect(result.text).toContain("Status: PARTIAL — 1 source failure")
  })

  it("renders a healthy empty state", () => {
    const emptyDigest = { ...digest, accounts: [] }
    const result = renderDailyDigest(emptyDigest)

    expect(result.text).toContain("Account coverage: 0/0")
    expect(result.text).toContain("No new account signals today. Coverage is healthy.")
    expect(result.truncated).toBe(false)
  })

  it("truncates deterministically without splitting an opportunity", () => {
    const first = renderDailyDigest(digest, { maxChars: 700 })
    const second = renderDailyDigest(digest, { maxChars: 700 })

    expect(first).toEqual(second)
    expect(first.truncated).toBe(true)
    expect(first.text).toContain("additional signals truncated for Slack size limits")
    expect(first.text.length).toBeLessThanOrEqual(700)
  })

  it("isolates URL-less signals from rendered opportunity claims", () => {
    const result = renderDailyDigest(digest)

    expect(result.text).toContain("Unsupported signals — source URL unavailable")
    expect(result.text).not.toContain("Production usage accelerated")
    expect(result.text).not.toContain("Weekly requests increased")
    expect(result.opportunities.some((opportunity) => opportunity.sourceUrl === null)).toBe(true)
  })

  it("rejects malformed source URLs as rendered claims", () => {
    const malformed = {
      ...digest,
      accounts: digest.accounts.map((account) => ({
        ...account,
        ...Object.fromEntries(
          (["expansionSignals", "riskSignals", "neutralSignals"] as const).map((key) => [
            key,
            account[key].map((signal) => ({
              ...signal,
              source: { ...signal.source, url: "not a URL" },
              evidence: signal.evidence.map((evidence) => ({
                ...evidence,
                source: { ...evidence.source, url: "also not a URL" },
              })),
            })),
          ]),
        ),
      })),
    }
    const result = renderDailyDigest(malformed)

    expect(result.text).toContain("Unsupported signals — source URL unavailable")
    expect(result.text).not.toContain("Why:")
  })
})
