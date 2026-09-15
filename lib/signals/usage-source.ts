import { z } from "zod"

const MAX_COMPARISON_WINDOW_DAYS = 31
const MAX_QUERY_WINDOW_DAYS = 366
const DEFAULT_COMPARISON_WINDOW_DAYS = 7
const DEFAULT_EXPECTED_INTERVAL_HOURS = 24
const DEFAULT_RISING_THRESHOLD = 0.1
const DEFAULT_SPARSE_THRESHOLD = 0.8

const utcTimestampSchema = z.iso.datetime({ offset: true })

export const rawUsageMetricRowSchema = z
  .object({
    accountId: z.string().trim().min(1),
    metric: z.string().trim().min(1),
    grain: z.string().trim().min(1).optional(),
    value: z.number().finite().nonnegative(),
    unit: z.string().trim().min(1),
    observedAt: utcTimestampSchema,
    receivedAt: utcTimestampSchema,
  })
  .strict()

export type RawUsageMetricRow = z.input<typeof rawUsageMetricRowSchema>

export type UsageReadWindow = {
  startedAt: string
  endedAt: string
}

/** Read-only by design: credentials, mutation methods, and transport details stay outside the adapter. */
export interface UsageMetricClient {
  read(window: UsageReadWindow): Promise<readonly RawUsageMetricRow[]>
}

export const usageSeriesStatusSchema = z.enum(["stable", "rising", "sparse", "incomplete", "missing"])
export type UsageSeriesStatus = z.infer<typeof usageSeriesStatusSchema>

/** Source finality is separate from calendar coverage. A closed calendar window may still be settling. */
export const usageWindowFinalitySchema = z.enum(["final", "provisional", "unknown"])
export type UsageWindowFinality = z.infer<typeof usageWindowFinalitySchema>

export const normalizedUsagePointSchema = z
  .object({
    observedAt: utcTimestampSchema,
    value: z.number().finite().nonnegative(),
    unit: z.string().min(1),
    receivedAt: utcTimestampSchema,
    latencyMs: z.number().int().nonnegative(),
  })
  .strict()

export type NormalizedUsagePoint = z.infer<typeof normalizedUsagePointSchema>

export const normalizedUsageSeriesSchema = z
  .object({
    accountId: z.string().min(1),
    metric: z.string().min(1),
    unit: z.string().min(1),
    status: usageSeriesStatusSchema,
    currentValue: z.number().finite().nonnegative().nullable(),
    previousValue: z.number().finite().nonnegative().nullable(),
    changeRatio: z.number().finite().nullable(),
    points: z.array(normalizedUsagePointSchema),
    /** Coverage of the current calendar window only; this is not source finality. */
    completeness: z.number().finite().min(0).max(1),
    currentCompleteness: z.number().finite().min(0).max(1),
    previousCompleteness: z.number().finite().min(0).max(1),
    currentFinality: usageWindowFinalitySchema,
    previousFinality: usageWindowFinalitySchema,
    observedPointCount: z.number().int().nonnegative(),
    previousObservedPointCount: z.number().int().nonnegative(),
    expectedPointCount: z.number().int().positive(),
    latePointCount: z.number().int().nonnegative(),
    averageLatencyMs: z.number().finite().nonnegative().nullable(),
    maxLatencyMs: z.number().int().nonnegative().nullable(),
  })
  .strict()

export type NormalizedUsageSeries = z.infer<typeof normalizedUsageSeriesSchema>

export const normalizedUsageResultSchema = z
  .object({
    window: z.object({ startedAt: utcTimestampSchema, endedAt: utcTimestampSchema }).strict(),
    comparisonWindow: z
      .object({ startedAt: utcTimestampSchema, endedAt: utcTimestampSchema })
      .strict(),
    queriedWindow: z.object({ startedAt: utcTimestampSchema, endedAt: utcTimestampSchema }).strict(),
    comparisonWindowDays: z.number().positive(),
    expectedIntervalHours: z.number().positive(),
    series: z.array(normalizedUsageSeriesSchema),
  })
  .strict()

export type NormalizedUsageResult = z.infer<typeof normalizedUsageResultSchema>

export type UsageSourceOptions = {
  windowStartedAt: string
  windowEndedAt: string
  /** Accounts with no returned rows are emitted as `missing`. */
  accountIds?: readonly string[]
  comparisonWindowDays?: number
  expectedIntervalHours?: number
  risingThreshold?: number
  sparseThreshold?: number
  /** Explicit provider finality. Unknown is conservative and cannot produce a trend label. */
  currentWindowFinality?: UsageWindowFinality
  comparisonWindowFinality?: UsageWindowFinality
  /** Restrict ingestion to one provider metric and, when present, one provider grain. */
  metric?: string
  grain?: string
}

