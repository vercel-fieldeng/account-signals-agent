import { describe, expect, it } from "vitest"
import { ingestUsageMetrics, type RawUsageMetricRow, type UsageMetricClient } from "./usage-source"

const row = (accountId: string, observedAt: string, value: number, receivedAt = observedAt): RawUsageMetricRow => ({
  accountId, metric: "consumption", value, unit: "requests", observedAt, receivedAt,
})

class FixtureClient implements UsageMetricClient {
  calls: { startedAt: string; endedAt: string }[] = []
  constructor(private readonly rows: readonly RawUsageMetricRow[]) {}
  async read(window: { startedAt: string; endedAt: string }) {
    this.calls.push(window)
    return this.rows
  }
}

const start = "2026-09-08T00:00:00+02:00"
const end = "2026-09-15T00:00:00+02:00"
const fixtureRows: RawUsageMetricRow[] = [
  ...Array.from({ length: 7 }, (_, index) => row("stable", `2026-09-${String(1 + index).padStart(2, "0")}T00:00:00Z`, 10)),
  ...Array.from({ length: 7 }, (_, index) => row("stable", `2026-09-${String(8 + index).padStart(2, "0")}T00:00:00Z`, 10)),
  ...Array.from({ length: 7 }, (_, index) => row("rising", `2026-09-${String(8 + index).padStart(2, "0")}T00:00:00Z`, 20)),
  ...Array.from({ length: 7 }, (_, index) => row("rising", `2026-09-${String(1 + index).padStart(2, "0")}T00:00:00Z`, 10)),
  row("sparse", "2026-09-08T00:00:00Z", 4),
  row("late", "2026-09-14T00:00:00Z", 3, "2026-09-15T06:00:00+02:00"),
]

describe("usage source adapter", () => {
  it("normalizes UTC, bounds the comparison query, and classifies series", async () => {
    const client = new FixtureClient(fixtureRows)
    const result = await ingestUsageMetrics(client, {
      windowStartedAt: start, windowEndedAt: end,
      accountIds: ["missing"], comparisonWindowDays: 90,
      currentWindowFinality: "final", comparisonWindowFinality: "final",
    })

    expect(result.window).toEqual({ startedAt: "2026-09-07T22:00:00.000Z", endedAt: "2026-09-14T22:00:00.000Z" })
    expect(result.comparisonWindowDays).toBe(7)
    expect(client.calls).toEqual([{ startedAt: "2026-08-31T22:00:00.000Z", endedAt: "2026-09-14T22:00:00.000Z" }])
    expect(Object.fromEntries(result.series.map((series) => [series.accountId, series.status]))).toEqual({
      late: "sparse", missing: "missing", rising: "rising", sparse: "sparse", stable: "stable",
    })
    expect(result.series.find((series) => series.accountId === "late")?.latePointCount).toBe(1)
    expect(result.series.find((series) => series.accountId === "late")?.maxLatencyMs).toBe(100_800_000)
  })

  it("deduplicates points deterministically and validates configured metric and grain", async () => {
    const result = await ingestUsageMetrics(new FixtureClient([
      { ...row("dedupe", "2026-09-08T00:00:00Z", 2, "2026-09-08T01:00:00Z"), grain: "day" },
      { ...row("dedupe", "2026-09-08T00:00:00Z", 3, "2026-09-08T02:00:00Z"), grain: "day" },
    ]), { windowStartedAt: "2026-09-08T00:00:00Z", windowEndedAt: "2026-09-10T00:00:00Z", metric: "consumption", grain: "day" })
    expect(result.series[0].points).toHaveLength(1)
    expect(result.series[0].currentValue).toBe(3)
    await expect(ingestUsageMetrics(new FixtureClient([{ ...row("bad", "2026-09-08T00:00:00Z", 1), metric: "bad-metric" }]), {
      windowStartedAt: "2026-09-08T00:00:00Z", windowEndedAt: "2026-09-10T00:00:00Z", metric: "consumption",
    })).rejects.toThrow("configured metric")
  })

  it("normalizes compatible units and rejects invalid or incompatible data", async () => {
    const client = new FixtureClient([
      { ...row("bytes", "2026-09-08T00:00:00Z", 2), unit: "KB" },
      { ...row("bytes", "2026-09-09T00:00:00Z", 1), unit: "MB" },
    ])
    const result = await ingestUsageMetrics(client, {
      windowStartedAt: "2026-09-08T00:00:00Z", windowEndedAt: "2026-09-10T00:00:00Z",
      expectedIntervalHours: 24,
    })
    expect(result.series[0]).toMatchObject({ unit: "bytes", currentValue: 1_002_000 })
    await expect(ingestUsageMetrics(new FixtureClient([row("bad", "not-a-date", 1)]), {
      windowStartedAt: "2026-09-08T00:00:00Z", windowEndedAt: "2026-09-10T00:00:00Z",
    })).rejects.toThrow()
  })

  it("keeps calendar coverage separate from source finality", async () => {
    const result = await ingestUsageMetrics(new FixtureClient([
      ...Array.from({ length: 7 }, (_, index) => row("settling", `2026-09-${String(8 + index).padStart(2, "0")}T00:00:00Z`, 20)),
      ...Array.from({ length: 7 }, (_, index) => row("settling", `2026-09-${String(1 + index).padStart(2, "0")}T00:00:00Z`, 10)),
    ]), {
      windowStartedAt: "2026-09-08T00:00:00Z", windowEndedAt: "2026-09-15T00:00:00Z",
      currentWindowFinality: "provisional", comparisonWindowFinality: "final",
    })
    const series = result.series[0]
    expect(series).toMatchObject({
      status: "incomplete", completeness: 1, currentCompleteness: 1, previousCompleteness: 1,
      currentFinality: "provisional", previousFinality: "final",
    })
    expect(series.status).not.toBe("stable")
    expect(series.status).not.toBe("rising")
  })

  it("counts daily buckets once and does not turn a zero denominator into a growth ratio", async () => {
    const result = await ingestUsageMetrics(new FixtureClient([
      row("zero", "2026-09-08T00:00:00Z", 0),
      row("zero", "2026-09-08T01:00:00Z", 0),
      row("zero", "2026-09-09T00:00:00Z", 10),
    ]), {
      windowStartedAt: "2026-09-08T00:00:00Z", windowEndedAt: "2026-09-10T00:00:00Z",
      currentWindowFinality: "final", comparisonWindowFinality: "final",
    })
    expect(result.series[0]).toMatchObject({ observedPointCount: 2, previousValue: null, changeRatio: null })
    expect(result.series[0].status).not.toBe("rising")
  })
})
