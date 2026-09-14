import {
  SCHEMA_VERSION,
  runResultSchema,
  type Account,
  type RunResult,
  type Signal,
  type Snapshot,
  type SourceSystem,
} from "./contracts"
import type { SignalRepository } from "./storage"
import { createRunId } from "./stable-id"
import { createSignalDigest } from "./normalize"
import { renderDailyDigest, type SlackDigestMessage } from "./digest"
import { sanitizeLogMessage } from "./observability"

export type EveClock = () => string

export type DailySchedule = {
  /** Local wall-clock time in HH:mm (24-hour notation). */
  time: string
  /** An IANA timezone, for example Europe/Berlin. */
  timezone: string
}

export type OrchestratorConfig = {
  schedule: DailySchedule
  accountConcurrency: number
  sourceConcurrency: number
}

export type SourceCollectionContext = {
  account: Account
  window: { startedAt: string; endedAt: string }
  cursor: string | null
  runId: string
}

export type SourceCollection = {
  snapshots?: readonly Snapshot[]
  signals?: readonly Signal[]
  nextCursor?: string | null
}

/** One source boundary per account. Implementations own all network clients. */
export type AccountSignalSource = {
  source: SourceSystem
  collect(context: SourceCollectionContext): Promise<SourceCollection>
}

export type EveRunner = <T>(
  name: string,
  operation: () => Promise<T>,
) => Promise<T>

export type SlackDelivery = (input: {
  runId: string
  message: SlackDigestMessage
}) => Promise<void>

export type OrchestratorDependencies = {
  repository: SignalRepository
  accounts: readonly Account[]
  sources: readonly AccountSignalSource[]
  clock: EveClock
  runner?: EveRunner
  deliverSlack?: SlackDelivery
}

export type RunClaim = {
  id: string
  startedAt: string
  windowStartedAt: string
  windowEndedAt: string
}

/** Optional atomic hook for a distributed repository. The current repository interface remains usable without it. */
export type RunClaimRepository = SignalRepository & {
  claimRun?: (claim: RunClaim) => boolean | Promise<boolean>
}

export type OrchestrationResult =
  | { kind: "not_due"; scheduledAt: string }
  | { kind: "duplicate"; runId: string; run: RunResult }
  | { kind: "dry_run"; run: RunResult }
  | { kind: "completed"; run: RunResult }

const activeRuns = new Set<string>()
const DAY = 86_400_000

function validateConfig(config: OrchestratorConfig) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(config.schedule.time)) {
    throw new Error("schedule.time must be HH:mm")
  }
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: config.schedule.timezone }).format()
  } catch {
    throw new Error(`Invalid schedule timezone: ${config.schedule.timezone}`)
  }
  for (const [name, value] of Object.entries({
    accountConcurrency: config.accountConcurrency,
    sourceConcurrency: config.sourceConcurrency,
  })) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  }
}

function partsAt(instant: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant)
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value])) as Record<string, string>
}

function localDateKey(instant: Date, timezone: string) {
  const parts = partsAt(instant, timezone)
  return `${parts.year}-${parts.month}-${parts.day}`
}

