# Owner-bound native autonomous diagnostic

`agent/schedules/live-diagnostic.ts` is a native Eve/Vercel cron dispatcher. It wakes once per minute so it can resume pending work and atomically arm one diagnostic per Europe/Berlin calendar date once 08:00 local time is reached. This catch-up gate is DST-correct and suppresses duplicate daily runs across redeploys and later manual triggers. Missing owner state, pending authorization, paused work, and active claims do not start another agent run.

## One-time operator setup

In the configured Account Signals Slack channel, Sam must select the actual bot mention and send:

```text
@account-signals-slack setup automation
```

This is an authorization/setup control, not an inbound trigger for customer-data collection. The existing verified Slack callback admits only the configured workspace, channel, and Sam's user ID. Bot/service callers and other users are rejected. It adds a trusted request marker derived from the actual Slack message timestamp. No model-supplied owner, destination, connector, or principal is accepted.

The configured workspace comes from the linked Connect Slack connector's `defaultInstallationId` and `data.slackTeam.id`, not bot-profile display metadata. Admission regression tests exercise Eve's real `defaultSlackAuth` helper. Rejections expose only a fixed diagnostic code (for example `workspace_not_allowed`), never credentials or raw identity payloads.

The root `setup_automation` tool:

1. Requires production execution, the verified operator, root context, and the trusted setup marker.
2. Writes pending setup metadata only; no runnable job exists yet.
3. Resolves d0 authorization through Eve's normal interactive OAuth flow. The caller follows any real sign-in button in the setup thread. Authorization waits propagate unchanged so Eve can resume the same operation.
4. Only after d0 token resolution succeeds, atomically saves a ready owner binding and one initial job due five minutes later, rounded up to the next UTC minute.
5. The minute dispatcher then reuses that owner binding to arm at most one run per Berlin date at or after 08:00 local time.

If consent fails, the job remains unarmed. A duplicate tool call or webhook replay does not create a second job or move its due time. Pause during OAuth invalidates the setup ticket; delayed consent completion cannot re-enable it.

The setup thread reports the exact scheduled UTC time only after a successful commit. Token issuance confirms a usable Connect grant at that point, not successful provider API access or future refresh behavior.

## Runtime credentials

Persisted owner data contains only a stable verified user principal, issuer, authenticator, and minimal Slack identity/destination attributes. The setup marker is removed before persistence. OIDC tokens, access tokens, refresh tokens, cookies, and client secrets are never saved in the job state.

Every due run revalidates the d0 Connect grant with `forceRefresh: true`, using current runtime workload OIDC and the saved user subject. Salesforce is not a runtime prerequisite. The scheduled Eve session receives that same verified user identity, while Slack delivery continues using the application's bot grant.

Index uses app-scoped `INDEX_ACCESS_TOKEN` and `INDEX_PROTECTION_BYPASS` Vercel Secrets. Neither value is committed, logged, or stored in the automation ledger. Index authorization failure degrades context enrichment and does not block or erase completed d0 evidence.

All active d0 authorization paths use the shared `d0TokenParams()` policy: scope `d0:invoke` and resource `https://d0-web.vercel.tools/eve/v1/mcp`. This must apply consistently to initial consent, token retrieval/completion, and the native scheduler's grant check. The deployed d0 [authorization validator](https://github.com/vercel/internal-agents/blob/b1393f604a2a19ad8186bb12e0aeec8c896b348c/agents/d0/src/lib/mcp-oauth/requests.ts#L30-L53) rejects a missing or different resource with `invalid_target`. Inspected [Connect source](https://github.com/vercel/api/blob/e1ef01fe192b358deb8e64bc3292322cd5fe7856/packages/connex/src/client-types/oauth/client-driver.ts#L685-L722) does not infer that parameter from the connector URL. The Connect source SHA is an inspected repository revision, not a verified production-backend revision. Explicit resource binding is required regardless.

The shared d0 connector is also linked to DSEve. Do not change its client, secret, grants, or PKCE settings to work around an application request bug. Connect selects PKCE automatically for public clients or advertised challenge support; the dashboard's “PKCE Required: No” is not evidence that the actual flow omits PKCE.

A consent callback and Eve's “connected” banner are not proof that Connect subsequently obtained a usable token. A post-consent token-validation failure must remain a failure, not be reported as missing user consent. The corrected resource contract still requires a live, operator-authorized setup check; source inspection and mocked serialization tests do not establish that the original failed callback contained `invalid_target`.

Read-only connector metadata checked on 2026-09-14 shows the d0 connector supports `user` subjects, has user authorization and refresh enabled, and is linked to production. That configuration is not proof that a particular user's provider refresh grant works end-to-end. A later autonomous invocation after token expiry is still required to prove renewal.

