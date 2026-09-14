import fs from "node:fs"
import path from "node:path"
import {
  accountSchema,
  observationSchema,
  runResultSchema,
  signalSchema,
  snapshotSchema,
  type Account,
  type Observation,
  type RunResult,
  type Signal,
  type Snapshot,
  type SourceSystem,
} from "./contracts"

export type RetentionPolicy = {
  /** Maximum number of records retained in each collection. */
  maxAccounts?: number
  maxSnapshots?: number
  maxObservations?: number
  maxSignals?: number
  maxRuns?: number
  maxSourceCheckpoints?: number
}

export type SourceCheckpoint = {
  accountId: string
  source: SourceSystem
  cursor: string | null
  capturedAt: string
  runId: string
}

export type StorageWriteResult<T> = {
  value: T
  inserted: boolean
}

export type Baseline = {
  run: RunResult
  snapshots: Snapshot[]
  signals: Signal[]
}

export type AccountQuery = {
  accountId?: string
  /** Include records from a specific run, or all promoted records when omitted. */
  runId?: string
}

export interface SignalRepository {
  saveAccount(account: Account): StorageWriteResult<Account>
  getAccount(accountId: string): Account | undefined
  listAccounts(): Account[]

  saveObservation(observation: Observation): StorageWriteResult<Observation>
  getObservation(observationId: string): Observation | undefined
  listObservations(accountId: string): Observation[]

  saveSnapshot(snapshot: Snapshot): StorageWriteResult<Snapshot>
  getSnapshot(snapshotId: string): Snapshot | undefined
  listSnapshots(query?: AccountQuery): Snapshot[]

  saveSignal(signal: Signal): StorageWriteResult<Signal>
  getSignal(signalId: string): Signal | undefined
  listSignals(query?: AccountQuery): Signal[]

  saveRun(run: RunResult): StorageWriteResult<RunResult>
  getRun(runId: string): RunResult | undefined
  listRuns(accountId?: string): RunResult[]
  getPreviousSuccessfulBaseline(
    accountId: string,
    before?: string,
  ): Baseline | undefined

  saveSourceCheckpoint(checkpoint: SourceCheckpoint): StorageWriteResult<SourceCheckpoint>
  getSourceCheckpoint(accountId: string, source: SourceSystem): SourceCheckpoint | undefined
  listSourceCheckpoints(accountId?: string): SourceCheckpoint[]

  /** Apply retention immediately and return the number of deleted records. */
  prune(): number
}

export type InMemorySignalRepositoryOptions = {
  retention?: RetentionPolicy
}

const DEFAULT_RETENTION: Required<RetentionPolicy> = {
  maxAccounts: 1_000,
  maxSnapshots: 10_000,
  maxObservations: 50_000,
  maxSignals: 50_000,
  maxRuns: 1_000,
  maxSourceCheckpoints: 10_000,
}

function copy<T>(value: T): T {
  return structuredClone(value)
}

function timestamp(value: string) {
  return Date.parse(value)
}

function sortNewest<T extends { [key: string]: unknown }>(items: T[], field: keyof T) {
  return items.sort((left, right) => timestamp(String(right[field])) - timestamp(String(left[field])))
}

function boundedLimit(value: number | undefined, name: string, fallback: number) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
  return value
}

function sameRecord<T extends { id: string }>(existing: T | undefined, incoming: T) {
  if (!existing) return false
  if (JSON.stringify(existing) !== JSON.stringify(incoming)) {
    throw new Error(`Cannot overwrite record ${incoming.id} with different content`)
  }
  return true
}

/**
 * Deterministic repository for local runs and tests. Writes are idempotent by
 * contract ID (or account/source for checkpoints), and all returned values are
 * defensive copies.
 */
export class InMemorySignalRepository implements SignalRepository {
  private readonly retention: Required<RetentionPolicy>
  private readonly accounts = new Map<string, Account>()
  private readonly observations = new Map<string, Observation>()
  private readonly snapshots = new Map<string, Snapshot>()
  private readonly signals = new Map<string, Signal>()
  private readonly runs = new Map<string, RunResult>()
  private readonly checkpoints = new Map<string, SourceCheckpoint>()
  private readonly promotedRunIds = new Set<string>()