function canonicalUtc(value: string, field: string): string {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be a valid timestamp`)
  return new Date(parsed).toISOString()
}

function millisecondsBetween(startedAt: string, endedAt: string, field: string): number {
  const duration = Date.parse(endedAt) - Date.parse(startedAt)
  if (duration <= 0) throw new Error(`${field} must end after it starts`)
  return duration
}

function positiveFinite(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${field} must be positive`)
  return value
}

function normalizeUnit(unit: string): { name: string; multiplier: number } {
  const normalized = unit.trim().toLowerCase().replace(/\s+/g, "_")
  const aliases: Record<string, { name: string; multiplier: number }> = {
    b: { name: "bytes", multiplier: 1 },
    byte: { name: "bytes", multiplier: 1 },
    bytes: { name: "bytes", multiplier: 1 },
    kb: { name: "bytes", multiplier: 1_000 },
    kilobyte: { name: "bytes", multiplier: 1_000 },
    kilobytes: { name: "bytes", multiplier: 1_000 },
    mb: { name: "bytes", multiplier: 1_000_000 },
    megabyte: { name: "bytes", multiplier: 1_000_000 },
    gb: { name: "bytes", multiplier: 1_000_000_000 },
    gigabyte: { name: "bytes", multiplier: 1_000_000_000 },
    request: { name: "requests", multiplier: 1 },
    requests: { name: "requests", multiplier: 1 },
  }
  return aliases[normalized] ?? { name: normalized, multiplier: 1 }
}

function canonicalWindow(startedAt: string, endedAt: string, field: string) {
  const start = canonicalUtc(startedAt, `${field}.startedAt`)
  const end = canonicalUtc(endedAt, `${field}.endedAt`)
  const duration = millisecondsBetween(start, end, field)
  if (duration > MAX_QUERY_WINDOW_DAYS * 86_400_000) {
    throw new Error(`${field} cannot exceed ${MAX_QUERY_WINDOW_DAYS} days`)
  }
  return { startedAt: start, endedAt: end }
}

function periodValue(points: readonly NormalizedUsagePoint[], start: number, end: number) {
  const values = points.filter((point) => {
    const time = Date.parse(point.observedAt)
    return time >= start && time < end
  })
  return values.length === 0 ? null : values.reduce((sum, point) => sum + point.value, 0)
}

function distinctBucketCount(
  points: readonly NormalizedUsagePoint[],
  start: number,
  end: number,
  intervalMs: number,
): number {
  const buckets = new Set<number>()
  for (const point of points) {
    const time = Date.parse(point.observedAt)
    if (time >= start && time < end) buckets.add(Math.floor((time - start) / intervalMs))
  }
  return buckets.size
}

function latencyMetadata(points: readonly NormalizedUsagePoint[]) {
  if (points.length === 0) return { latePointCount: 0, averageLatencyMs: null, maxLatencyMs: null }
  const latencies = points.map((point) => point.latencyMs)
  return {
    latePointCount: latencies.filter((latency) => latency > 0).length,
    averageLatencyMs: latencies.reduce((sum, latency) => sum + latency, 0) / latencies.length,
    maxLatencyMs: Math.max(...latencies),
  }
}

