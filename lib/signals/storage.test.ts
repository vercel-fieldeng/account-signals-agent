import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  redactedAccounts,
  redactedObservations,
  redactedRunResult,
  redactedSignals,
  redactedSnapshots,
} from "./redacted-fixtures"
import { createInMemorySignalRepository, JsonFileSignalRepository } from "./storage"

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("InMemorySignalRepository", () => {
  it("validates and idempotently stores accounts, observations, snapshots, and signals", () => {
    const repository = createInMemorySignalRepository()

    expect(repository.saveAccount(redactedAccounts[0]).inserted).toBe(true)
    expect(repository.saveAccount(redactedAccounts[0]).inserted).toBe(false)
    expect(repository.saveObservation(redactedObservations[0]).inserted).toBe(true)
    expect(repository.saveObservation(redactedObservations[0]).inserted).toBe(false)
    expect(repository.saveSnapshot(redactedSnapshots[0]).inserted).toBe(true)
    expect(repository.saveSnapshot(redactedSnapshots[0]).inserted).toBe(false)
    expect(repository.saveSignal(redactedSignals[0]).inserted).toBe(true)
    expect(repository.saveSignal(redactedSignals[0]).inserted).toBe(false)

    expect(repository.listSnapshots({ accountId: redactedAccounts[0].id })).toHaveLength(1)
    expect(repository.listObservations(redactedAccounts[0].id)).toHaveLength(1)
    expect(repository.listSignals({ accountId: redactedAccounts[0].id })).toHaveLength(1)
  })

  it("promotes only successful runs and returns the prior successful baseline", () => {
    const repository = createInMemorySignalRepository()
    repository.saveRun(redactedRunResult)

    const failedRun = {
      ...redactedRunResult,
      id: `${redactedRunResult.id.slice(0, -1)}0`,
      status: "failed" as const,
      startedAt: "2026-09-15T09:00:01.000Z",
      completedAt: "2026-09-15T09:00:04.000Z",
      errors: [
        { source: "manual" as const, code: "SOURCE_UNAVAILABLE", message: "temporary outage", retryable: true },
      ],
    }
    repository.saveRun(failedRun)

    expect(repository.getRun(failedRun.id)?.status).toBe("failed")
    expect(repository.listSignals({ runId: failedRun.id })).toHaveLength(0)
    expect(repository.getPreviousSuccessfulBaseline(redactedAccounts[0].id, failedRun.startedAt)?.run.id).toBe(
      redactedRunResult.id,
    )
    expect(repository.listRuns(redactedAccounts[0].id)).toHaveLength(2)
  })

  it("keeps source checkpoints scoped and prevents older retries from moving them backward", () => {
    const repository = createInMemorySignalRepository()
    const accountId = redactedAccounts[0].id
    const newer = {
      accountId,
      source: "vercel_projects" as const,
      cursor: "cursor-2",
      capturedAt: "2026-09-14T10:00:00.000Z",
      runId: redactedRunResult.id,
    }
    const older = { ...newer, cursor: "cursor-1", capturedAt: "2026-09-14T09:00:00.000Z" }

    expect(repository.saveSourceCheckpoint(newer)).toEqual({ value: newer, inserted: true })
    expect(repository.saveSourceCheckpoint(newer)).toEqual({ value: newer, inserted: false })
    expect(repository.saveSourceCheckpoint(older)).toEqual({ value: newer, inserted: false })
    expect(repository.getSourceCheckpoint(accountId, "vercel_projects")?.cursor).toBe("cursor-2")
    expect(repository.listSourceCheckpoints(redactedAccounts[1].id)).toEqual([])
  })

  it("retains the newest records according to explicit limits", () => {
    const repository = createInMemorySignalRepository({ retention: { maxRuns: 1 } })
    repository.saveRun(redactedRunResult)
    const laterRun = {
      ...redactedRunResult,
      id: `${redactedRunResult.id.slice(0, -1)}1`,
      startedAt: "2026-09-15T09:00:01.000Z",
      completedAt: "2026-09-15T09:00:04.000Z",
    }
    repository.saveRun(laterRun)

    expect(repository.listRuns()).toHaveLength(1)
    expect(repository.getRun(laterRun.id)).toBeDefined()
    expect(repository.getRun(redactedRunResult.id)).toBeUndefined()
  })
})

describe("JsonFileSignalRepository", () => {
  it("restores a successful baseline and idempotently replays the same signal after restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "account-signals-storage-"))
    temporaryDirectories.push(directory)
    const filePath = join(directory, "state.json")

    const first = new JsonFileSignalRepository(filePath)
    first.saveRun(redactedRunResult)
    first.saveSourceCheckpoint({
      accountId: redactedAccounts[0].id,
      source: "vercel_projects",
      cursor: "cursor-1",
      capturedAt: "2026-09-15T09:00:00.000Z",
      runId: redactedRunResult.id,
    })

    const restarted = new JsonFileSignalRepository(filePath)
    const baseline = restarted.getPreviousSuccessfulBaseline(redactedAccounts[0].id)

    expect(baseline?.run.id).toBe(redactedRunResult.id)
    expect(baseline?.snapshots).toEqual(
      redactedRunResult.snapshots.filter((snapshot) => snapshot.accountId === redactedAccounts[0].id),
    )
    expect(baseline?.signals).toEqual(
      redactedRunResult.signals.filter((signal) => signal.account.id === redactedAccounts[0].id),
    )
    expect(restarted.getSourceCheckpoint(redactedAccounts[0].id, "vercel_projects")?.cursor).toBe("cursor-1")
    expect(restarted.saveSignal(redactedRunResult.signals[0]).inserted).toBe(false)
    expect(restarted.listSignals()).toHaveLength(redactedRunResult.signals.length)
    expect(JSON.parse(readFileSync(filePath, "utf8")).storageVersion).toBe(1)
  })

  it("initializes missing or empty files and rejects malformed state without exposing payloads", () => {
    const directory = mkdtempSync(join(tmpdir(), "account-signals-storage-"))
    temporaryDirectories.push(directory)
    const missingPath = join(directory, "nested", "state.json")
    const initialized = new JsonFileSignalRepository(missingPath)
    expect(initialized.listRuns()).toEqual([])

    writeFileSync(missingPath, "   ")
    expect(new JsonFileSignalRepository(missingPath).listAccounts()).toEqual([])

    const secret = "do-not-leak-this-payload"
    writeFileSync(missingPath, JSON.stringify({ storageVersion: 1, accounts: [{ secret }] }))
    expect(() => new JsonFileSignalRepository(missingPath)).toThrow("Malformed signal repository state")
    expect(() => new JsonFileSignalRepository(missingPath)).not.toThrow(secret)
  })
})
