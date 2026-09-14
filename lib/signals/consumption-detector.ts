import {
  SCHEMA_VERSION,
  signalSchema,
  type Account,
  type Signal,
  type SourceReference,
} from "./contracts"
import { createEvidenceId, createSignalId } from "./stable-id"
import type { SignalRepository, StorageWriteResult } from "./storage"

/** Local boundary for issue #11's normalized, bounded aggregate output. */
export type ConsumptionWindow = {
  start: string
  end: string
  value: number
  /** 0..1 coverage of the expected periods in this window. */
  completeness: number
  /** Explicitly false means the source says the window is not final. */
  complete?: boolean
  receivedAt?: string
  /** The source reported values after the window was closed. */
  late?: boolean
}

export type ConsumptionGrowthInput = {
  account: Account
  source: SourceReference
  metricName: string
  unit: string
  previous: ConsumptionWindow
  current: ConsumptionWindow
}

export type ConsumptionDetectorConfig = {
  /** Both windows must have this duration when supplied. */
  comparisonWindowMs?: number
  /** A window below this coverage is unknown, not zero. */
  minimumCompleteness?: number
  /** Previous values at or below this value are not a reliable denominator. */
  tinyBase?: number
  /** Required absolute increase, when supplied. */
  minimumAbsoluteGrowth?: number
  /** Required relative increase, e.g. 0.25 means 25%, when supplied. */
  minimumRelativeGrowth?: number
  /** Reject source-late windows by default; callers may explicitly allow them. */
  lateData: "reject" | "allow"
  /** Stable output severity; defaults to warning. */
  severity?: "info" | "warning" | "critical"
}

export type ConsumptionDetectionReason =
  | "invalid_input"
  | "window_mismatch"
  | "incomplete_data"
  | "late_data"
  | "tiny_base"
  | "below_threshold"
  | "detected"

export type ConsumptionDetectionResult = {
  signal: Signal | null
  reason: ConsumptionDetectionReason
  absoluteGrowth?: number
  relativeGrowth?: number
}