/** Fetches and normalizes usage without knowing anything about the underlying network source. */
export async function ingestUsageMetrics(
  client: UsageMetricClient,
  options: UsageSourceOptions,
): Promise<NormalizedUsageResult> {
  const window = canonicalWindow(options.windowStartedAt, options.windowEndedAt, "window")
  const windowDuration = Date.parse(window.endedAt) - Date.parse(window.startedAt)
  const comparisonWindowDays = Math.min(
    options.comparisonWindowDays ?? DEFAULT_COMPARISON_WINDOW_DAYS,
    MAX_COMPARISON_WINDOW_DAYS,
    windowDuration / 86_400_000,
  )
  positiveFinite(comparisonWindowDays, "comparisonWindowDays")
  const expectedIntervalHours = positiveFinite(
    options.expectedIntervalHours ?? DEFAULT_EXPECTED_INTERVAL_HOURS,
    "expectedIntervalHours",
  )
  const risingThreshold = options.risingThreshold ?? DEFAULT_RISING_THRESHOLD
  const sparseThreshold = options.sparseThreshold ?? DEFAULT_SPARSE_THRESHOLD
  if (risingThreshold < 0 || sparseThreshold < 0 || sparseThreshold > 1) {
    throw new Error("risingThreshold must be non-negative and sparseThreshold must be between 0 and 1")
  }

  const comparisonDuration = comparisonWindowDays * 86_400_000
  const comparisonWindow = {
    startedAt: new Date(Date.parse(window.startedAt) - comparisonDuration).toISOString(),
    endedAt: window.startedAt,
  }
  const queriedWindow = { startedAt: comparisonWindow.startedAt, endedAt: window.endedAt }
  const configuredMetric = options.metric?.trim()
  const configuredGrain = options.grain?.trim()
  if (options.metric !== undefined && !configuredMetric) throw new Error("metric must not be empty")
  if (options.grain !== undefined && !configuredGrain) throw new Error("grain must not be empty")
  const rawRows = await client.read(queriedWindow)
  const rows = rawRows.map((row) => rawUsageMetricRowSchema.parse(row))
  if (configuredMetric && rows.some((row) => row.metric !== configuredMetric)) {
    throw new Error(`Usage response contains a metric other than configured metric ${configuredMetric}`)
  }
  if (configuredGrain && rows.some((row) => row.grain !== configuredGrain)) {
    throw new Error(`Usage response contains a grain other than configured grain ${configuredGrain}`)
  }

  const grouped = new Map<string, RawUsageMetricRow[]>()
  for (const row of rows) {
    const key = `${row.accountId}\u0000${row.metric}`
    const group = grouped.get(key) ?? []
    group.push(row)
    grouped.set(key, group)
  }
  for (const accountId of options.accountIds ?? []) {
    grouped.set(`${accountId}\u0000consumption`, grouped.get(`${accountId}\u0000consumption`) ?? [])
  }

  const expectedPointCount = Math.max(1, Math.ceil(windowDuration / (expectedIntervalHours * 3_600_000)))
  const series = [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, rawGroup]) => {
    const [accountId, metric] = key.split("\u0000")
    const normalizedByObservedAt = new Map<string, NormalizedUsagePoint>()
    for (const row of rawGroup) {
      const observedAt = canonicalUtc(row.observedAt, "observedAt")
      const receivedAt = canonicalUtc(row.receivedAt, "receivedAt")
      const latencyMs = Date.parse(receivedAt) - Date.parse(observedAt)
      if (latencyMs < 0) throw new Error("receivedAt must not precede observedAt")
      const unit = normalizeUnit(row.unit)
      const candidate = { observedAt, value: row.value * unit.multiplier, unit: unit.name, receivedAt, latencyMs }
      const existing = normalizedByObservedAt.get(observedAt)
      if (!existing || receivedAt > existing.receivedAt || (receivedAt === existing.receivedAt && JSON.stringify(candidate) < JSON.stringify(existing))) {
        normalizedByObservedAt.set(observedAt, candidate)
      }
    }
    const normalized = [...normalizedByObservedAt.values()].sort((left, right) => left.observedAt.localeCompare(right.observedAt))
    const units = new Set(normalized.map((point) => point.unit))
    if (units.size > 1) throw new Error(`Metric ${metric} for ${accountId} contains incompatible units`)
    const unit = normalized[0]?.unit ?? "unknown"
    const windowStart = Date.parse(window.startedAt)
    const windowEnd = Date.parse(window.endedAt)
    const comparisonStart = Date.parse(comparisonWindow.startedAt)
    const comparisonEnd = Date.parse(comparisonWindow.endedAt)
    const intervalMs = expectedIntervalHours * 3_600_000
    const currentValue = periodValue(normalized, windowStart, windowEnd)
    const previousValue = periodValue(normalized, comparisonStart, comparisonEnd)
    const currentPointCount = distinctBucketCount(normalized, windowStart, windowEnd, intervalMs)
    const previousPointCount = distinctBucketCount(normalized, comparisonStart, comparisonEnd, intervalMs)
    const currentCompleteness = Math.min(1, currentPointCount / expectedPointCount)
    const previousCompleteness = Math.min(1, previousPointCount / expectedPointCount)
    const currentFinality = options.currentWindowFinality ?? "unknown"
    const previousFinality = options.comparisonWindowFinality ?? "unknown"
    const changeRatio = currentValue !== null && previousValue !== null && previousValue > 0
      ? (currentValue - previousValue) / previousValue
      : currentValue === 0 && previousValue === 0
        ? 0
        : null
    const comparable = currentCompleteness >= 1 && previousCompleteness >= 1 &&
      currentFinality === "final" && previousFinality === "final" &&
      currentValue !== null && previousValue !== null && (previousValue > 0 || currentValue === 0)
    const status: UsageSeriesStatus = currentPointCount === 0
      ? "missing"
      : currentCompleteness < sparseThreshold || previousCompleteness < sparseThreshold
        ? "sparse"
        : !comparable
          ? "incomplete"
          : changeRatio !== null && changeRatio >= risingThreshold
            ? "rising"
            : "stable"
    return normalizedUsageSeriesSchema.parse({
      accountId, metric, unit, status, currentValue, previousValue, changeRatio,
      points: normalized, completeness: currentCompleteness, currentCompleteness, previousCompleteness,
      currentFinality, previousFinality, observedPointCount: currentPointCount,
      previousObservedPointCount: previousPointCount, expectedPointCount,
      ...latencyMetadata(normalized.filter((point) => {
        const time = Date.parse(point.observedAt)
        return time >= windowStart && time < windowEnd
      })),
    })
  })

  return normalizedUsageResultSchema.parse({
    window, comparisonWindow, queriedWindow, comparisonWindowDays, expectedIntervalHours, series,
  })
}

export const normalizeUsage = ingestUsageMetrics