function localDateOffset(dateKey: string, days: number) {
  const date = new Date(`${dateKey}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** Convert a local wall-clock date/time to its deterministic instant, including DST changes. */
function scheduledInstant(dateKey: string, schedule: DailySchedule): string {
  const [hour, minute] = schedule.time.split(":").map(Number)
  const target = Date.parse(`${dateKey}T${schedule.time}:00.000Z`)
  let candidate = target
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = partsAt(new Date(candidate), schedule.timezone)
    const rendered = Date.parse(`${actual.year}-${actual.month}-${actual.day}T${actual.hour}:${actual.minute}:${actual.second}Z`)
    candidate += target - rendered
  }
  const actual = partsAt(new Date(candidate), schedule.timezone)
  if (actual.hour !== String(hour).padStart(2, "0") || actual.minute !== String(minute).padStart(2, "0")) {
    throw new Error(`Schedule time does not exist in ${schedule.timezone}: ${dateKey} ${schedule.time}`)
  }
  return new Date(candidate).toISOString()
}

export function scheduledWindow(now: string, schedule: DailySchedule) {
  validateConfig({ schedule, accountConcurrency: 1, sourceConcurrency: 1 })
  const instant = new Date(now)
  if (!Number.isFinite(instant.getTime())) throw new Error("clock must return an ISO timestamp")
  const date = localDateKey(instant, schedule.timezone)
  let endedAt = scheduledInstant(date, schedule)
  if (Date.parse(endedAt) > instant.getTime()) {
    endedAt = scheduledInstant(localDateOffset(date, -1), schedule)
  }
  const startedAt = scheduledInstant(localDateOffset(localDateKey(new Date(endedAt), schedule.timezone), -1), schedule)
  return { startedAt, endedAt, scheduledAt: endedAt }
}

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>) {
  const output = new Array<R>(items.length)
  let next = 0
  async function worker() {
    while (true) {
      const index = next++
      if (index >= items.length) return
      output[index] = await fn(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return output
}

type RunError = RunResult["errors"][number]

function errorFor(source: SourceSystem | null, error: unknown): RunError {
  const message = error instanceof Error ? error.message : "Unknown orchestration failure"
  return { source, code: "source_failed", message: sanitizeLogMessage(message), retryable: true }
}

export class DailyEveOrchestrator {
  private readonly config: OrchestratorConfig
  private readonly dependencies: OrchestratorDependencies
  private readonly runner: EveRunner

  constructor(dependencies: OrchestratorDependencies, config: OrchestratorConfig) {
    validateConfig(config)
    if (new Set(dependencies.sources.map((source) => source.source)).size !== dependencies.sources.length) {
      throw new Error("Sources must have unique source systems")
    }
    this.dependencies = dependencies
    this.config = config
    this.runner = dependencies.runner ?? (async (_name, operation) => operation())
  }

  async run(options: { dryRun?: boolean; now?: string } = {}): Promise<OrchestrationResult> {
    const startedAt = options.now ?? this.dependencies.clock()
    const instant = new Date(startedAt)
    if (!Number.isFinite(instant.getTime())) throw new Error("clock must return an ISO timestamp")
    const todayScheduledAt = scheduledInstant(localDateKey(instant, this.config.schedule.timezone), this.config.schedule)
    if (instant.getTime() < Date.parse(todayScheduledAt)) {
      return { kind: "not_due", scheduledAt: todayScheduledAt }
    }
    const window = scheduledWindow(startedAt, this.config.schedule)
    const runId = createRunId(window.startedAt, window.endedAt, window.scheduledAt)
    const existing = this.dependencies.repository.getRun(runId)
    if (existing) return { kind: "duplicate", runId, run: existing }
    if (activeRuns.has(runId)) return { kind: "duplicate", runId, run: this.inProgressResult(runId, window, startedAt) }

    const dryRun = options.dryRun === true
    activeRuns.add(runId)
    if (!dryRun) {
      const claimed = await this.claim({ id: runId, startedAt, windowStartedAt: window.startedAt, windowEndedAt: window.endedAt })
      if (!claimed) {
        activeRuns.delete(runId)
        const run = this.dependencies.repository.getRun(runId)
        if (!run) throw new Error(`Run ${runId} was claimed but is not readable`)
        return { kind: "duplicate", runId, run }
      }
    }
    try {
      const run = await this.execute(runId, startedAt, window, dryRun)
      return dryRun ? { kind: "dry_run", run } : { kind: "completed", run }
    } finally {
      activeRuns.delete(runId)
    }
  }

  private async claim(claim: RunClaim) {
    const repository = this.dependencies.repository as RunClaimRepository
    return repository.claimRun ? await repository.claimRun(claim) : true
  }

  private inProgressResult(id: string, window: { startedAt: string; endedAt: string }, startedAt: string): RunResult {
    return runResultSchema.parse({
      schemaVersion: SCHEMA_VERSION, id, status: "partial", startedAt,
      completedAt: startedAt, windowStartedAt: window.startedAt, windowEndedAt: window.endedAt,
      snapshots: [], signals: [], errors: [{ source: null, code: "duplicate_in_progress", message: "Run is already in progress", retryable: false }],
    })
  }

  private async execute(runId: string, startedAt: string, window: { startedAt: string; endedAt: string }, dryRun: boolean): Promise<RunResult> {
    const accounts = [...this.dependencies.accounts].sort((left, right) => left.id.localeCompare(right.id))
    const sources = [...this.dependencies.sources].sort((left, right) => left.source.localeCompare(right.source))
    const attempts = await mapWithConcurrency(accounts, this.config.accountConcurrency, async (account) => {
      return mapWithConcurrency(sources, this.config.sourceConcurrency, async (source) => {
        try {
          const checkpoint = this.dependencies.repository.getSourceCheckpoint(account.id, source.source)
          const result = await this.runner(`${account.id}:${source.source}`, () => source.collect({ account, window, cursor: checkpoint?.cursor ?? null, runId }))
          return { account, source, result }
        } catch (error) {
          return { account, source, error }
        }
      })
    })
    const snapshots: Snapshot[] = []
    const signals: Signal[] = []
    const checkpoints: Array<{
      accountId: string
      source: SourceSystem
      cursor: string | null
      capturedAt: string
      runId: string
    }> = []
    const errors: RunError[] = []
    let successfulAttempts = 0
    for (const accountAttempts of attempts) for (const attempt of accountAttempts) {
      if ("error" in attempt) {
        errors.push(errorFor(attempt.source.source, attempt.error))
        continue
      }
      successfulAttempts += 1
      snapshots.push(...(attempt.result.snapshots ?? []))
      signals.push(...(attempt.result.signals ?? []))
      checkpoints.push({
        accountId: attempt.account.id, source: attempt.source.source,
        cursor: attempt.result.nextCursor ?? null, capturedAt: startedAt, runId,
      })
    }
    let status = errors.length === 0 ? "succeeded" : (successfulAttempts > 0 ? "partial" : "failed")
    const completedAt = this.dependencies.clock()
    const safeCompletedAt = Date.parse(completedAt) >= Date.parse(startedAt) ? completedAt : startedAt
    if (!dryRun && this.dependencies.deliverSlack && status !== "failed") {
      // Delivery is deliberately an injected side effect and is never called during replay/dry-run.
      try {
        const digest = renderDailyDigest({
          digest: signals.length > 0
            ? createSignalDigest(signals, window.startedAt, window.endedAt, safeCompletedAt)
            : { generatedAt: safeCompletedAt, windowStartedAt: window.startedAt, windowEndedAt: window.endedAt, accounts: [] },
          run: runResultSchema.parse({
            schemaVersion: SCHEMA_VERSION, id: runId, status, startedAt, completedAt: safeCompletedAt,
            windowStartedAt: window.startedAt, windowEndedAt: window.endedAt, snapshots, signals, errors,
          }),
        })
        await this.runner("slack-delivery", () => this.dependencies.deliverSlack!({ runId, message: digest.slack }))
      } catch (error) {
        errors.push({
          source: null,
          code: "slack_delivery_failed",
          message: sanitizeLogMessage(error instanceof Error ? error.message : "Unknown Slack delivery failure"),
          retryable: true,
        })
        status = "partial"
      }
    }
    const run = runResultSchema.parse({
      schemaVersion: SCHEMA_VERSION, id: runId, status, startedAt, completedAt: safeCompletedAt,
      windowStartedAt: window.startedAt, windowEndedAt: window.endedAt, snapshots, signals, errors,
    })
    if (!dryRun) {
      this.dependencies.repository.saveRun(run)
      // Checkpoints are staged alongside the run and only advance after the
      // final run status permits source promotion.
      if (status === "succeeded" || (status === "partial" && errors.every((error) => error.code === "slack_delivery_failed"))) {
        for (const checkpoint of checkpoints) this.dependencies.repository.saveSourceCheckpoint(checkpoint)
      }
    }
    return run
  }
}

export async function runDailyEve(
  dependencies: OrchestratorDependencies,
  config: OrchestratorConfig,
  options?: { dryRun?: boolean; now?: string },
) {
  return new DailyEveOrchestrator(dependencies, config).run(options)
}