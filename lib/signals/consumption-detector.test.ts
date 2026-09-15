import { describe, expect, it } from "vitest"
import { SCHEMA_VERSION, type Account, type SourceReference } from "./contracts"
import { InMemorySignalRepository } from "./storage"
import { createAccountId, createOwnerId } from "./stable-id"
import {
  detectAndStoreConsumptionGrowth,
  detectConsumptionGrowth,
  type ConsumptionGrowthInput,
} from "./consumption-detector"

const account: Account = {
  schemaVersion: SCHEMA_VERSION,
  id: createAccountId("sf-1"),
  sourceRecordId: "sf-1",
  name: "Example Co",
  domains: ["example.com"],
  careersUrl: null,
  linkedinCompanyUrl: null,
  owners: [{
    schemaVersion: SCHEMA_VERSION,
    id: createOwnerId("solutions_architect", "sam"),
    name: "Sam",
    role: "solutions_architect",
  }],
}
const source: SourceReference = {
  schemaVersion: SCHEMA_VERSION,
  system: "vercel_usage",
  recordId: "usage-1",
  url: null,
  collectedAt: "2026-09-15T00:00:00.000Z",
}
function input(overrides: Partial<ConsumptionGrowthInput> = {}): ConsumptionGrowthInput {
  return {
    account,
    source,
    metricName: "weekly_requests",
    unit: "requests",
    previous: {
      start: "2026-09-01T00:00:00.000Z",
      end: "2026-09-08T00:00:00.000Z",
      value: 100,
      completeness: 1,
      complete: true,
    },
    current: {
      start: "2026-09-08T00:00:00.000Z",
      end: "2026-09-15T00:00:00.000Z",
      value: 150,
      completeness: 1,
      complete: true,
    },
    ...overrides,
  }
}

describe("consumption growth detector", () => {
  it("emits validated deterministic previous/current evidence", () => {
    const first = detectConsumptionGrowth(input(), {
      minimumAbsoluteGrowth: 40,
      minimumRelativeGrowth: 0.4,
    })
    const second = detectConsumptionGrowth(input(), {
      minimumAbsoluteGrowth: 40,
      minimumRelativeGrowth: 0.4,
    })
    expect(first.reason).toBe("detected")
    expect(first.signal).toEqual(second.signal)
    expect(first.signal?.evidence.map((evidence) => evidence.attributes.window)).toEqual([
      "previous",
      "current",
    ])
  })

  it("requires both configurable gates", () => {
    expect(detectConsumptionGrowth(input(), { minimumAbsoluteGrowth: 60 }).reason).toBe(
      "below_threshold",
    )
    expect(detectConsumptionGrowth(input(), { minimumRelativeGrowth: 0.6 }).reason).toBe(
      "below_threshold",
    )
  })

  it("rejects mismatched, incomplete, late, and tiny-base windows", () => {
    expect(
      detectConsumptionGrowth(input({
        current: { ...input().current, start: "2026-09-09T00:00:00.000Z" },
      })).reason,
    ).toBe("window_mismatch")
    expect(
      detectConsumptionGrowth(
        input({ current: { ...input().current, completeness: 0.5 } }),
        { minimumCompleteness: 0.9 },
      ).reason,
    ).toBe("incomplete_data")
    expect(
      detectConsumptionGrowth(input({ current: { ...input().current, late: true } })).reason,
    ).toBe("late_data")
    expect(
      detectConsumptionGrowth(input({ previous: { ...input().previous, value: 1 } })).reason,
    ).toBe("tiny_base")
  })

  it("supports explicitly allowed late data and a window-size gate", () => {
    const result = detectConsumptionGrowth(
      input({ current: { ...input().current, late: true } }),
      { lateData: "allow", comparisonWindowMs: 7 * 24 * 60 * 60 * 1000 },
    )
    expect(result.reason).toBe("detected")
  })

  it("requires explicit finality instead of treating omitted completeness as final", () => {
    expect(detectConsumptionGrowth(input({
      previous: { ...input().previous, complete: undefined },
    })).reason).toBe("incomplete_data")
  })

  it("is idempotent when persisted", () => {
    const repository = new InMemorySignalRepository()
    const first = detectAndStoreConsumptionGrowth(repository, input())
    const second = detectAndStoreConsumptionGrowth(repository, input())
    expect(first.write?.inserted).toBe(true)
    expect(second.write?.inserted).toBe(false)
    expect(repository.listSignals()).toHaveLength(1)
  })
})
