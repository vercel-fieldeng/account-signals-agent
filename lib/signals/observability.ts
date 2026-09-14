import type { RunResult, SourceSystem } from "./contracts"

type RunError = RunResult["errors"][number]

export type ObservabilityLevel = "debug" | "info" | "warn" | "error"

export type CorrelationIds = {
  runId: string
  accountId?: string
  source?: SourceSystem
  correlationId: string
}

export type StructuredLog = CorrelationIds & {
  level: ObservabilityLevel
  event: string
  message: string
  at: string
  details: Record<string, unknown>
}

export type SourceAttempt = {
  accountId: string
  source: SourceSystem
  status: "succeeded" | "failed" | "skipped"
  signalCount?: number
  error?: Pick<RunError, "code" | "message" | "retryable">
}

export type DeliveryResult = {
  attempted: number
  delivered: number
  failed?: number
}

export type RunMetricsInput = {
  runId: string
  startedAt: string
  completedAt?: string
  expectedAccountIds: readonly string[]
  attempts: readonly SourceAttempt[]
  delivery?: DeliveryResult
}

export type RunMetrics = {
  runId: string
  durationMs: number | null
  coverage: {
    expectedAccounts: number
    attemptedAccounts: number
    coveredAccounts: number
    ratio: number
  }
  sources: {
    attempted: number
    succeeded: number
    failed: number
    successRatio: number
  }
  signals: {
    total: number
    bySource: Partial<Record<SourceSystem, number>>
  }
  delivery: {
    attempted: number
    delivered: number
    failed: number
    successRatio: number | null
  }
}

export type FailureSummary = {
  source: SourceSystem | null
  code: string
  message: string
  retryable: boolean
  count: number
}

export type StaleRun = {
  runId: string
  stale: boolean
  ageMs: number
  thresholdMs: number
  reason: "running-too-long" | "completed-after-threshold" | null
}

export type ReplayScope = {
  runId: string
  accountId: string
  source: SourceSystem
}

export type ReplayOperatorOverride = {
  approvedBy: string
  reason: string
}

export type ReplayRequest = ReplayScope & {
  id: string
  requestedBy: string
  requestedAt: string
  reason: string
  operatorOverride?: ReplayOperatorOverride
  status: "requested"
}

export type ReplayAuditEvent = ReplayRequest & {
  event: "replay_requested" | "replay_deduplicated"
}

export type LogSink = (entry: StructuredLog) => void

const secretKey = /(?:authorization|api[-_]?key|credential|cookie|password|private[-_]?key|secret|token)/i
const rawKey = /(?:body|payload|raw|response|request)/i
const bearer = /\b(?:bearer|basic)\s+[A-Za-z0-9+/_=.-]+/gi
const querySecret = /((?:[?&]|\b)(?:token|key|secret|password|signature|auth)\s*=\s*)[^&#\s]+/gi
const longSecret = /\b(?:sk|pk|ghp|xox[baprs])-?[A-Za-z0-9_-]{12,}\b/gi

function safeMessage(message: string) {
  return message
    .replace(bearer, "[REDACTED]")
    .replace(querySecret, "$1[REDACTED]")
    .replace(longSecret, "[REDACTED]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 500)
}

function safeValue(value: unknown, key = ""): unknown {
  if (secretKey.test(key) || rawKey.test(key)) return "[REDACTED]"
  if (typeof value === "string") return safeMessage(value)
  if (Array.isArray(value)) return value.map((item) => safeValue(item))
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        safeValue(entryValue, entryKey),
      ]),
    )
  }
  if (typeof value === "bigint") return value.toString()
  return value
}

/** Sanitizes messages and removes credential/raw-payload shaped fields recursively. */
export function redactLogDetails(details: Record<string, unknown> = {}) {
  return safeValue(details) as Record<string, unknown>
}

export function sanitizeLogMessage(message: string) {
  return safeMessage(message)
}

function ratio(numerator: number, denominator: number) {
  return denominator === 0 ? 1 : Number((numerator / denominator).toFixed(4))
}

export function createRunMetrics(input: RunMetricsInput): RunMetrics {
  const expected = new Set(input.expectedAccountIds)
  const attemptedAccounts = new Set(input.attempts.map((attempt) => attempt.accountId))
  const coveredAccounts = new Set(
    input.attempts
      .filter((attempt) => attempt.status === "succeeded")
      .map((attempt) => attempt.accountId),
  )
  const succeeded = input.attempts.filter((attempt) => attempt.status === "succeeded").length
  const failed = input.attempts.filter((attempt) => attempt.status === "failed").length
  const bySource: Partial<Record<SourceSystem, number>> = {}
  for (const attempt of input.attempts) {
    bySource[attempt.source] = (bySource[attempt.source] ?? 0) + (attempt.signalCount ?? 0)
  }
  const attempted = input.attempts.length
  const delivery = input.delivery ?? { attempted: 0, delivered: 0, failed: 0 }
  const deliveryFailed = delivery.failed ?? Math.max(0, delivery.attempted - delivery.delivered)

  return {
    runId: input.runId,
    durationMs:
      input.completedAt === undefined
        ? null
        : Math.max(0, Date.parse(input.completedAt) - Date.parse(input.startedAt)),
    coverage: {
      expectedAccounts: expected.size,
      attemptedAccounts: attemptedAccounts.size,
      coveredAccounts: [...coveredAccounts].filter((id) => expected.has(id)).length,
      ratio: ratio([...coveredAccounts].filter((id) => expected.has(id)).length, expected.size),
    },
    sources: {
      attempted,
      succeeded,
      failed,
      successRatio: ratio(succeeded, attempted),
    },
    signals: { total: input.attempts.reduce((sum, item) => sum + (item.signalCount ?? 0), 0), bySource },
    delivery: {
      attempted: delivery.attempted,
      delivered: delivery.delivered,
      failed: deliveryFailed,
      successRatio: delivery.attempted === 0 ? null : ratio(delivery.delivered, delivery.attempted),
    },
  }
}

