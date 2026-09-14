import {
  BlobPathnameMismatchError,
  BlobPreconditionFailedError,
  get,
  put,
  type GetBlobResult,
} from "@vercel/blob"
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
import {
  InMemorySignalRepository,
  type AccountQuery,
  type Baseline,
  type InMemorySignalRepositoryOptions,
  type RetentionPolicy,
  type SignalRepository,
  type SourceCheckpoint,
  type StorageWriteResult,
} from "./storage"

const STORAGE_VERSION = 1 as const
const STATE_PATH = "account-signals/private/state-v1.json"
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024

type PersistedState = {
  storageVersion: typeof STORAGE_VERSION
  accounts: Account[]
  observations: Observation[]
  snapshots: Snapshot[]
  signals: Signal[]
  runs: RunResult[]
  checkpoints: SourceCheckpoint[]
  promotedRunIds: string[]
}

type BlobSdk = {
  get: typeof get
  put: typeof put
}

export type BlobSignalRepositoryOptions = InMemorySignalRepositoryOptions & {
  /** Store id for OIDC authentication. Defaults to BLOB_STORE_ID. */
  storeId?: string
  /** Maximum accepted state response size in bytes. */
  maxBytes?: number
  /** Testable SDK boundary; production uses @vercel/blob directly. */
  sdk?: Partial<BlobSdk>
}

export class BlobSignalRepositoryConflictError extends Error {
  constructor() {
    super("Signal repository state changed concurrently")
    this.name = "BlobSignalRepositoryConflictError"
  }
}

export type SignalRepositoryOperation<T> = (repository: SignalRepository) => T

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isStateEnvelope(value: unknown): value is PersistedState {
  if (!isRecord(value) || value.storageVersion !== STORAGE_VERSION) return false
  return (
    ["accounts", "observations", "snapshots", "signals", "runs", "checkpoints"].every(
      (name) => Array.isArray(value[name]),
    ) && isStringArray(value.promotedRunIds)
  )
}

function sanitizedError(message: string): Error {
  return new Error(message)
}

function isConcurrencyError(error: unknown, creating: boolean): boolean {
  if (error instanceof BlobPreconditionFailedError) return true
  if (creating && error instanceof BlobPathnameMismatchError) return true
  if (!isRecord(error)) return false
  const name = typeof error.name === "string" ? error.name : ""
  const message = typeof error.message === "string" ? error.message : ""
  return (
    name === "BlobPreconditionFailedError" ||
    (creating && name === "BlobPathnameMismatchError") ||
    error.statusCode === 412 ||
    error.status === 412 ||
    (creating && /already exists|already uploaded|pathname mismatch/i.test(message))
  )
}

function repositoryState(repository: InMemorySignalRepository): PersistedState {
  return {
    storageVersion: STORAGE_VERSION,
    accounts: repository.listAccounts(),
    // This method is intentionally used only through the existing repository's
    // persistence boundary; it avoids losing observations nested in snapshots.
    observations: repository.listObservationsForPersistence(),
    snapshots: repository.listSnapshots(),
    signals: repository.listSignals(),
    runs: repository.listRuns(),
    checkpoints: repository.listSourceCheckpoints(),
    promotedRunIds: repository.listRuns()
      .filter(
        (run) =>
          run.status === "succeeded" ||
          (run.status === "partial" &&
            run.errors.length > 0 &&
            run.errors.every((error) => error.code === "slack_delivery_failed")),
      )
      .map((run) => run.id),
  }
}

function validateAndLoad(value: unknown, options: InMemorySignalRepositoryOptions): InMemorySignalRepository {
  if (!isStateEnvelope(value)) throw sanitizedError("Malformed signal repository state")

  try {
    // Parsing through the production repository preserves its validation,
    // promotion, idempotency, and retention behavior on every restart.
    const repository = new InMemorySignalRepository(options)
    for (const account of value.accounts) repository.saveAccount(accountSchema.parse(account))
    for (const observation of value.observations) {
      repository.saveObservation(observationSchema.parse(observation))
    }
    for (const snapshot of value.snapshots) repository.saveSnapshot(snapshotSchema.parse(snapshot))
    for (const signal of value.signals) repository.saveSignal(signalSchema.parse(signal))
    for (const run of value.runs) repository.saveRun(runResultSchema.parse(run))
    for (const checkpoint of value.checkpoints) repository.saveSourceCheckpoint(checkpoint)
    return repository
  } catch {
    throw sanitizedError("Malformed signal repository state")
  }
}

