# Owner-bound native autonomous diagnostic

`agent/schedules/live-diagnostic.ts` is a native Eve/Vercel cron dispatcher. It wakes once per minute but starts customer work only for a due, explicitly armed, one-off diagnostic. Missing state, pending authorization, paused work, and terminal/claimed jobs never cause another agent run. The morning monitoring schedule is not enabled.

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
4. Only after d0 token resolution succeeds, atomically saves a ready owner binding and one job due five minutes later, rounded up to the next UTC minute.

If consent fails, the job remains unarmed. A duplicate tool call or webhook replay does not create a second job or move its due time. Pause during OAuth invalidates the setup ticket; delayed consent completion cannot re-enable it.

The setup thread reports the exact scheduled UTC time only after a successful commit. Token issuance confirms a usable Connect grant at that point, not successful provider API access or future refresh behavior.

## Runtime credentials

Persisted owner data contains only a stable verified user principal, issuer, authenticator, and minimal Slack identity/destination attributes. The setup marker is removed before persistence. OIDC tokens, access tokens, refresh tokens, cookies, and client secrets are never saved in the job state.

Every due run revalidates the d0 Connect grant with `forceRefresh: true`, using current runtime workload OIDC and the saved user subject. Salesforce is not a runtime prerequisite. The scheduled Eve session receives that same verified user identity, while Slack delivery continues using the application's bot grant.

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

A new explicit setup command can repair authorization and create a new one-off test after a terminal job. It cannot replace a currently scheduled/checking/dispatching job. No automatic recurring collection is created.

## State and concurrency

State is stored separately from production baselines at `account-signals/private/automation/control-v1.json`, using bounded private uncached reads and ETag-conditional writes. Setup readiness, pause, claim, and dispatch transitions share this single control record.

Slack intent timestamps retain microsecond precision so a newer pause cannot be discarded by millisecond truncation. Existing canonical three-digit ISO times remain readable. Unknown fields and malformed owner/job state fail closed.

The scheduler atomically claims a due job as `checking`, verifies grants, and commits `dispatching` only if the claim is still current and unpaused. The accepted Eve session ID is recorded as `dispatched`; an Eve lifecycle hook reconciles it to `completed` after the final assistant message or to `failed` on a terminal session failure. `dispatched` therefore means accepted-but-unreconciled, not completed or delivered. Jobs more than fifteen minutes late become blocked rather than silently running stale work. Setup cannot replace an accepted diagnostic until that session is reconciled.

This is at-most-once dispatch-attempt behavior, not exactly-once external delivery. A crash during checking/dispatching or between successful handoff and state recording can leave ambiguous work. Do not automatically retry that claim. Inspect telemetry before authorizing another attempt. A lifecycle-hook failure leaves the job `dispatched` for reconciliation rather than falsely marking it terminal.

The earlier app-principal diagnostic and its separate legacy ledger are left intact as historical evidence. Its result proved cron/Slack delivery, but Salesforce failed with `principal_required` before a provider call.

## Account/data scope

The diagnostic asks d0 directly for up to ten recent surfaced intent-signal rows using the existing semantic alert `New intent signals — Sam Maass SE book`, scoped as `SE = Sam Maass`, and an exact rolling three-day UTC window. It explicitly does not require a physical source column named `sales_engineer_name`. The scheduler preflight validates only the persisted operator's d0 grant. After d0 returns, the agent uses the environment-authenticated Index MCP to enrich at most three surfaced accounts: verify meeting/account associations, retain returned Salesforce Account IDs, attempt one bounded `sfdc_lookup`, and read at most one relevant speaker-attributed transcript per account. Salesforce/Index failure lowers hypothesis confidence but never suppresses d0 rows. A completed result uses Account, Signal, Context, Hypothesis, Contacts, and Next step cards with no Date field. Each hypothesis must combine d0 evidence with an attributable Salesforce or transcript fact and distinguish reinforcement of an existing motion from a possible new motion. DETAIL groups raw signals and context sources by account, followed by one coverage footer.

The account-selection requirement is still prompt policy, not a newly implemented deterministic account-authorization boundary. Do not claim otherwise. The scheduler does not read or write production signal baselines. The diagnostic prohibits baseline promotion, customer-system writes, shared exports, identity switching, and further schedules.

## Verification and rollout gates

Focused tests cover operator admission, secret-free owner persistence, OAuth replay, production-only d0 setup, exact intent ordering, idempotent setup, pause races, concurrent claims, private storage failure, native dispatch, continuation, and error redaction.

Before claiming end-to-end success:

1. Verify the production deployment is Ready and `vercel cron list` shows the minute dispatcher.
2. Complete the real operator setup; record its scheduled time without copying authorization links or credentials into docs.
3. Verify the cron request's logs link to an accepted Eve session and the channel receives its actual result. Agent Runs may label the destination channel as Slack; use cron request logs to establish the trigger.
4. Verify source evidence and account scope separately from token issuance.
5. Run another explicitly authorized diagnostic after token expiry to prove refresh without another sign-in.

A passing unit test, a ready connector, a successful token request, and a dispatched state are not substitutes for these live checks.
