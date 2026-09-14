# Issue 24: shadow-mode pilot and signal-quality tuning

## Guardrails

The pilot is review-only. `evaluateShadowPilot` is a pure function: it accepts typed, redacted fixtures and has no storage repository or Slack client. Every result asserts `effects.persisted: false` and `effects.deliveredToSlack: false`. It must never call production baseline promotion, write a run/snapshot/signal, update a source checkpoint, or send a Slack payload.

`mode: "disabled"` is the explicit kill switch. `disableShadowPilot` returns a new disabled configuration. `rollbackShadowPilot` restores a known-good revision and leaves it disabled until approval. Neither function mutates state.

## Typed evaluation model

- `PilotCase.relevant` is a reviewer label, not a claim inferred from customer data.
- A selected relevant case is a **true positive**.
- A selected irrelevant case is a **false positive**.
- An unselected relevant case is a **miss**.
- `PilotSourceFailure` records source, safe error code, and retryability separately from signal quality.
- Use only `redacted-fixtures.ts` or synthetic data. Do not paste account names, URLs, excerpts, payloads, tokens, or identifiers from production into a fixture or log.

The exported `redactedPilotSample` is intentionally empty except for a synthetic source-failure marker; tests use the existing redacted fixture signals to exercise the rubric.

## Metrics and review rubric

`evaluateShadowPilot` reports:

- **Precision** = true positives / (true positives + false positives).
- **Coverage** (recall) = true positives / (true positives + misses).
- Empty denominators are reported as `1` so an empty cohort is not treated as a failure; reviewers must still record cohort size.
- Counts for true positives, false positives, misses, evaluated cases, and source failures.

For every reviewed candidate, record the case ID, relevant/irrelevant decision, rationale, selected status, ranking score/opportunity, and source health. A source failure is not a false positive or a miss; it is a coverage/input-quality issue and must be tracked separately. Reviewers should inspect false positives and misses by source, category, taxonomy, and ranking score before changing configuration.

## Configuration-backed tuning workflow

1. Start from `DEFAULT_SHADOW_PILOT_CONFIG` and assign a revision.
2. Change one controlled dimension at a time: `threshold`, `taxonomy`, or `ranking` weights/recency/cap. Keep the exact config with the evaluation artifact.
3. Re-run the same redacted sample and a fixed regression cohort. Compare precision, coverage, false-positive/miss counts, source failures, and rank/order stability.
4. Do not promote a configuration based on precision alone: set explicit minimum precision and coverage targets with Sam and Stefan for the cohort. No target is implied by this document.
5. Keep the pilot in shadow mode through review. There is no production baseline or Slack output in this path.

Taxonomy labels are configuration, not ad-hoc string edits in the evaluator. Ranking behavior remains delegated to the existing `rankSignals` implementation, so ranking tuning exercises the same scoring contract used by the product while remaining non-persistent.

## Regression checks

Before each tuning revision, run:

```sh
pnpm vitest run lib/signals/pilot.test.ts
pnpm test
pnpm exec tsc --noEmit
```

The focused tests must cover metric arithmetic, threshold/ranking changes, source-failure accounting, disabled selection, and rollback. Also verify that all pilot results retain `persisted: false` and `deliveredToSlack: false`, that redacted fixtures contain no customer data, and that deterministic ranking/order is unchanged unless the config intentionally changes it.

## Approval checkpoints and rollback

- **Sam checkpoint:** approve the redacted evaluation cohort, rubric labels, and proposed threshold/taxonomy/ranking revision before any further pilot run.
- **Stefan checkpoint:** independently review false positives, misses, source failures, and regression output; approve the same revision and rollout decision.
- Both approvals must be recorded against the config revision. A single approval does not authorize production delivery.
- If either reviewer rejects the result, call `rollbackShadowPilot(current, knownGood)`, retain the known-good revision, and keep `mode: "disabled"` while investigating.
- On any privacy concern, unexpected source failure, precision/coverage regression, ranking instability, or contract/test failure, call `disableShadowPilot(config)` immediately. Re-enable only with a new explicit checkpoint; this document provides no automatic promotion path.