async function readStream(response: GetBlobResult, maxBytes: number): Promise<string> {
  if (response.statusCode !== 200) throw sanitizedError("Unable to read signal repository state")
  if (!Number.isSafeInteger(response.blob.size) || response.blob.size > maxBytes) {
    throw sanitizedError("Signal repository state exceeds the size limit")
  }

  const reader = response.stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      total += part.value.byteLength
      if (total > maxBytes) throw sanitizedError("Signal repository state exceeds the size limit")
      chunks.push(part.value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

/**
 * Private, origin-consistent Blob persistence for the signal repository.
 * Callbacks must be synchronous and free of network side effects: a conflict
 * must never cause an external operation to be repeated.
 */
export class BlobSignalRepository {
  private readonly sdk: BlobSdk
  private readonly storeId: string | undefined
  private readonly maxBytes: number
  private readonly repositoryOptions: InMemorySignalRepositoryOptions

  constructor(options: BlobSignalRepositoryOptions = {}) {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("maxBytes must be a positive safe integer")
    }
    this.sdk = { get, put, ...options.sdk }
    this.storeId = options.storeId ?? process.env.BLOB_STORE_ID
    this.maxBytes = maxBytes
    this.repositoryOptions = { retention: options.retention }
  }

  /** Loads the current durable repository without running a callback. */
  async read(): Promise<SignalRepository> {
    const loaded = await this.load()
    return loaded.repository
  }

  /** Runs one pure synchronous operation and commits it with an ETag CAS. */
  async transaction<T>(operation: SignalRepositoryOperation<T>): Promise<T> {
    const loaded = await this.load()
    const result = operation(loaded.repository)
    if (result && typeof (result as unknown as { then?: unknown }).then === "function") {
      throw sanitizedError("Blob repository transactions must be synchronous")
    }

    if (loaded.exists && (loaded.etag === undefined || loaded.etag.trim() === "")) {
      // An existing blob without an ETag cannot be updated safely.
      throw sanitizedError("Signal repository state has no usable ETag")
    }
    const body = `${JSON.stringify(repositoryState(loaded.repository))}\n`
    if (new TextEncoder().encode(body).byteLength > this.maxBytes) {
      throw sanitizedError("Signal repository state exceeds the size limit")
    }
    try {
      await this.sdk.put(STATE_PATH, body, this.blobOptions(loaded.etag))
    } catch (error) {
      if (isConcurrencyError(error, !loaded.exists)) throw new BlobSignalRepositoryConflictError()
      throw sanitizedError("Unable to persist signal repository state")
    }
    return result
  }

  private blobOptions(etag?: string) {
    return {
      access: "private" as const,
      allowOverwrite: Boolean(etag),
      addRandomSuffix: false,
      contentType: "application/json",
      ...(etag ? { ifMatch: etag } : {}),
      ...(this.storeId ? { storeId: this.storeId } : {}),
    }
  }

  private async load(): Promise<{ repository: InMemorySignalRepository; etag?: string; exists: boolean }> {
    let response: GetBlobResult | null
    try {
      response = await this.sdk.get(STATE_PATH, {
        access: "private",
        useCache: false,
        ...(this.storeId ? { storeId: this.storeId } : {}),
      })
    } catch {
      throw sanitizedError("Unable to read signal repository state")
    }

    if (!response) {
      return { repository: new InMemorySignalRepository(this.repositoryOptions), exists: false }
    }

    try {
      const text = await readStream(response, this.maxBytes)
      return {
        repository: validateAndLoad(JSON.parse(text) as unknown, this.repositoryOptions),
        etag: response.blob.etag,
        exists: true,
      }
    } catch (error) {
      if (error instanceof Error && (error.message === "Malformed signal repository state" || error.message.includes("size limit"))) {
        throw error
      }
      throw sanitizedError("Malformed signal repository state")
    }
  }
}

export async function withBlobSignalRepository<T>(
  operation: SignalRepositoryOperation<T>,
  options?: BlobSignalRepositoryOptions,
): Promise<T> {
  return new BlobSignalRepository(options).transaction(operation)
}

export { STATE_PATH as BLOB_SIGNAL_STATE_PATH }
export type { AccountQuery, Baseline, RetentionPolicy, SourceCheckpoint, StorageWriteResult }
export type { SignalRepository }
export type { Observation, Snapshot, RunResult, Account, Signal, SourceSystem }