  constructor(options: InMemorySignalRepositoryOptions = {}) {
    const requested = options.retention ?? {}
    this.retention = {
      maxAccounts: boundedLimit(requested.maxAccounts, "maxAccounts", DEFAULT_RETENTION.maxAccounts),
      maxSnapshots: boundedLimit(requested.maxSnapshots, "maxSnapshots", DEFAULT_RETENTION.maxSnapshots),
      maxObservations: boundedLimit(
        requested.maxObservations,
        "maxObservations",
        DEFAULT_RETENTION.maxObservations,
      ),
      maxSignals: boundedLimit(requested.maxSignals, "maxSignals", DEFAULT_RETENTION.maxSignals),
      maxRuns: boundedLimit(requested.maxRuns, "maxRuns", DEFAULT_RETENTION.maxRuns),
      maxSourceCheckpoints: boundedLimit(
        requested.maxSourceCheckpoints,
        "maxSourceCheckpoints",
        DEFAULT_RETENTION.maxSourceCheckpoints,
      ),
    }
  }

  saveAccount(input: Account) {
    const account = accountSchema.parse(input)
    const existing = this.accounts.get(account.id)
    const inserted = !sameRecord(existing, account)
    if (inserted) this.accounts.set(account.id, copy(account))
    this.prune()
    return { value: copy(existing ?? account), inserted }
  }

  getAccount(accountId: string) {
    const account = this.accounts.get(accountId)
    return account && copy(account)
  }

  listAccounts() {
    return [...this.accounts.values()].map(copy)
  }

  saveObservation(input: Observation) {
    const observation = observationSchema.parse(input)
    const existing = this.observations.get(observation.id)
    const inserted = !sameRecord(existing, observation)
    if (inserted) this.observations.set(observation.id, copy(observation))
    this.prune()
    return { value: copy(existing ?? observation), inserted }
  }

  getObservation(observationId: string) {
    const observation = this.observations.get(observationId)
    return observation && copy(observation)
  }

  listObservations(accountId: string) {
    return [...this.observations.values()]
      .filter((observation) => observation.accountId === accountId)
      .sort((left, right) => timestamp(right.observedAt) - timestamp(left.observedAt))
      .map(copy)
  }

  /** Internal export used by the file adapter; not part of SignalRepository. */
  listObservationsForPersistence() {
    return [...this.observations.values()].map(copy)
  }

  saveSnapshot(input: Snapshot) {
    const snapshot = snapshotSchema.parse(input)
    const existing = this.snapshots.get(snapshot.id)
    const inserted = !sameRecord(existing, snapshot)
    if (inserted) this.snapshots.set(snapshot.id, copy(snapshot))
    for (const observation of snapshot.observations) this.saveObservation(observation)
    this.prune()
    return { value: copy(existing ?? snapshot), inserted }
  }

  getSnapshot(snapshotId: string) {
    const snapshot = this.snapshots.get(snapshotId)
    return snapshot && copy(snapshot)
  }

  listSnapshots(query: AccountQuery = {}) {
    return [...this.snapshots.values()]
      .filter((snapshot) => !query.accountId || snapshot.accountId === query.accountId)
      .filter((snapshot) => !query.runId || this.runContainsSnapshot(query.runId, snapshot.id))
      .sort((left, right) => timestamp(right.capturedAt) - timestamp(left.capturedAt))
      .map(copy)
  }

  saveSignal(input: Signal) {
    const signal = signalSchema.parse(input)
    const existing = this.signals.get(signal.id)
    const inserted = !sameRecord(existing, signal)
    if (inserted) this.signals.set(signal.id, copy(signal))
    this.saveAccount(signal.account)
    this.prune()
    return { value: copy(existing ?? signal), inserted }
  }

  getSignal(signalId: string) {
    const signal = this.signals.get(signalId)
    return signal && copy(signal)
  }

  listSignals(query: AccountQuery = {}) {
    return [...this.signals.values()]
      .filter((signal) => !query.accountId || signal.account.id === query.accountId)
      .filter((signal) => !query.runId || this.runContainsSignal(query.runId, signal.id))
      .sort((left, right) => timestamp(right.observedAt) - timestamp(left.observedAt))
      .map(copy)
  }

