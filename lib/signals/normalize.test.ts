import { describe, expect, it } from "vitest"
import {
  accountSchema,
  normalizedSignalSchema,
  observationSchema,
  runResultSchema,
  signalCategorySchema,
  snapshotSchema,
} from "./contracts"
import { createSignalDigest, normalizeSignal, summarizeAccount } from "./normalize"
import {
  redactedAccounts,
  redactedObservations,
  redactedRunResult,
  redactedSignals,
  redactedSnapshots,
} from "./redacted-fixtures"
import { createSignalId, createStableId } from "./stable-id"

describe("shared signal contracts", () => {
  it("validates account, observation, snapshot, signal, and run-result fixtures", () => {
    expect(redactedAccounts.map((account) => accountSchema.parse(account))).toHaveLength(2)
    expect(
      redactedObservations.map((observation) => observationSchema.parse(observation)),
    ).toHaveLength(4)
    expect(redactedSnapshots.map((snapshot) => snapshotSchema.parse(snapshot))).toHaveLength(
      4,
    )
    expect(redactedSignals.map(normalizeSignal)).toHaveLength(4)
    expect(runResultSchema.parse(redactedRunResult).signals).toHaveLength(4)
  })

  it("covers every supported signal category", () => {
    expect(new Set(redactedSignals.map((signal) => signal.category))).toEqual(
      new Set(signalCategorySchema.options),
    )
  })

  it("requires account, source, observed-at time, evidence, and confidence", () => {
    const requiredFields = [
      "account",
      "source",
      "observedAt",
      "evidence",
      "confidence",
    ] as const

    for (const field of requiredFields) {
      const invalidSignal = { ...redactedSignals[0] } as Record<string, unknown>
      delete invalidSignal[field]
      expect(normalizedSignalSchema.safeParse(invalidSignal).success).toBe(false)
    }
  })

  it("rejects evidence that does not match the signal source", () => {
    const invalidSignal = {
      ...redactedSignals[0],
      evidence: [redactedSignals[2].evidence[0]],
    }

    expect(normalizedSignalSchema.safeParse(invalidSignal).success).toBe(false)
  })
})

describe("stable IDs", () => {
  it("is deterministic and unambiguous across identity parts", () => {
    expect(createStableId("signal", "account-1", "record-2")).toBe(
      createStableId("signal", "account-1", "record-2"),
    )
    expect(createStableId("signal", "ab", "c")).not.toBe(
      createStableId("signal", "a", "bc"),
    )
  })

  it("changes when any signal identity field changes", () => {
    const signal = redactedSignals[0]
    const originalId = createSignalId(
      signal.account.id,
      signal.category,
      signal.source.system,
      signal.source.recordId,
      signal.observedAt,
    )
    const changedId = createSignalId(
      signal.account.id,
      signal.category,
      signal.source.system,
      "different-record",
      signal.observedAt,
    )

    expect(originalId).toBe(signal.id)
    expect(changedId).not.toBe(originalId)
  })
})

describe("account summaries", () => {
  it("separates expansion and risk signals and scores severity", () => {
    const summary = summarizeAccount(
      redactedSignals.filter(
        (signal) => signal.account.id === redactedAccounts[0].id,
      ),
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
    ).toThrow("share an account ID")
  })
})

describe("signal digests", () => {
  it("ranks the strongest account signal first", () => {
    const digest = createSignalDigest(
      redactedSignals,
      "2026-09-13T09:00:00.000Z",
      "2026-09-14T09:00:00.000Z",
    )

    expect(digest.accounts.map(({ account }) => account.name)).toEqual([
      "Northstar Labs",
      "Harbor Systems",
    ])
    expect(digest.accounts[1].riskScore).toBe(50)
  })
})
