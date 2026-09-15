import { createHash, randomUUID } from "node:crypto"
import { get, put, type GetBlobResult } from "@vercel/blob"
import { type AutomationOwner, validateAutomationOwner } from "./automation-policy"

const STATE_PATH = "account-signals/private/automation/control-v1.json"
const MAX_BYTES = 64 * 1024
const MAX_RETRIES = 3
const FUTURE_TOLERANCE_MS = 60_000
const FIVE_MINUTES = 5 * 60_000
const MINUTE = 60_000
const FIFTEEN_MINUTES = 15 * MINUTE
const PAUSED_TOMBSTONE = "__paused__"

export type SetupTicket = { requestId: string; generation: number }
export type AutomationJob = {
  id: string
  dueAt: string
  status: "scheduled" | "checking" | "dispatching" | "dispatched" | "completed" | "failed" | "blocked" | "cancelled"
  claimToken?: string
  acceptedSessionId?: string
  terminalAt?: string
  failureCode?: string
}
export type ClaimedAutomationJob = {
  job: AutomationJob
  owner: AutomationOwner
  generation: number
}
export type AutomationState = {
  schemaVersion: 1
  owner: AutomationOwner
  paused: boolean
  generation: number
  updatedAt: string
  lastIntentAt: string
  setup: {
    requestId: string
    requestedAt: string
    status: "pending" | "ready" | "cancelled"
  }
  job: AutomationJob | null
}

type BlobSdk = { get: typeof get; put: typeof put }
type Loaded = { state: AutomationState | null; etag?: string }
type Mutation<T> = {
  state: AutomationState | null
  result: T
}

function fail(message: string): never {
  throw new Error(message)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys)
  return Object.keys(value).every((key) => expected.has(key))
}

function intentMicros(value: unknown): bigint | null {
  if (typeof value !== "string") return null
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{3}|\d{6})Z$/.exec(value)
  if (!match) return null
  const canonicalMilliseconds = `${match[1]}.${match[2].slice(0, 3)}Z`
  const milliseconds = Date.parse(canonicalMilliseconds)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== canonicalMilliseconds) return null
  return BigInt(milliseconds) * 1000n + BigInt(match[2].padEnd(6, "0")) % 1000n
}

function safeDate(value: unknown): value is string {
  return intentMicros(value) !== null
}

function validPersistedOwner(value: unknown): value is AutomationOwner {
  if (!record(value) || !exactKeys(value, ["auth", "channelId", "installationTeamId"]) || !record(value.auth)) return false
  if (!exactKeys(value.auth, ["authenticator", "principalId", "principalType", "issuer", "attributes"]) || !record(value.auth.attributes)) return false
  if (!exactKeys(value.auth.attributes, ["user_id", "team_id", "channel_id", "author_type"])) return false
  return Object.values(value.auth.attributes).every((item) => typeof item === "string")
}

function ownerKey(owner: AutomationOwner): string {
  return JSON.stringify({
    auth: {
      authenticator: owner.auth.authenticator,
      principalId: owner.auth.principalId,
      principalType: owner.auth.principalType,
      issuer: owner.auth.issuer,
      attributes: owner.auth.attributes,
    },
    channelId: owner.channelId,
    installationTeamId: owner.installationTeamId,
  })
}

function sameOwner(a: AutomationOwner, b: AutomationOwner): boolean {
  return ownerKey(a) === ownerKey(b)
}

function jobId(requestId: string): string {
  return `automation-${createHash("sha256").update(requestId).digest("hex").slice(0, 32)}`
}

function dueAt(now: Date): string {
  return new Date(Math.ceil((now.getTime() + FIVE_MINUTES) / MINUTE) * MINUTE).toISOString()
}

function isConcurrency(error: unknown, creating: boolean): boolean {
  if (!record(error)) return false
  const name = typeof error.name === "string" ? error.name : ""
  const message = typeof error.message === "string" ? error.message : ""
  return (
    name === "BlobPreconditionFailedError" ||
    (creating && name === "BlobPathnameMismatchError") ||
    error.status === 412 ||
    error.statusCode === 412 ||
    (creating && /already exists|pathname mismatch/i.test(message))
  )
}