  saveRun(input: RunResult) {
    const run = runResultSchema.parse(input)
    const existing = this.runs.get(run.id)
    const inserted = !sameRecord(existing, run)
    if (!inserted) return { value: copy(run), inserted }

    this.runs.set(run.id, copy(run))
    // Source failures are durable audit history, but never current state. A
    // delivery-only partial run may still promote its successfully collected
    // source data; delivery status must not roll back a valid source baseline.
    const promotable =
      run.status === "succeeded" ||
      (run.status === "partial" &&
        run.errors.length > 0 &&
        run.errors.every((error) => error.code === "slack_delivery_failed"))
    if (promotable) {
      for (const snapshot of run.snapshots) this.saveSnapshot(snapshot)
      for (const signal of run.signals) this.saveSignal(signal)
      this.promotedRunIds.add(run.id)
    }
    this.prune()
    return { value: copy(run), inserted }
  }

  getRun(runId: string) {
    const run = this.runs.get(runId)
    return run && copy(run)
  }

  listRuns(accountId?: string) {
    return sortNewest(
      [...this.runs.values()].filter(
        (run) => !accountId || this.runHasAccount(run, accountId),
      ),
      "completedAt",
    ).map(copy)
  }

  getPreviousSuccessfulBaseline(accountId: string, before?: string) {
    const run = this.listRuns(accountId).find(
      (candidate) =>
        candidate.status === "succeeded" &&
        this.promotedRunIds.has(candidate.id) &&
        (before === undefined || timestamp(candidate.completedAt) < timestamp(before)),
    )
    if (!run) return undefined
    return {
      run: copy(run),
      snapshots: run.snapshots
        .filter((snapshot) => snapshot.accountId === accountId)
        .map(copy),
      signals: run.signals
        .filter((signal) => signal.account.id === accountId)
        .map(copy),
    }
  }

  saveSourceCheckpoint(input: SourceCheckpoint) {
    if (!input.accountId || !input.source || !input.runId || !input.capturedAt) {
      throw new Error("Source checkpoints require accountId, source, runId, and capturedAt")
    }
    if (Number.isNaN(timestamp(input.capturedAt))) {
      throw new Error("Source checkpoint capturedAt must be an ISO timestamp")
    }
    const checkpoint = copy(input)
    const key = `${checkpoint.accountId}\u0000${checkpoint.source}`
    const existing = this.checkpoints.get(key)
    if (existing && JSON.stringify(existing) !== JSON.stringify(checkpoint)) {
      // Checkpoints are monotonic: an older retry cannot move a cursor backward.
      if (timestamp(checkpoint.capturedAt) <= timestamp(existing.capturedAt)) {
        return { value: copy(existing), inserted: false }
      }
    }
    const inserted = !existing || JSON.stringify(existing) !== JSON.stringify(checkpoint)
    if (inserted) this.checkpoints.set(key, checkpoint)
    this.prune()
    return { value: copy(inserted ? checkpoint : existing ?? checkpoint), inserted }
  }

  getSourceCheckpoint(accountId: string, source: SourceSystem) {
    const checkpoint = this.checkpoints.get(`${accountId}\u0000${source}`)
    return checkpoint && copy(checkpoint)
  }

  listSourceCheckpoints(accountId?: string) {
    return [...this.checkpoints.values()]
      .filter((checkpoint) => !accountId || checkpoint.accountId === accountId)
      .sort((left, right) => timestamp(right.capturedAt) - timestamp(left.capturedAt))
      .map(copy)
  }

  prune() {
    let deleted = 0
    deleted += this.pruneMap(this.accounts, this.retention.maxAccounts, (item) => item.id)
    deleted += this.pruneMap(this.observations, this.retention.maxObservations, (item) => item.observedAt)
    deleted += this.pruneMap(this.snapshots, this.retention.maxSnapshots, (item) => item.capturedAt)
    deleted += this.pruneMap(this.signals, this.retention.maxSignals, (item) => item.receivedAt)
    deleted += this.pruneMap(this.runs, this.retention.maxRuns, (item) => item.completedAt)
    deleted += this.pruneMap(this.checkpoints, this.retention.maxSourceCheckpoints, (item) => item.capturedAt)
    return deleted
  }