const defaults: Omit<Required<ConsumptionDetectorConfig>, "comparisonWindowMs"> & {
  comparisonWindowMs?: number
} = {
  minimumCompleteness: 1,
  tinyBase: 1,
  minimumAbsoluteGrowth: 0,
  minimumRelativeGrowth: 0.25,
  lateData: "reject",
  severity: "warning",
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function validWindow(window: ConsumptionWindow) {
  return (
    typeof window === "object" &&
    window !== null &&
    typeof window.start === "string" &&
    typeof window.end === "string" &&
    !Number.isNaN(Date.parse(window.start)) &&
    !Number.isNaN(Date.parse(window.end)) &&
    Date.parse(window.end) > Date.parse(window.start) &&
    finite(window.value) &&
    window.value >= 0 &&
    finite(window.completeness) &&
    window.completeness >= 0 &&
    window.completeness <= 1 &&
    (window.complete === undefined || typeof window.complete === "boolean") &&
    (window.receivedAt === undefined || !Number.isNaN(Date.parse(window.receivedAt)))
  )
}

function maxTimestamp(...values: string[]) {
  return values.reduce((latest, value) =>
    Date.parse(value) > Date.parse(latest) ? value : latest,
  )
}

function windowEvidence(
  input: ConsumptionGrowthInput,
  label: "previous" | "current",
  window: ConsumptionWindow,
) {
  const recordId = `${input.source.recordId}:${label}`
  return {
    schemaVersion: SCHEMA_VERSION as 1,
    id: createEvidenceId(input.source.system, recordId, window.end),
    kind: "usage_metric" as const,
    source: input.source,
    capturedAt: window.end,
    summary: `${label === "previous" ? "Previous" : "Current"} ${input.metricName}: ${window.value} ${input.unit} (${window.start} to ${window.end})`,
    excerpt: null,
    attributes: {
      window: label,
      windowStart: window.start,
      windowEnd: window.end,
      value: window.value,
      unit: input.unit,
      completeness: window.completeness,
      complete: window.complete ?? true,
      late: window.late ?? false,
    },
  }
}

/**
 * Detects a meaningful increase between two complete, equal-duration windows.
 * This function is pure: identical input produces identical IDs and content.
 */
export function detectConsumptionGrowth(
  input: ConsumptionGrowthInput,
  requestedConfig: Partial<ConsumptionDetectorConfig> = {},
): ConsumptionDetectionResult {
  const config = { ...defaults, ...requestedConfig }
  if (!validWindow(input.previous) || !validWindow(input.current) ||
      typeof input.metricName !== "string" || !input.metricName.trim() ||
      typeof input.unit !== "string" || !input.unit.trim()) {
    return { signal: null, reason: "invalid_input" }
  }

  const previousDuration = Date.parse(input.previous.end) - Date.parse(input.previous.start)
  const currentDuration = Date.parse(input.current.end) - Date.parse(input.current.start)
  if (previousDuration !== currentDuration ||
      (config.comparisonWindowMs !== undefined &&
        (previousDuration !== config.comparisonWindowMs || currentDuration !== config.comparisonWindowMs))) {
    return { signal: null, reason: "window_mismatch" }
  }
  if (input.current.start !== input.previous.end) {
    return { signal: null, reason: "window_mismatch" }
  }
  if (input.previous.completeness < config.minimumCompleteness ||
      input.current.completeness < config.minimumCompleteness ||
      input.previous.complete === false || input.current.complete === false) {
    return { signal: null, reason: "incomplete_data" }
  }
  if (config.lateData === "reject" && (input.previous.late === true || input.current.late === true)) {
    return { signal: null, reason: "late_data" }
  }
  if (input.previous.value <= config.tinyBase) {
    return { signal: null, reason: "tiny_base" }
  }

  const absoluteGrowth = input.current.value - input.previous.value
  const relativeGrowth = absoluteGrowth / input.previous.value
  if (absoluteGrowth < config.minimumAbsoluteGrowth || relativeGrowth < config.minimumRelativeGrowth) {
    return { signal: null, reason: "below_threshold", absoluteGrowth, relativeGrowth }
  }

  const observedAt = input.current.end
  const receivedAt = maxTimestamp(
    input.source.collectedAt,
    observedAt,
    input.previous.receivedAt ?? observedAt,
    input.current.receivedAt ?? observedAt,
  )
  const evidence = [
    windowEvidence(input, "previous", input.previous),
    windowEvidence(input, "current", input.current),
  ]
  const signal = signalSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    id: createSignalId(input.account.id, "consumption_growth", input.source.system, input.source.recordId, observedAt),
    account: input.account,
    category: "consumption_growth",
    source: input.source,
    observedAt,
    receivedAt,
    title: `${input.metricName} consumption increased significantly`,
    detail: `${input.metricName} increased from ${input.previous.value} to ${input.current.value} ${input.unit} (${(relativeGrowth * 100).toFixed(1)}%, +${absoluteGrowth}).`,
    direction: "expansion",
    severity: config.severity,
    evidence,
    confidence: Math.min(input.previous.completeness, input.current.completeness),
    metric: {
      name: input.metricName,
      value: input.current.value,
      unit: input.unit,
      previousValue: input.previous.value,
    },
  })
  return { signal, reason: "detected", absoluteGrowth, relativeGrowth }
}

/** Detect and save once; repository identity makes reruns idempotent. */
export function detectAndStoreConsumptionGrowth(
  repository: SignalRepository,
  input: ConsumptionGrowthInput,
  config: Partial<ConsumptionDetectorConfig> = {},
): ConsumptionDetectionResult & { write?: StorageWriteResult<Signal> } {
  const result = detectConsumptionGrowth(input, config)
  if (!result.signal) return result
  return { ...result, write: repository.saveSignal(result.signal) }
}