function validJob(value: unknown): value is AutomationJob {
  if (!record(value) || !exactKeys(value, ["id", "dueAt", "status", "claimToken", "acceptedSessionId", "terminalAt", "failureCode"])) return false
  if (typeof value.id !== "string" || value.id.length === 0 || !safeDate(value.dueAt)) return false
  const status = value.status
  if (!(typeof status === "string" && ["scheduled", "checking", "dispatching", "dispatched", "completed", "failed", "blocked", "cancelled"].includes(status))) return false
  if (value.claimToken !== undefined && (typeof value.claimToken !== "string" || value.claimToken.length === 0)) return false
  if (value.acceptedSessionId !== undefined && (typeof value.acceptedSessionId !== "string" || value.acceptedSessionId.length === 0)) return false
  if (value.terminalAt !== undefined && !safeDate(value.terminalAt)) return false
  if (value.failureCode !== undefined && (typeof value.failureCode !== "string" || value.failureCode.length === 0)) return false
  if ((status === "checking" || status === "dispatching") && typeof value.claimToken !== "string") return false
  if (["dispatched", "completed", "failed"].includes(status) && typeof value.acceptedSessionId !== "string") return false
  if (["completed", "failed"].includes(status) && typeof value.terminalAt !== "string") return false
  return true
}

function validState(value: unknown): value is AutomationState {
  if (
    !record(value) ||
    !exactKeys(value, ["schemaVersion", "owner", "paused", "generation", "updatedAt", "lastIntentAt", "setup", "job"]) ||
    value.schemaVersion !== 1 ||
    !validPersistedOwner(value.owner) ||
    typeof value.paused !== "boolean" ||
    typeof value.generation !== "number" ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    !safeDate(value.updatedAt) ||
    !safeDate(value.lastIntentAt) ||
    !record(value.setup) ||
    (value.job !== null && !validJob(value.job))
  ) return false

  const setup = value.setup
  return (
    exactKeys(setup, ["requestId", "requestedAt", "status"]) &&
    typeof setup.requestId === "string" &&
    setup.requestId.length > 0 &&
    safeDate(setup.requestedAt) &&
    typeof setup.status === "string" &&
    ["pending", "ready", "cancelled"].includes(setup.status)
  )
}