  private pruneMap<T>(map: Map<string, T>, limit: number, date: (item: T) => string) {
    if (map.size <= limit) return 0
    const entries = [...map.entries()].sort(([, left], [, right]) => timestamp(date(right)) - timestamp(date(left)))
    let deleted = 0
    for (const [key] of entries.slice(limit)) {
      map.delete(key)
      deleted++
    }
    return deleted
  }

  private runHasAccount(run: RunResult, accountId: string) {
    return run.snapshots.some((snapshot) => snapshot.accountId === accountId) ||
      run.signals.some((signal) => signal.account.id === accountId)
  }

  private runContainsSnapshot(runId: string, snapshotId: string) {
    return (
      this.promotedRunIds.has(runId) &&
      (this.runs.get(runId)?.snapshots.some((snapshot) => snapshot.id === snapshotId) ?? false)
    )
  }

  private runContainsSignal(runId: string, signalId: string) {
    return (
      this.promotedRunIds.has(runId) &&
      (this.runs.get(runId)?.signals.some((signal) => signal.id === signalId) ?? false)
    )
  }
}

export const createInMemorySignalRepository = (
  options?: InMemorySignalRepositoryOptions,
) => new InMemorySignalRepository(options)

const FILE_STATE_VERSION = 1 as const

type PersistedSignalRepositoryState = {
  storageVersion: typeof FILE_STATE_VERSION
  accounts: Account[]
  observations: Observation[]
  snapshots: Snapshot[]
  signals: Signal[]
  runs: RunResult[]
  checkpoints: SourceCheckpoint[]
  promotedRunIds: string[]
}

export type JsonFileSignalRepositoryOptions = InMemorySignalRepositoryOptions & {
  filePath: string
}

let temporaryFileSequence = 0

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isPersistedState(value: unknown): value is PersistedSignalRepositoryState {
  if (!isRecord(value) || value.storageVersion !== FILE_STATE_VERSION) return false
  const collections = [
    "accounts",
    "observations",
    "snapshots",
    "signals",
    "runs",
    "checkpoints",
  ] as const
  return collections.every((name) => Array.isArray(value[name])) && isStringArray(value.promotedRunIds)
}

/**
 * Synchronous, restart-safe local persistence for the SignalRepository.
 *
 * This adapter is intentionally local-process storage. Multi-process compare-and-
 * swap, encryption at rest, and file access control remain deployment responsibilities.
 */
export class JsonFileSignalRepository implements SignalRepository {
  private readonly filePath: string
  private readonly repository: InMemorySignalRepository

  constructor(filePath: string, options?: InMemorySignalRepositoryOptions)
  constructor(options: JsonFileSignalRepositoryOptions)
  constructor(
    filePathOrOptions: string | JsonFileSignalRepositoryOptions,
    options: InMemorySignalRepositoryOptions = {},
  ) {
    const filePath =
      typeof filePathOrOptions === "string" ? filePathOrOptions : filePathOrOptions.filePath
    const repositoryOptions =
      typeof filePathOrOptions === "string" ? options : filePathOrOptions

    if (!filePath || typeof filePath !== "string") {
      throw new Error("A JSON state file path is required")
    }

    this.filePath = path.resolve(filePath)
    this.repository = new InMemorySignalRepository(repositoryOptions)
    this.load()
  }

  saveAccount(account: Account) {
    return this.mutate(() => this.repository.saveAccount(account))
  }

  getAccount(accountId: string) {
    return this.repository.getAccount(accountId)
  }

  listAccounts() {
    return this.repository.listAccounts()
  }

  saveObservation(observation: Observation) {
    return this.mutate(() => this.repository.saveObservation(observation))
  }

  getObservation(observationId: string) {
    return this.repository.getObservation(observationId)
  }

  listObservations(accountId: string) {
    return this.repository.listObservations(accountId)
  }

  saveSnapshot(snapshot: Snapshot) {
    return this.mutate(() => this.repository.saveSnapshot(snapshot))
  }

  getSnapshot(snapshotId: string) {
    return this.repository.getSnapshot(snapshotId)
  }

