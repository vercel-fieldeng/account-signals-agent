# Deployed Eve change-digest evaluation

## Product goal

Help Sam and Stefan quickly see actionable changes across their verified book of business: consumption, actual product adoption, Tech/IT hiring, and relevant attributable LinkedIn posts. An account biography or a manually assembled CLI report does not satisfy this goal.

## Execution boundary

The acceptance run starts with a real authorized Slack user message to the deployed Eve bot. Eve must perform its own source calls and generate the result. The PO/PM may inspect traces and results and change the implementation, but must not supply prior manual account findings as if Eve discovered them.

Use a five-account sample and fixed, explicit UTC comparison periods for the initial test. The sample is not whole-book coverage. The pilot currently validates Salesforce scope plus d0 consumption/adoption evidence only; Tech/IT hiring and LinkedIn are partial-scope/unknown unless an approved non-authenticated source succeeds. Do not advance production baselines, enable schedules, or mutate customer systems during this test.

A draft is not a triggered run. A bot-authored progress message is not an authenticated human invocation. Missing user authorization must remain an explicit blocker; never spoof a Slack principal or disable route protection to run the test.

## Acceptance rubric

### Hard gates

- A production Eve run and its source tool calls are identifiable in Vercel telemetry.
- Every promoted claim is supported by source evidence for the correct account/entity and period.
- Usage comparisons use comparable complete windows, explicit units, and verified account-to-team mappings.
- Missing telemetry is not zero. First observations are not automatically new adoption or new jobs.
- Billing rows, project counts, and entitlements are not sufficient evidence of product adoption.
- Failed/incomplete job retrieval is not evidence of a job removal.
- LinkedIn results must have attributable company content and verified publication dates. Index misses are coverage gaps, not evidence of no posts. No authenticated scraping.
- The test does not write production baselines or enable the morning schedule.

### Summary quality

- Approximately 1,800 characters or fewer for the main summary.
- At most three distinct ranked accounts; group corroborating changes rather than filling multiple slots with the same account.
- Each highlight contains the verified change, relevant before/after values and units, why it merits attention, evidence reference, and a concrete next check.
- State exact comparison periods and compact per-source coverage across the five-account sample.
- Do not pad with generic company descriptions, normal low-value fluctuations, tiny-base percentage spikes, historical posts, or SQL dumps.
- Avoid asserting a cause (launch, migration, campaign) unless independently supported.
- Detailed evidence and limitations belong in thread detail when supported, without hiding material coverage limits from the main summary.

### Delivery quality

- One coherent result in the requesting Slack conversation; no duplicate completion posts or repeated authorization loops.
- A completed source operation is distinguishable from an idle durable session still accepting follow-ups.
- Give concise progress only for a meaningful phase change or actionable blocker.
- Never call an incomplete run healthy or complete solely because one source returned data.

## Feedback loop

1. Capture the deployed commit, actual Slack request/reply timestamps, and Eve run ID without committing customer results or credentials.
2. Observe an initial run before changing runtime behavior. Record actual tool success, authorization, delays, and output.
3. Score the hard gates and summary/delivery criteria against the actual reply, not anticipated behavior.
4. Fix demonstrated failures and add deterministic regression coverage for the corrected behavior.
5. Deploy, trigger Eve again from an authorized session, and compare the output against the same rubric.
6. Test recurrence and source failures before claiming unattended morning monitoring readiness.

Local unit tests supplement this loop. They cannot establish deployed source access, source truth, correct OAuth propagation, or Slack delivery on their own.

## Current test status

The initial native five-account diagnostic was observed in the target Slack channel on 2026-09-15 UTC (Slack message timestamp `1789460245.207609`). Source authorization, exact account verification, and d0 retrieval completed, but the report exposed four quality defects: duplicate visible finding ranks, “product adoption” language for a consumption spike, a stable/declining interpretation while the final day was still settling, and no per-finding AE/SA route or concrete deep-dive owner.

The deployed improvement changes the system instructions, native diagnostic prompt, and Slack delivery contract to require:

- one bounded context pass after candidate detection;
- dated, attributable hypotheses classified as explained/expected, actionable, watch, or insufficient evidence;
- actionable-only human routing;
- BLUF as the top-level Slack message and evidence/hypotheses/limitations in one thread reply;
- one contiguous rank sequence across at most three distinct accounts;
- consumption/adoption separation and finality-safe trend language.

A post-change native run was observed at Slack message timestamp `1789463759.871959`. It corrected the four baseline defects: ranks were contiguous and account-distinct, consumption was not labelled adoption, provisional data was not labelled stable/declining, and every finding had verified routing plus a deep-dive action. That run still omitted exact comparison-window lines and compact per-finding evidence/source references. The current iteration addresses those omissions and adds event-day contextual investigation plus BLUF/thread delivery.

The current build is deployed to the production project and its Eve health endpoint is `READY`. Local verification is complete: 32 test files passed, 196 tests passed, 1 live Blob test was skipped, TypeScript passed, and Eve build passed with the existing non-blocking `agent/delivery/` discovery warning. A fresh native run was observed at Slack message timestamp `1789465022.515949`: Nintendo was classified high-confidence explained/expected from dated first-party Nintendo Direct events and suppressed; all other changes remained watch-only because data was provisional; the BLUF was posted at the root and one concise context/evidence reply was posted in its thread. The latest deployed iteration now adds explicit project/domain/current-footprint/commercial-motion context instructions and deterministic Slack Block Kit layout; those changes await the next live run for runtime scoring.