async function readText(response: GetBlobResult): Promise<string> {
  if (response.statusCode !== 200 || !Number.isSafeInteger(response.blob.size) || response.blob.size > MAX_BYTES) {
    fail("Automation state is unavailable")
  }

  const reader = response.stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      total += part.value.byteLength
      if (total > MAX_BYTES) fail("Automation state is unavailable")
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

export class AutomationStateStore {
  private readonly sdk: BlobSdk
  private readonly storeId: string | undefined
  private readonly now: () => Date

  constructor(options: { sdk?: Partial<BlobSdk>; storeId?: string; now?: () => Date } = {}) {
    this.sdk = { get, put, ...options.sdk }
    this.storeId = options.storeId ?? process.env.BLOB_STORE_ID
    this.now = options.now ?? (() => new Date())
  }

  async read(): Promise<AutomationState | null> {
    return (await this.load()).state
  }

  async beginSetup(ownerInput: AutomationOwner, requestId: string, requestedAt: string): Promise<{ ticket: SetupTicket; scheduledFor: string | null }> {
    const owner = this.owner(ownerInput)
    this.validateIntent(requestedAt, true)
    if (!requestId || requestId.length > 512 || requestId === PAUSED_TOMBSTONE) fail("Invalid automation setup request")

    return this.mutate((current) => {
      const now = this.clock().toISOString()
      if (!current) {
        return {
          state: this.pending(owner, requestId, requestedAt, 1, now),
          result: { ticket: { requestId, generation: 1 }, scheduledFor: null },
        }
      }
      if (!sameOwner(current.owner, owner)) fail("Automation owner mismatch")
      if (current.setup.requestId === requestId) {
        if (current.setup.status === "cancelled") fail("Automation setup request is stale")
        return {
          state: current,
          result: { ticket: { requestId, generation: current.generation }, scheduledFor: current.job?.dueAt ?? null },
        }
      }
      if (intentMicros(requestedAt)! <= intentMicros(current.lastIntentAt)!) fail("Automation setup request is stale")
      if (current.job && ["scheduled", "checking", "dispatching", "dispatched"].includes(current.job.status)) fail("Automation setup is busy until the accepted diagnostic is reconciled")

      const generation = current.generation + 1
      return {
        state: this.pending(owner, requestId, requestedAt, generation, now),
        result: { ticket: { requestId, generation }, scheduledFor: null },
      }
    })
  }

  async completeSetup(ticket: SetupTicket): Promise<AutomationJob> {
    if (!ticket || typeof ticket.requestId !== "string" || !Number.isSafeInteger(ticket.generation)) {
      fail("Invalid automation setup ticket")
    }

    return this.mutate((current) => {
      if (!current || current.generation !== ticket.generation || current.setup.requestId !== ticket.requestId || current.setup.status === "cancelled") {
        fail("Automation setup ticket is stale")
      }
      if (current.setup.status === "ready" && current.job && current.job.id === jobId(ticket.requestId)) {
        return { state: current, result: current.job }
      }
      if (current.setup.status !== "pending") fail("Automation setup ticket is stale")

      const job: AutomationJob = { id: jobId(ticket.requestId), dueAt: dueAt(this.clock()), status: "scheduled" }
      return {
        state: { ...current, paused: false, updatedAt: this.clock().toISOString(), setup: { ...current.setup, status: "ready" }, job },
        result: job,
      }
    })
  }

  /** Arms one immediate, owner-bound diagnostic for a trusted internal trigger. */
  async armImmediate(requestId: string): Promise<AutomationJob> {
    if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 256) {
      fail("Invalid automation trigger request")
    }

    return this.mutate((current) => {
      if (!current || current.paused || current.setup.status !== "ready") {
        fail("Automation is not ready")
      }
      if (current.job && ["scheduled", "checking", "dispatching", "dispatched"].includes(current.job.status)) {
        fail("Automation trigger is busy")
      }
      if (current.job?.terminalAt && this.clock().getTime() - Date.parse(current.job.terminalAt) < FIVE_MINUTES) {
        fail("Automation trigger cooldown is active")
      }

      const now = this.clock().toISOString()
      const job: AutomationJob = { id: jobId(requestId), dueAt: now, status: "scheduled" }
      return {
        state: {
          ...current,
          paused: false,
          generation: current.generation + 1,
          updatedAt: now,
          lastIntentAt: now,
          setup: { ...current.setup, status: "ready" },
          job,
        },
        result: job,
      }
    })
  }

  async pause(ownerInput: AutomationOwner, requestedAt: string): Promise<AutomationState> {
    const owner = this.owner(ownerInput)
    this.validateIntent(requestedAt, false)

    return this.mutate((current) => {
      const now = this.clock().toISOString()
      if (!current) {
        const state: AutomationState = {
          schemaVersion: 1,
          owner,
          paused: true,
          generation: 1,
          updatedAt: now,
          lastIntentAt: requestedAt,
          setup: { requestId: PAUSED_TOMBSTONE, requestedAt, status: "cancelled" },
          job: null,
        }
        return { state, result: state }
      }
      if (!sameOwner(current.owner, owner)) fail("Automation owner mismatch")
      if (intentMicros(requestedAt)! <= intentMicros(current.lastIntentAt)!) return { state: current, result: current }

      const active: AutomationJob | null = current.job && ["dispatching", "dispatched"].includes(current.job.status)
        ? current.job
        : current.job && ["scheduled", "checking"].includes(current.job.status)
          ? { ...current.job, status: "cancelled", claimToken: undefined }
          : current.job
      const state: AutomationState = {
        ...current,
        paused: true,
        generation: current.generation + 1,
        updatedAt: now,
        lastIntentAt: requestedAt,
        setup: { ...current.setup, status: "cancelled" },
        job: active,
      }
      return { state, result: state }
    })
  }

  async claimDue(): Promise<ClaimedAutomationJob | null> {
    const now = this.clock().getTime()
    const claimToken = randomUUID()
    return this.mutate((current) => {
      if (!current || current.paused || current.setup.status !== "ready" || !current.job || current.job.status !== "scheduled") {
        return { state: current, result: null }
      }
      const due = Date.parse(current.job.dueAt)
      if (due > now) return { state: current, result: null }
      if (now - due > FIFTEEN_MINUTES) {
        const job: AutomationJob = { ...current.job, status: "blocked", failureCode: "schedule_expired" }
        return { state: { ...current, job, updatedAt: this.clock().toISOString() }, result: null }
      }

      const job: AutomationJob = { ...current.job, status: "checking", claimToken }
      return {
        state: { ...current, job, updatedAt: this.clock().toISOString() },
        result: { job, owner: current.owner, generation: current.generation },
      }
    })
  }

  async authorizeDispatch(claim: ClaimedAutomationJob): Promise<boolean> {
    return this.mutate((current) => {
      if (!this.matches(current, claim) || current!.paused || current!.job!.status !== "checking") {
        return { state: current, result: false }
      }
      const job: AutomationJob = { ...current!.job!, status: "dispatching" }
      return { state: { ...current!, job, updatedAt: this.clock().toISOString() }, result: true }
    })
  }

  async markDispatched(claim: ClaimedAutomationJob, sessionId: string): Promise<void> {
    if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 256) fail("Invalid automation session")
    await this.mutate<void>((current) => {
      if (!this.matchesDispatch(current, claim)) fail("Automation claim is stale")
      const job: AutomationJob = { ...current!.job!, status: "dispatched", acceptedSessionId: sessionId, claimToken: undefined }
      return { state: { ...current!, job, updatedAt: this.clock().toISOString() }, result: undefined }
    })
  }

  /** Reconcile the accepted session from a durable runtime lifecycle event. */
  async reconcileSession(sessionId: string, outcome: "completed" | "failed", failureCode?: string): Promise<boolean> {
    if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 256) fail("Invalid automation session")
    if (outcome === "failed" && (failureCode === undefined || !/^[a-z0-9][a-z0-9_:-]{0,63}$/.test(failureCode))) {
      fail("Invalid automation failure code")
    }
    return this.mutate((current) => {
      const job = current?.job
      if (!current || !job || job.acceptedSessionId !== sessionId) return { state: current, result: false }
      if (job.status === outcome) return { state: current, result: true }
      if (job.status !== "dispatched") return { state: current, result: false }
      const nextJob: AutomationJob = {
        ...job,
        status: outcome,
        terminalAt: this.clock().toISOString(),
        failureCode: outcome === "failed" ? failureCode : undefined,
        claimToken: undefined,
      }
      return { state: { ...current, job: nextJob, updatedAt: this.clock().toISOString() }, result: true }
    })
  }

  /** Marks a dispatched session stale only after it has exceeded the recovery age. */
  async reconcileStaleDispatch(ownerInput: AutomationOwner, maxAgeMs = FIFTEEN_MINUTES): Promise<{ reconciled: boolean; state: AutomationState | null }> {
    if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < FIFTEEN_MINUTES) fail("Invalid stale recovery age")
    const owner = this.owner(ownerInput)
    return this.mutate<{ reconciled: boolean; state: AutomationState | null }>((current) => {
      if (!current) return { state: current, result: { reconciled: false, state: current } }
      if (!sameOwner(current.owner, owner)) fail("Automation owner mismatch")
      const job = current.job
      if (!job || job.status !== "dispatched" || !job.acceptedSessionId) {
        return { state: current, result: { reconciled: false, state: current } }
      }
      const age = this.clock().getTime() - Date.parse(current.updatedAt)
      if (!Number.isFinite(age) || age < maxAgeMs) {
        return { state: current, result: { reconciled: false, state: current } }
      }
      const terminalAt = this.clock().toISOString()
      const nextJob: AutomationJob = {
        ...job,
        status: "failed",
        terminalAt,
        failureCode: "session_stale",
        claimToken: undefined,
      }
      const state = { ...current, job: nextJob, updatedAt: terminalAt }
      return { state, result: { reconciled: true, state } }
    })
  }

  async block(claim: ClaimedAutomationJob, code: string): Promise<void> {
    if (!/^[a-z0-9][a-z0-9_:-]{0,63}$/.test(code)) fail("Invalid automation block code")
    await this.mutate<void>((current) => {
      if (!this.matches(current, claim) || current!.job!.status !== "checking") return { state: current, result: undefined }
      const job: AutomationJob = { ...current!.job!, status: "blocked", failureCode: code, claimToken: undefined }
      return { state: { ...current!, job, updatedAt: this.clock().toISOString() }, result: undefined }
    })
  }

  private clock(): Date {
    const value = this.now()
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail("Automation clock is unavailable")
    return value
  }

  private owner(input: AutomationOwner): AutomationOwner {
    try {
      return validateAutomationOwner(input)
    } catch {
      fail("Invalid automation owner")
    }
  }

  private validateIntent(value: string, setup: boolean): void {
    const requestedMicros = intentMicros(value)
    const futureLimit = BigInt(this.clock().getTime() + FUTURE_TOLERANCE_MS) * 1000n
    if (requestedMicros === null || requestedMicros > futureLimit) {
      fail(setup ? "Invalid automation setup request" : "Invalid automation pause request")
    }
  }

  private pending(owner: AutomationOwner, requestId: string, requestedAt: string, generation: number, now: string): AutomationState {
    return {
      schemaVersion: 1,
      owner,
      paused: true,
      generation,
      updatedAt: now,
      lastIntentAt: requestedAt,
      setup: { requestId, requestedAt, status: "pending" },
      job: null,
    }
  }

  private matches(current: AutomationState | null, claim: ClaimedAutomationJob): boolean {
    return !!current && current.generation === claim.generation && sameOwner(current.owner, claim.owner) && !!current.job && current.job.id === claim.job.id && current.job.claimToken === claim.job.claimToken
  }

  private matchesDispatch(current: AutomationState | null, claim: ClaimedAutomationJob): boolean {
    return !!current && sameOwner(current.owner, claim.owner) && !!current.job && current.job.id === claim.job.id && current.job.claimToken === claim.job.claimToken && current.job.status === "dispatching" && (current.generation === claim.generation || current.paused)
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

  private async load(): Promise<Loaded> {
    let response: GetBlobResult | null
    try {
      response = await this.sdk.get(STATE_PATH, { access: "private", useCache: false, ...(this.storeId ? { storeId: this.storeId } : {}) })
    } catch {
      fail("Unable to read automation state")
    }
    if (!response) return { state: null }

    try {
      const value: unknown = JSON.parse(await readText(response))
      if (!validState(value) || !response.blob.etag?.trim()) fail("Automation state is unavailable")
      let normalizedOwner: AutomationOwner
      try {
        normalizedOwner = validateAutomationOwner(value.owner)
      } catch {
        fail("Automation state is unavailable")
      }
      if (ownerKey(value.owner) !== ownerKey(normalizedOwner)) fail("Automation state is unavailable")
      return { state: value, etag: response.blob.etag }
    } catch (error) {
      if (error instanceof Error && error.message === "Automation state is unavailable") throw error
      fail("Automation state is unavailable")
    }
  }

  private async mutate<T>(operation: (state: AutomationState | null) => Mutation<T>): Promise<T> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      const loaded = await this.load()
      const outcome = operation(loaded.state)
      if (outcome.state === loaded.state) return outcome.result

      const body = `${JSON.stringify(outcome.state)}\n`
      if (new TextEncoder().encode(body).byteLength > MAX_BYTES) fail("Automation state is unavailable")
      try {
        await this.sdk.put(STATE_PATH, body, this.blobOptions(loaded.etag))
        return outcome.result
      } catch (error) {
        if (isConcurrency(error, !loaded.state) && attempt + 1 < MAX_RETRIES) continue
        if (isConcurrency(error, !loaded.state)) fail("Automation state changed concurrently")
        fail("Unable to persist automation state")
      }
    }
    fail("Automation state changed concurrently")
  }
}

export const AUTOMATION_STATE_PATH = STATE_PATH