export function summarizeFailures(errors: readonly RunError[]): FailureSummary[] {
  const summaries = new Map<string, FailureSummary>()
  for (const error of errors) {
    const message = safeMessage(error.message)
    const key = `${error.source ?? "none"}\u0000${error.code}\u0000${message}\u0000${error.retryable}`
    const existing = summaries.get(key)
    if (existing) existing.count += 1
    else summaries.set(key, { source: error.source, code: safeMessage(error.code), message, retryable: error.retryable, count: 1 })
  }
  return [...summaries.values()]
}

export function detectStaleRun(
  run: { id: string; startedAt: string; completedAt?: string },
  now: string,
  thresholdMs: number,
): StaleRun {
  if (!Number.isFinite(thresholdMs) || thresholdMs < 0) throw new Error("thresholdMs must be non-negative")
  const ageMs = Math.max(0, Date.parse(now) - Date.parse(run.startedAt))
  const completed = run.completedAt !== undefined
  const stale = completed ? ageMs > thresholdMs : ageMs > thresholdMs
  return {
    runId: run.id,
    stale,
    ageMs,
    thresholdMs,
    reason: stale ? (completed ? "completed-after-threshold" : "running-too-long") : null,
  }
}

function replayId(scope: ReplayScope) {
  return `replay:${scope.runId}:${scope.accountId}:${scope.source}`
}

/** In-memory, scoped replay ledger. It never executes work; callers consume requests. */
export class ReplayLedger {
  private readonly requests = new Map<string, ReplayRequest>()
  private readonly audit: ReplayAuditEvent[] = []

  request(
    run: Pick<RunResult, "id" | "status" | "errors">,
    scope: Omit<ReplayScope, "runId">,
    requestedBy: string,
    requestedAt: string,
    reason: string,
    operatorOverride?: ReplayOperatorOverride,
  ): ReplayRequest {
    if (run.status === "succeeded") throw new Error("Replay is only available for failed or partial runs")
    if (!scope.accountId.trim() || !requestedBy.trim() || !reason.trim()) {
      throw new Error("Replay requires accountId, requestedBy, and reason")
    }
    if (operatorOverride && (!operatorOverride.approvedBy.trim() || !operatorOverride.reason.trim())) {
      throw new Error("Replay operator override requires approvedBy and reason")
    }
    const sourceError = run.errors.find((error) => error.source === scope.source)
    const eligible = sourceError?.retryable === true || operatorOverride !== undefined
    if (!eligible) throw new Error("Replay requires a retryable source error or an operator override")
    const fullScope = { runId: run.id, ...scope }
    const id = replayId(fullScope)
    const existing = this.requests.get(id)
    if (existing) {
      this.audit.push({ ...existing, event: "replay_deduplicated" })
      return { ...existing }
    }
    const request: ReplayRequest = {
      ...fullScope,
      id,
      requestedBy: safeMessage(requestedBy),
      requestedAt,
      reason: safeMessage(reason),
      ...(operatorOverride
        ? {
            operatorOverride: {
              approvedBy: safeMessage(operatorOverride.approvedBy),
              reason: safeMessage(operatorOverride.reason),
            },
          }
        : {}),
      status: "requested",
    }
    this.requests.set(id, request)
    this.audit.push({ ...request, event: "replay_requested" })
    return { ...request }
  }

  get(id: string) {
    const request = this.requests.get(id)
    return request && { ...request }
  }

  list() {
    return [...this.requests.values()].map((request) => ({ ...request }))
  }

  auditTrail() {
    return this.audit.map((event) => ({ ...event }))
  }
}

export function createStructuredLogger(
  ids: CorrelationIds,
  sink: LogSink,
  clock: () => string = () => new Date().toISOString(),
) {
  return (level: ObservabilityLevel, event: string, message: string, details?: Record<string, unknown>) => {
    sink({
      ...ids,
      level,
      event,
      message: safeMessage(message),
      at: clock(),
      details: redactLogDetails(details),
    })
  }
}

export function observeRunFailure(run: Pick<RunResult, "id" | "errors">) {
  return summarizeFailures(run.errors)
}