If a grant cannot be revalidated, the job is marked blocked and no agent starts. A fixed diagnostic notice is sent to the configured channel using the bot grant. It does not leak tokens, provider error payloads, or internal user IDs. If notification itself fails, state stays blocked and operator logs retain a safe failure stage.

## Status and pause

These exact mentions are handled deterministically, without a model turn:

```text
@account-signals-slack automation status
@account-signals-slack pause automation
@account-signals-slack recover automation
```

Controls require the same authenticated operator and production channel. Pause cancels pending setup and scheduled/checking jobs. Once dispatch is committed, the external handoff may still start; an accepted run is not cancelled and provider credentials are not revoked. Do not describe pause as stronger cancellation than this boundary.

A new explicit setup command can repair authorization and create a new initial test after a terminal job. It cannot replace a currently scheduled/checking/dispatching job. Once setup is ready and unpaused, the dispatcher automatically arms the daily run; an authorization-blocked job requires setup repair before recurrence resumes.

## State and concurrency

State is stored separately from production baselines at `account-signals/private/automation/control-v1.json`, using bounded private uncached reads and ETag-conditional writes. Setup readiness, pause, the last armed Berlin calendar date, claim, and dispatch transitions share this single control record. Existing schema-v1 records without a daily-date marker remain readable and migrate to schema v2 on the first recurring arm. After that write, rollback must use a revision that can read schema v2; the previous schema-v1-only reader is not compatible.

Slack intent timestamps retain microsecond precision so a newer pause cannot be discarded by millisecond truncation. Existing canonical three-digit ISO times remain readable. Unknown fields and malformed owner/job state fail closed.

At or after 08:00 Europe/Berlin, the scheduler atomically records that local date and creates a due job only if the owner is ready, unpaused, and has no active job. It then atomically claims the job as `checking`, verifies grants, and commits `dispatching` only if the claim is still current and unpaused. The accepted Eve session ID is recorded as `dispatched`; an Eve lifecycle hook reconciles it to `completed` after the final assistant message or to `failed` on a terminal session failure. `dispatched` therefore means accepted-but-unreconciled, not completed or delivered. Jobs more than fifteen minutes late become blocked rather than silently running stale work. Setup cannot replace an accepted diagnostic until that session is reconciled.

This is at-most-once dispatch-attempt behavior, not exactly-once external delivery. A crash during checking/dispatching or between successful handoff and state recording can leave ambiguous work. Do not automatically retry that claim. Inspect telemetry before authorizing another attempt. A lifecycle-hook failure leaves the job `dispatched` for reconciliation rather than falsely marking it terminal.

The earlier app-principal diagnostic and its separate legacy ledger are left intact as historical evidence. Its result proved cron/Slack delivery, but Salesforce failed with `principal_required` before a provider call.

## Account/data scope

Daily diagnostics ask d0 directly for up to 25 surfaced intent-signal rows using the stored definition of the semantic alert `New intent signals — Sam Maass SE book` (`GTM.ANALYTICS.ACCOUNT_INTENT_SIGNALS` joined to `GTM.ANALYTICS.ACCOUNTS`, `SE = Sam Maass`, `is_surfaced = TRUE`), with its rolling 24-hour predicate replaced by the last seven complete UTC calendar days using exact midnight-to-midnight half-open boundaries. The stored alert itself is paused and is never run, modified, or posted. The 08:00 Europe/Berlin execution schedule remains DST-correct, but it is deliberately decoupled from the source window because signal timestamps are date-grained at `00:00 UTC`.

Delivery is eventual and at-least-once. The source table is fully rebuilt without a per-row load timestamp, so rows for a day can appear after that day's brief; a d0 failure can also block a whole run. Every brief therefore re-checks the trailing seven days, ordered oldest first, and excludes `ACCOUNT_INTENT_SIGNAL_ID` values already delivered. The final model message ends with a machine-read `Reported signal IDs:` line. The Slack channel strips that line, and only after both posts of a Complete or Partial brief succeed in a bot-owned diagnostic thread does it record those IDs in `account-signals/private/automation/reported-signals-v1.json` (ETag-conditional, 21-day retention). Blocked, waiting, truncated, or unrecorded rows are therefore delivered by a later brief, as long as that happens within seven days. If the ledger cannot be read at dispatch, the brief runs without exclusions and states that repeats are possible; if recording fails, the next brief repeats those signals rather than dropping them. The scheduler preflight validates only the persisted operator's d0 grant. After d0 returns, the agent uses the environment-authenticated Index MCP to enrich at most three surfaced accounts: verify meeting/account associations, retain returned Salesforce Account IDs, attempt one bounded `sfdc_lookup`, and read at most one relevant speaker-attributed transcript per account. Salesforce/Index failure lowers hypothesis confidence but never suppresses d0 rows. A completed result keeps the BLUF under 2,000 characters, each account card under 420 characters, and each news card under 360 characters, using five single lines: Account, Signal, Hypothesis, Contacts, and Next. Context and Date are omitted from BLUF; Salesforce/Index evidence informs the hypothesis and moves to one compact Context line per account in DETAIL. Each hypothesis must combine d0 evidence with an attributable Salesforce or transcript fact and distinguish reinforcement of an existing motion from a possible new motion. DETAIL ends with one single-line coverage footer.

