import { describe, expect, it } from "vitest"
import { normalizedSignalSchema } from "./contracts"
import { createSignalDigest, normalizeSignal, summarizeAccount } from "./normalize"
import { redactedSignals } from "./redacted-fixtures"

describe("signal contracts", () => {
  it("accepts redacted source-neutral fixtures", () => {
    expect(redactedSignals.map(normalizeSignal)).toHaveLength(3)
  })

  it("rejects records that omit account identity", () => {
    const { accountId: _accountId, ...invalidSignal } = redactedSignals[0]

    expect(() => normalizedSignalSchema.parse(invalidSignal)).toThrow()
  })
})

describe("account summaries", () => {
  it("separates expansion and risk signals and scores severity", () => {
    const summary = summarizeAccount(
      redactedSignals.filter((signal) => signal.accountId === "acct_redacted_001"),
      "2026-09-14T09:00:00.000Z",
    )

    expect(summary.expansionSignals).toHaveLength(2)
    expect(summary.riskSignals).toHaveLength(0)
    expect(summary.expansionScore).toBe(80)
    expect(summary.latestSignalAt).toBe("2026-09-14T08:00:00.000Z")
  })

  it("rejects mixed-account summaries", () => {
    expect(() =>
      summarizeAccount(redactedSignals, "2026-09-14T09:00:00.000Z"),
    ).toThrow("share an accountId")
  })
})

describe("signal digests", () => {
  it("ranks the strongest account signal first", () => {
    const digest = createSignalDigest(
      redactedSignals,
      "2026-09-13T09:00:00.000Z",
      "2026-09-14T09:00:00.000Z",
    )

    expect(digest.accounts.map((account) => account.accountName)).toEqual([
      "Northstar Labs",
      "Harbor Systems",
    ])
    expect(digest.accounts[1].riskScore).toBe(50)
  })
})
