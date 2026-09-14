import { describe, expect, it } from "vitest"
import { redactedSignals } from "./redacted-fixtures"
import {
  DEFAULT_SHADOW_PILOT_CONFIG,
  disableShadowPilot,
  evaluateShadowPilot,
  rollbackShadowPilot,
  type PilotCase,
  type RedactedPilotSample,
} from "./pilot"

const missSignal = { ...redactedSignals[3], severity: "info" as const, confidence: 0.1 }

const sample: RedactedPilotSample = {
  signals: [redactedSignals[0], redactedSignals[1], redactedSignals[2], missSignal],
  labels: [
    { id: "tp-project", signal: redactedSignals[0], relevant: true, rationale: "Synthetic project change" },
    { id: "tp-usage", signal: redactedSignals[1], relevant: true, rationale: "Synthetic usage change" },
    { id: "fp-hiring", signal: redactedSignals[2], relevant: false, rationale: "Synthetic review label" },
    { id: "miss-news", signal: missSignal, relevant: true, rationale: "Synthetic miss label" },
  ] satisfies PilotCase[],
  sourceFailures: [{ source: "company_news", code: "FIXTURE_TIMEOUT", retryable: true }],
}

describe("shadow pilot", () => {
  it("evaluates precision, coverage, misses, false positives, and source failures", () => {
    const result = evaluateShadowPilot(sample, { ...DEFAULT_SHADOW_PILOT_CONFIG, threshold: 55 })

    expect(result.metrics).toEqual({
      truePositives: 2,
      falsePositives: 1,
      misses: 1,
      precision: 0.6667,
      coverage: 0.6667,
      sourceFailures: 1,
      evaluatedCases: 4,
    })
    expect(result.cases.map((item) => item.outcome)).toEqual(["true_positive", "true_positive", "false_positive", "miss"])
    expect(result.effects).toEqual({ persisted: false, deliveredToSlack: false })
  })

  it("uses configuration-backed threshold and ranking tuning", () => {
    const baseline = evaluateShadowPilot(sample, { ...DEFAULT_SHADOW_PILOT_CONFIG, threshold: 80 })
    const tuned = evaluateShadowPilot(sample, {
      ...DEFAULT_SHADOW_PILOT_CONFIG,
      threshold: 120,
      taxonomy: { it_hiring: "platform hiring" },
      ranking: { weights: { signalType: { it_hiring: 100 } } },
      revision: "shadow-pilot-v2",
    })

    expect(tuned.config.revision).toBe("shadow-pilot-v2")
    expect(tuned.config.taxonomy.it_hiring).toBe("platform hiring")
    expect(tuned.metrics).not.toEqual(baseline.metrics)
  })

  it("disables selection without persistence or Slack delivery", () => {
    const disabled = evaluateShadowPilot(sample, disableShadowPilot(DEFAULT_SHADOW_PILOT_CONFIG))

    expect(disabled.mode).toBe("disabled")
    expect(disabled.rankedOpportunities).toEqual([])
    expect(disabled.metrics).toMatchObject({ truePositives: 0, falsePositives: 0, misses: 3 })
    expect(disabled.effects).toEqual({ persisted: false, deliveredToSlack: false })
  })

  it("rolls back to a known-good revision and leaves the pilot disabled", () => {
    const current = { ...DEFAULT_SHADOW_PILOT_CONFIG, revision: "v2", threshold: 120 }
    const knownGood = { ...DEFAULT_SHADOW_PILOT_CONFIG, revision: "v1", threshold: 80 }

    expect(rollbackShadowPilot(current, knownGood)).toMatchObject({ mode: "disabled", revision: "v1", threshold: 80 })
  })
})