  listSnapshots(query?: AccountQuery) {
    return this.repository.listSnapshots(query)
  }

  saveSignal(signal: Signal) {
    return this.mutate(() => this.repository.saveSignal(signal))
  }

  getSignal(signalId: string) {
    return this.repository.getSignal(signalId)
  }

  listSignals(query?: AccountQuery) {
    return this.repository.listSignals(query)
  }

  saveRun(run: RunResult) {
    return this.mutate(() => this.repository.saveRun(run))
  }

  getRun(runId: string) {
    return this.repository.getRun(runId)
  }

  listRuns(accountId?: string) {
    return this.repository.listRuns(accountId)
  }

  getPreviousSuccessfulBaseline(accountId: string, before?: string) {
    return this.repository.getPreviousSuccessfulBaseline(accountId, before)
  }

  saveSourceCheckpoint(checkpoint: SourceCheckpoint) {
    return this.mutate(() => this.repository.saveSourceCheckpoint(checkpoint))
  }

  getSourceCheckpoint(accountId: string, source: SourceSystem) {
    return this.repository.getSourceCheckpoint(accountId, source)
  }

  listSourceCheckpoints(accountId?: string) {
    return this.repository.listSourceCheckpoints(accountId)
  }

  prune() {
    return this.mutate(() => this.repository.prune())
  }

  private mutate<T>(operation: () => T): T {
    const result = operation()
    this.persist()
    return result
  }

  private load() {
    let contents: string
    try {
      contents = fs.readFileSync(this.filePath, "utf8")
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        this.persist()
        return
      }
      throw new Error("Unable to read signal repository state")
    }

    if (contents.trim() === "") {
      this.persist()
      return
    }

    try {
      const state: unknown = JSON.parse(contents)
      if (!isPersistedState(state)) throw new Error("invalid state envelope")

      // Replay through the in-memory repository so schema validation and all
      // existing promotion, idempotency, and retention semantics stay shared.
      for (const account of state.accounts) this.repository.saveAccount(account)
      for (const observation of state.observations) this.repository.saveObservation(observation)
      for (const snapshot of state.snapshots) this.repository.saveSnapshot(snapshot)
      for (const signal of state.signals) this.repository.saveSignal(signal)
      for (const run of state.runs) this.repository.saveRun(run)
      for (const checkpoint of state.checkpoints) this.repository.saveSourceCheckpoint(checkpoint)
    } catch {
      throw new Error("Malformed signal repository state")
    }
  }

  private persist() {
    const state: PersistedSignalRepositoryState = {
      storageVersion: FILE_STATE_VERSION,
      accounts: this.repository.listAccounts(),
      observations: this.repository.listObservationsForPersistence(),
      snapshots: this.repository.listSnapshots(),
      signals: this.repository.listSignals(),
      runs: this.repository.listRuns(),
      checkpoints: this.repository.listSourceCheckpoints(),
      promotedRunIds: this.repository.listRuns()
        .filter((run) => run.status === "succeeded")
        .map((run) => run.id),
    }
    const temporaryPath = `${this.filePath}.${process.pid}.${temporaryFileSequence++}.tmp`

    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      fs.writeFileSync(temporaryPath, `${JSON.stringify(state)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      })
      fs.renameSync(temporaryPath, this.filePath)
    } catch {
      try {
        fs.rmSync(temporaryPath, { force: true })
      } catch {
        // Preserve the sanitized persistence error if cleanup also fails.
      }
      throw new Error("Unable to persist signal repository state")
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

export function createJsonFileSignalRepository(
  filePath: string,
  options?: InMemorySignalRepositoryOptions,
): JsonFileSignalRepository
export function createJsonFileSignalRepository(
  options: JsonFileSignalRepositoryOptions,
): JsonFileSignalRepository
export function createJsonFileSignalRepository(
  filePathOrOptions: string | JsonFileSignalRepositoryOptions,
  options?: InMemorySignalRepositoryOptions,
) {
  return typeof filePathOrOptions === "string"
    ? new JsonFileSignalRepository(filePathOrOptions, options)
    : new JsonFileSignalRepository(filePathOrOptions)
}
