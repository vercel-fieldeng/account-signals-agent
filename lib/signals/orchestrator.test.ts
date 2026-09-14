import { describe, expect, it } from "vitest"
import { InMemorySignalRepository } from "./storage"
import { redactedAccounts, redactedSignals } from "./redacted-fixtures"
import { DailyEveOrchestrator, scheduledWindow, type AccountSignalSource } from "./orchestrator"

const now = "2026-09-14T08:05:00.000Z"
const schedule = { time: "10:00", timezone: "Europe/Berlin" }

function source(sourceName: "vercel_projects" | "vercel_usage", accountIndex = 0): AccountSignalSource {
  const signal = redactedSignals.find(
    (candidate) => candidate.source.system === sourceName && candidate.account.id === redactedAccounts[accountIndex].id,
  )
  return {
    source: sourceName,
    async collect() {
      return signal ? { signals: [signal] } : {}
    },
  }
}

function orchestrator(
  repository = new InMemorySignalRepository(),
  sources: readonly AccountSignalSource[] = [source("vercel_projects")],
  deliverSlack?: () => Promise<void>,
) {
  return new DailyEveOrchestrator(
    { repository, accounts: [redactedAccounts[0]], sources, clock: () => now, deliverSlack },
    { schedule, accountConcurrency: 1, sourceConcurrency: 1 },
  )
}

describe("DailyEveOrchestrator", () => {
  it("computes a deterministic daily window in the configured timezone", () => {
    expect(scheduledWindow(now, schedule)).toEqual({
      startedAt: "2026-09-13T08:00:00.000Z",
      endedAt: "2026-09-14T08:00:00.000Z",
      scheduledAt: "2026-09-14T08:00:00.000Z",
    })
  })

  it("prevents duplicate logical runs, including concurrent triggers", async () => {
    const repository = new InMemorySignalRepository()
    const first = orchestrator(repository)
    const second = orchestrator(repository)
    const [left, right] = await Promise.all([first.run(), second.run()])
    expect(new Set([left.kind, right.kind])).toEqual(new Set(["completed", "duplicate"]))
    expect(repository.listRuns()).toHaveLength(1)
    expect(repository.listSignals()).toHaveLength(1)
  })

  it("isolates account/source failures and records a partial run without exposing staged state", async () => {
    const repository = new InMemorySignalRepository()
    const failing: AccountSignalSource = {
      source: "vercel_usage",
      async collect() { throw new Error("usage unavailable token=secret-value") },
    }
    const result = await orchestrator(repository, [source("vercel_projects"), failing]).run()
    expect(result.kind).toBe("completed")
    if (result.kind === "completed") {
      expect(result.run.status).toBe("partial")
      expect(result.run.errors).toHaveLength(1)
      expect(result.run.errors[0].message).toBe("usage unavailable token=[REDACTED]")
      expect(result.run.signals).toHaveLength(1)
      expect(repository.listSignals()).toEqual([])
      expect(repository.listSnapshots()).toEqual([])
      expect(repository.listSourceCheckpoints()).toEqual([])
    }
  })

  it("audits Slack delivery failure without discarding successful source state", async () => {
    const repository = new InMemorySignalRepository()
    const result = await orchestrator(
      repository,
      [source("vercel_projects")],
      async () => { throw new Error("Slack token=delivery-secret unavailable") },
    ).run()

    expect(result.kind).toBe("completed")
    if (result.kind === "completed") {
      expect(result.run.status).toBe("partial")
      expect(result.run.errors).toEqual([
        {
          source: null,
          code: "slack_delivery_failed",
          message: "Slack token=[REDACTED] unavailable",
          retryable: true,
        },
      ])
      expect(repository.listSignals()).toHaveLength(1)
      expect(repository.listSourceCheckpoints()).toHaveLength(1)
      expect(repository.getRun(result.run.id)?.errors[0].code).toBe("slack_delivery_failed")
    }
  })

  it("is replay-safe and dry-run does not persist or deliver", async () => {
    const repository = new InMemorySignalRepository()
    let deliveries = 0
    const runner = orchestrator(repository, [source("vercel_projects")], async () => { deliveries += 1 })
    const dry = await runner.run({ dryRun: true })
    expect(dry.kind).toBe("dry_run")
    expect(repository.listRuns()).toHaveLength(0)
    expect(repository.listSignals()).toHaveLength(0)
    expect(deliveries).toBe(0)

    const real = await runner.run()
    expect(real.kind).toBe("completed")
    expect(repository.listSignals()).toHaveLength(1)
    expect(deliveries).toBe(1)
    const replay = await runner.run()
    expect(replay.kind).toBe("duplicate")
    expect(repository.listSignals()).toHaveLength(1)
  })
})
