import { describe, expect, it } from "vitest"
import type { RunResult } from "./contracts"
import { redactedRunResult } from "./redacted-fixtures"
import {
  ReplayLedger,
  createRunMetrics,
  createStructuredLogger,
  detectStaleRun,
  redactLogDetails,
  summarizeFailures,
} from "./observability"

describe("run observability", () => {
  it("reports partial coverage, source success, signals, duration, and delivery", () => {
    const metrics = createRunMetrics({
      runId: redactedRunResult.id,
      startedAt: "2026-09-14T09:00:00.000Z",
      completedAt: "2026-09-14T09:00:12.000Z",
      expectedAccountIds: ["account-a", "account-b"],
      attempts: [
        { accountId: "account-a", source: "vercel_projects", status: "succeeded", signalCount: 2 },
        {
          accountId: "account-b",
          source: "vercel_usage",
          status: "failed",
          signalCount: 0,
          error: { code: "TIMEOUT", message: "upstream timeout", retryable: true },
        },
      ],
      delivery: { attempted: 2, delivered: 1 },
    })

    expect(metrics.durationMs).toBe(12000)
    expect(metrics.coverage).toMatchObject({ expectedAccounts: 2, coveredAccounts: 1, ratio: 0.5 })
    expect(metrics.sources).toMatchObject({ attempted: 2, succeeded: 1, failed: 1, successRatio: 0.5 })
    expect(metrics.signals).toMatchObject({ total: 2, bySource: { vercel_projects: 2 } })
    expect(metrics.delivery).toMatchObject({ attempted: 2, delivered: 1, failed: 1, successRatio: 0.5 })
  })

  it("summarizes repeated failures without retaining unsafe message content", () => {
    const errors = [
      { source: "vercel_usage" as const, code: "UPSTREAM", message: "token=secret-value timeout", retryable: true },
      { source: "vercel_usage" as const, code: "UPSTREAM", message: "token=secret-value timeout", retryable: true },
    ]
    expect(summarizeFailures(errors)).toEqual([
      { source: "vercel_usage", code: "UPSTREAM", message: "token=[REDACTED] timeout", retryable: true, count: 2 },
    ])
  })

  it("redacts credentials and raw payloads from structured logs", () => {
    const entries: unknown[] = []
    const log = createStructuredLogger(
      { runId: "run-1", accountId: "account-1", source: "manual", correlationId: "corr-1" },
      (entry) => entries.push(entry),
      () => "2026-09-14T09:00:00.000Z",
    )
    log("error", "source failed with Bearer abc123", "source failed with Bearer abc123", {
      token: "do-not-log",
      payload: { customer: "do-not-log" },
      safe: "kept",
    })

    const entry = entries[0] as Record<string, unknown>
    expect(entry).toMatchObject({ runId: "run-1", accountId: "account-1", source: "manual", correlationId: "corr-1" })
    expect(entry.message).toBe("source failed with [REDACTED]")
    expect(entry.details).toEqual({ token: "[REDACTED]", payload: "[REDACTED]", safe: "kept" })
    expect(JSON.stringify(entry)).not.toContain("do-not-log")
    expect(redactLogDetails({ nested: { authorization: "secret" } })).toEqual({ nested: { authorization: "[REDACTED]" } })
  })

  it("detects a run that remains open beyond its threshold", () => {
    expect(
      detectStaleRun(
        { id: "run-1", startedAt: "2026-09-14T08:00:00.000Z" },
        "2026-09-14T08:05:01.000Z",
        5 * 60 * 1000,
      ),
    ).toMatchObject({ stale: true, ageMs: 301000, reason: "running-too-long" })
  })

  it("creates an idempotent, scoped, auditable replay request", () => {
    const run = {
      ...redactedRunResult,
      status: "partial" as const,
      errors: [
        { source: "vercel_usage" as const, code: "TIMEOUT", message: "temporary outage", retryable: true },
      ],
    } satisfies RunResult
    const ledger = new ReplayLedger()
    const first = ledger.request(run, { accountId: "account-a", source: "vercel_usage" }, "operator-a", "2026-09-14T10:00:00.000Z", "retry failed usage")
    const second = ledger.request(run, { accountId: "account-a", source: "vercel_usage" }, "operator-b", "2026-09-14T10:01:00.000Z", "duplicate retry")

    expect(second).toEqual(first)
    expect(ledger.list()).toHaveLength(1)
    expect(ledger.auditTrail().map((event) => event.event)).toEqual(["replay_requested", "replay_deduplicated"])
    expect(first).toMatchObject({ runId: run.id, accountId: "account-a", source: "vercel_usage", status: "requested" })
    expect(() => ledger.request(run, { accountId: "account-a", source: "manual" }, "operator-a", "2026-09-14T10:00:00.000Z", "wrong source")).toThrow("retryable")
  })

  it("rejects non-retryable replay requests unless an operator override is audited", () => {
    const run = {
      ...redactedRunResult,
      status: "partial" as const,
      errors: [
        { source: "vercel_usage" as const, code: "INVALID_AUTH", message: "permanent auth failure", retryable: false },
      ],
    } satisfies RunResult
    const ledger = new ReplayLedger()

    expect(() => ledger.request(
      run,
      { accountId: "account-a", source: "vercel_usage" },
      "operator-a",
      "2026-09-14T10:00:00.000Z",
      "retry auth failure",
    )).toThrow("retryable")

    const request = ledger.request(
      run,
      { accountId: "account-a", source: "vercel_usage" },
      "operator-a",
      "2026-09-14T10:00:00.000Z",
      "retry auth failure",
      { approvedBy: "admin-a", reason: "confirmed credential rotation completed" },
    )
    expect(request.operatorOverride).toEqual({
      approvedBy: "admin-a",
      reason: "confirmed credential rotation completed",
    })
    expect(ledger.auditTrail()[0]).toMatchObject({ event: "replay_requested", operatorOverride: request.operatorOverride })
  })
})