## Account news monitor

Each brief also calls `scan_account_news` once, independent of d0. It is a quiet change detector across the whole account watchlist, not account context: most days it returns no events and the brief then contains no news at all.

- **Watchlist:** a private Blob document (`account-signals/private/automation/news-watchlist-v1.json`) with each account's Salesforce name and ID, a clean search name, aliases for brands and subsidiaries, an optional disambiguating context term, the website domain, and a publisher flag for media accounts whose own articles are about other companies. Customer names never live in the repository. Manage it with `npx -y tsx --env-file=.env.local scripts/news-watchlist.ts push <file>` or `show`.
- **Search:** one Exa news search per account for the trailing seven days (10 results, LinkedIn excluded). About 70 accounts cost about 70 searches per day at roughly $0.007 each.
- **Deterministic checks:** the account must be named in the title or lead; namesakes, app stores and mirrors, API integration directories, review sites, homepages, stale items, and a publisher account's own articles are dropped; syndicated copies with near-identical titles collapse.
- **Judge:** `openai/gpt-6-astra-fast` through AI Gateway (override with `NEWS_JUDGE_MODEL`) rates each account's new items in one batch, with the account's already known events, as opportunity, risk, or neutral. Neutral is the default. A verdict is material only when it is about the account, a new dated event, not a duplicate or repeat, at least medium confidence, and backed by a verbatim quote that must occur in the item text. On a full-book replay of 680 results the judge kept 10 of 429 candidates; `gpt-5.6-luna-fast` kept 22 with clear false positives.
- **Novelty and delivery:** judged items are remembered for 21 days in `account-signals/private/automation/news-monitor-state-v1.json` (ETag-conditional), so each story is judged once. Material events stay pending for seven days until their `news:` IDs appear on the brief's `Reported signal IDs:` line and are recorded in the shared delivery ledger. A blocked or failed brief therefore delays news but does not drop it. At most six events are returned per brief; the rest stay pending.
- **Gates:** requires `EXTERNAL_SOURCES_ENABLED=1`, `EXTERNAL_SOURCE_TERMS_APPROVED=1`, `EXA_API_KEY`, `BLOB_STORE_ID`, and a seeded watchlist; otherwise the tool reports unavailable and the brief continues.
- **Local dry run:** `npx -y tsx --env-file=.env.local scripts/scan-account-news.ts [--watchlist <file>] [--exa-fixtures <file>] [--model <id>] [--dump-state <file>]` uses in-memory state and never writes the delivery ledger.

The account-selection requirement is still prompt policy, not a newly implemented deterministic account-authorization boundary. Do not claim otherwise. The scheduler does not read or write production signal baselines. The diagnostic prohibits baseline promotion, customer-system writes, shared exports, identity switching, and further schedules.

## Verification and rollout gates

Focused tests cover operator admission, secret-free owner persistence, OAuth replay, production-only d0 setup, Berlin DST boundaries, once-per-date daily arming, pause races, concurrent claims, private storage failure, native dispatch, continuation, and error redaction.

Before claiming end-to-end success:

1. Verify the production deployment is Ready and `vercel cron list` shows the minute dispatcher.
2. Complete the real operator setup; record its scheduled time without copying authorization links or credentials into docs.
3. After deployment, verify a log entry for `autonomous_diagnostic.daily_armed` at 08:00 Europe/Berlin (or catch-up after deployment) and confirm the same Berlin date is not armed twice.
4. Verify the cron request's logs link to an accepted Eve session and the channel receives its actual result. Agent Runs may label the destination channel as Slack; use cron request logs to establish the trigger.
5. Verify source evidence and account scope separately from token issuance.
6. Verify a later daily run after token expiry refreshes without another sign-in.

A passing unit test, a ready connector, a successful token request, and a dispatched state are not substitutes for these live checks.
