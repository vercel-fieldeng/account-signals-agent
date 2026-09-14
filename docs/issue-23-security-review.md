# Issue 23: Security, privacy, and data-retention review

**Status:** completed review; production/pilot approval remains conditional on the deployment gates in this document.

**Scope:** scheduled ingestion, fetched third-party content, source adapters, storage, classification, and customer-facing Slack output for the account-signals agent. This review is documentation-only and does not change runtime code, contracts, connectors, or existing tests.

## Executive decision

The design has a defensible least-privilege and data-minimization boundary for a pilot, provided the operational controls below are enforced by the deployment. The checkout does **not** establish the production identity provider, database encryption/backup behavior, secret-manager bindings, audit-log access, or deletion mechanism. Those are deployment gates, not assumptions that may be treated as implemented.

- **Pilot status:** not approved until the high-severity deployment gate is evidenced.
- **High-severity findings accepted for pilot:** none.
- **Existing code-level regression coverage:** the current untracked `news-detector.test.ts` covers prompt-injection-like news suppression; `storage.test.ts` covers defensive storage behavior, successful-run promotion, checkpoint monotonicity, and explicit count-based pruning; `agent/channels/slack.ts` enforces an allowlisted channel and rejects direct messages. No additional issue-23-specific test is justified without modifying or duplicating user-owned implementation tests; this review therefore remains docs-only.

## Data inventory and classification

| Data | Examples in this repository | Classification | Minimum handling |
| --- | --- | --- | --- |
| Account identity and ownership | Salesforce Account ID, account name, domains, assigned owner role | **Internal / customer metadata** | Account-scoped access only; do not expose source IDs or connector details in Slack. |
| Source references | Stable record ID, canonical public URL, source system, collection time | **Internal / provenance metadata** | Keep only for attribution, deduplication, audit, and deletion targeting. URLs must be public and canonical where available. |
| Derived signal/evidence | Category, title, severity, confidence, short excerpt, metric | **Internal / customer-derived** | Minimize excerpts and attributes; preserve evidence status and incompleteness. Do not treat a signal as customer-provided fact without provenance. |
| Usage/project data | Team/project identifiers, quantities, units, coverage and freshness | **Confidential customer data** | Read-only, verified Salesforce-to-team mapping; no cross-account joins or broad exports. |
| Public careers/news content | Job title, public article title/excerpt, author, publication time | **Public source content; internal derived record** | Collect only approved first-party/public records; retain short excerpts, not raw pages. |
| Credentials and transport data | Slack, Salesforce, d0, and connector tokens; cookies; headers | **Secret / restricted** | Secret-manager or environment binding only; never commit, persist in signal records, or send to prompts/Slack. |
| Prompts and operational metadata | Agent instructions, task IDs, connector details, SQL, internal errors | **Internal restricted** | Specialist-to-parent only; never disclose to customers or untrusted content. |

The redacted fixtures use synthetic identifiers and `example` domains. Real customer records, credentials, cookies, query exports, and private URLs must not be placed in fixtures, documentation, or commits.

## Threat model

### Assets and trust boundaries

1. **Scheduled ingestion boundary:** a scheduler invokes a bounded read-only collection run. The scheduler, runtime identity, source clients, and storage are trusted only to the minimum needed for that run.
2. **External source boundary:** careers pages, ATS feeds, company news pages, public sitemaps, Vercel project/usage data, and provider responses are untrusted input. A successful HTTPS response is not authorization, truth, or an instruction.
3. **Normalization/classification boundary:** source records become validated observations and signals. Validation, canonicalization, attribution, bounded windows, and deterministic taxonomies are the safety boundary.
4. **Storage boundary:** accounts, snapshots, observations, signals, runs, and source checkpoints are customer or operational data. Storage must be account-scoped and must not become a raw-content archive.
5. **AI/specialist boundary:** the d0 specialist receives explicitly delegated context and returns evidence to the parent. It is not a customer-facing actor and has no authority to post, schedule, export, or mutate remote systems.
6. **Slack boundary:** the agent emits a concise customer-facing reply in the invoking conversation only. Slack is an output channel, not a data store or a control plane.

### Abuse and failure cases

| Threat | Impact | Required mitigation and current evidence |
| --- | --- | --- |
| Scheduled job runs with excessive scope or stale mapping | Cross-account disclosure or incorrect signals | Resolve and verify Salesforce Account ID/name; include every verified team only; bound URLs, windows, pages, cadence, and concurrency; fail/partial rather than silently broaden scope. See issues 4–6 and source adapters. |
| Malicious or compromised public page returns prompt injection, credentials, scripts, or oversized content | Instruction hijack, secret disclosure, resource exhaustion, or contaminated evidence | Treat fetched text as data; never execute HTML/JS or interpolate content into instructions; parse typed fields, cap excerpts, reject malformed/unattributed/non-first-party records, and suppress instruction-like news. The news detector explicitly documents this boundary and tests representative injection text. |
| Provider response contains another account's project/usage rows | Tenant isolation failure | Filter to verified team IDs/account mappings; report unmapped rows; never assign by name/domain; preserve incomplete status. |
| Duplicate, replayed, or reordered source data | Double-counting or cursor rollback | Stable IDs, idempotent writes, canonical URLs/provider IDs, and monotonic source checkpoints. Older retries must not move a checkpoint backward. |
| Storage or logs retain more than necessary | Privacy, breach, and deletion exposure | Store contract fields and short attributable excerpts only; no raw HTML, cookies, session headers, tokens, applicant data, or unnecessary personal data. Apply time/count retention and deletion procedures below. |
| Specialist or model reveals instructions or posts externally | Internal prompt/data disclosure | Specialist is explicitly non-customer-facing and non-writing; parent suppresses connector details, credentials, prompts, and task identifiers; all customer responses stay in the invoking Slack conversation. |
| Slack mention arrives from an unapproved channel or DM | Unauthorized output or data access | Current channel adapter returns no auth outside the allowlisted channel and rejects direct messages. The allowlist must be configuration-controlled and reviewed when channel ownership changes. |
| Source terms or robots rules prohibit collection | Legal/privacy and provider-access violation | Check robots and published terms before fetching; stop on prohibition, authentication challenge, CAPTCHA, or 401/403; do not use LinkedIn scraping. |
| Connector token is leaked, compromised, or access is no longer needed | Unauthorized source access | Use separate read-only identities, secret-manager rotation, immediate revocation runbook, and post-revocation verification. Never place tokens in repository or model context. |

## Least privilege and access control checklist

### Scheduled ingestion and adapters

- [ ] Use a dedicated runtime identity for scheduled collection, separate from interactive Slack handling.
- [ ] Grant source-specific read-only permissions: Salesforce account lookup, verified Vercel team/project/usage reads, and public HTTPS fetches only. No write, admin, billing mutation, schedule creation, export, or arbitrary URL crawling permission.
- [ ] Pass only the verified account mapping, explicit UTC window, approved source/query, and required output contract to a specialist. Do not pass local paths, unrelated accounts, secrets, cookies, or broad conversation history.
- [ ] Enforce account/team authorization before every retrieval, not only when the roster is initially built. A domain match is discovery context, not authorization.
- [ ] Bound each run by account, source URL, time window, page count, response size, timeout, retry policy, and concurrency. Treat incomplete pagination or partial access as an explicit error.
- [ ] Use separate credentials and scopes per connector where supported. Do not share the Slack bot credential with source retrieval or storage.

### Storage and operators

- [ ] Restrict read/write access by role: collector can write its own run artifacts; customer-facing agent can read only promoted, account-scoped summaries; operators can inspect diagnostics without receiving secrets or raw source payloads.
- [ ] Enforce tenant/account filters at repository or service boundaries; never rely solely on callers to supply a correct `accountId`.
- [ ] Encrypt customer data at rest and in transit in the deployment; restrict backups, replicas, logs, and support access to the same retention and deletion policy.
- [ ] Audit reads, writes, exports, deletions, permission changes, and connector use without logging tokens or raw customer content.
- [ ] Do not expose `executed SQL`, internal prompts, source errors containing sensitive provider details, or connector identifiers in customer Slack replies.

### Slack

- [ ] Keep the current allowlisted channel behavior and direct-message rejection.
- [ ] Verify Slack app installation, channel membership, and least-privilege scopes in the deployment; do not use broad workspace export/history scopes unless separately approved.
- [ ] Reply only in the invoking conversation. Never post to a shared channel, create a thread elsewhere, or send a shared export from a scheduled task.
- [ ] Redact account IDs, team IDs, URLs that are not public, exact query text, credentials, internal prompt text, and personal data from replies.

## Secret handling

- Credentials for Slack, Salesforce, d0, storage, and source connectors belong in the deployment secret manager or platform environment bindings. `.env*.local` is ignored for local development, but this is not a substitute for production secret management.
- Never commit secrets, access tokens, API keys, private URLs, cookies, authorization headers, raw request/response dumps, or customer exports. Secret values must not appear in source references, evidence attributes, prompts, logs, fixtures, screenshots, or Slack.
- Do not send credentials to an AI model or include them in delegated messages. The adapter interfaces intentionally receive a client boundary rather than transport credentials.
- Rotate on suspected exposure; revoke before rotation when practical; invalidate old sessions/tokens; inspect access logs; and record the incident without copying the secret into the ticket.
- Use short-lived, audience-bound credentials where the provider supports them. Prefer read-only scopes and separate credentials for collection, Slack output, and operations.

## Untrusted content and prompt-injection isolation

Fetched titles, descriptions, excerpts, page markup, feed fields, job descriptions, and provider-returned text are **data**, never instructions. The following rules apply regardless of whether the source is first-party:

1. Fetch only the approved public URL and treat redirects, links, markup, embedded metadata, and text as untrusted.
2. Do not execute fetched scripts, HTML, templates, SQL, shell commands, URLs, or model/tool directives.
3. Keep source text in typed data fields. Do not concatenate it into system/developer instructions or delegated authority statements.
4. Normalize and bound fields before storage or classification; retain only a short excerpt necessary for attribution.
5. Classify against a fixed, reviewed taxonomy or an explicitly constrained model contract. A model may summarize evidence but may not select tools, change account scope, approve a source, send Slack, or alter retention.
6. Suppress or quarantine content containing instruction-like requests, malformed content, missing attribution, or conflicting provenance. Suppression is not evidence of “no signal.”
7. Re-validate model output against the signal schema, source/account identity, confidence bounds, and evidence linkage before storage or display.

The current news detector uses a deterministic checked-in taxonomy, marks fetched text as data, and suppresses representative instruction-like text. The same isolation contract must be applied if an AI classifier is introduced or substituted later; the current deterministic detector is not evidence that a future model integration is safe by default.

## Source terms, provenance, and collection policy

The source strategy in `docs/issue-6-source-strategy.md` is the governing boundary:

- Prefer public, first-party company careers/news pages and company-authorized public ATS feeds. Public sitemaps/RSS may discover URLs; the linked first-party article or job record is the evidence.
- Check and honor `robots.txt`, published website/API/feed terms, provider limits, and `Retry-After`. Robots permission does not override terms, law, authentication, or an explicit prohibition.
- Use a descriptive user agent where permitted; do not rotate identities, bypass CAPTCHA, evade rate limits, authenticate to scrape, or reuse personal sessions.
- Do not use job aggregators, search snippets, employee-submitted listings, scraped social profiles, or authenticated LinkedIn as primary evidence. `linkedin_api` remains disabled until separate legal/privacy review, product approval, and an approved API/commercial access path exist.
- Poll no more frequently than the documented six-hour source cadence, use bounded windows (maximum 30-day initial backfill in the source strategy), and do not turn a failed or partial fetch into an empty result.
- Preserve source system, stable record ID/canonical URL, observation time, collection time, and a short attributable excerpt. A signal must not imply company endorsement.
- Quarantine malformed or unverifiable content; do not emit evidence for it.

Terms approval is a gate for each host and connector, not a one-time assumption. Record the host, policy/terms review date, allowed path, cadence, and reviewer in deployment operations without storing credentials or unnecessary page content.

## Retention, deletion, and minimization

### Retention schedule

The default policy is the shortest period that supports deduplication, audit, and the product use case:

| Record | Default retention | Deletion rule |
| --- | ---: | --- |
| Raw fetched HTML, scripts, cookies, headers, request bodies, and provider dumps | **0 days / prohibited** | Do not persist; remove temporary buffers after parsing. |
| Normalized public source records and short evidence excerpts | **90 days after last use** | Delete source record and linked evidence after the period, unless a stricter customer/legal policy applies. |
| Derived observations and signals | **90 days after last use** | Delete or anonymize linked source/evidence records together; preserve only approved aggregate history if policy permits. |
| Run diagnostics and source checkpoints | **90 days after last use** | Delete diagnostics/checkpoints with the associated account/source data; never retain secrets in diagnostics. |
| Account mappings and owner metadata | **While actively in scope, then 30 days** | Delete on account removal/revocation after the operational hold period, unless legal hold requires preservation. |
| Backups, replicas, caches, and logs | **Same policy; maximum documented backup lag** | Apply deletion propagation and verify expiry; do not use backups to bypass deletion. |

The existing in-memory repository has explicit count limits and defensive copies, and prunes accounts, snapshots, observations, signals, runs, and checkpoints. Those limits are a bounded-memory safeguard, **not** a complete time-based retention or deletion implementation. A persistent deployment must implement the schedule above and expose deletion evidence.

### Deletion procedure

1. Authenticate and authorize the deletion request or account-offboarding event.
2. Identify the Salesforce Account ID, stable account ID, mapped teams, source record IDs, observations, evidence, signals, runs, checkpoints, caches, logs, and backups in scope.
3. Place a documented legal hold only when authorized; otherwise delete source payloads and derived records in dependency order.
4. Revoke scheduled collection and connector access for the account before re-ingestion can recreate data.
5. Propagate deletion to replicas, backups according to the documented backup schedule, caches, and exports; do not post a deletion request or customer data to Slack.
6. Verify by account-scoped queries and storage-provider deletion receipts. Record timestamps, actor, scope, result, and any bounded residual caused by backup expiry—never the deleted content itself.
7. Re-run access checks after deletion and close the request only when all in-scope stores are covered.

Deletion requests and stricter customer/legal policy override the defaults. Legal holds must be explicit, access-controlled, time-bounded, and reviewed.

## Connector revocation and incident response

### Immediate connector revocation

Use this procedure for suspected credential exposure, unauthorized access, source-term change, account offboarding, or a connector no longer required:

1. Stop the affected scheduler and disable the connector binding; do not retry failed requests.
2. Revoke the token, session, app installation, OAuth grant, or API key at the provider. Remove cached credentials and invalidate sessions.
3. Rotate replacement credentials with narrower read-only scopes and a new audience/account boundary. Do not restore collection until ownership and terms are re-verified.
4. Preserve only non-secret audit metadata: connector name, account scope, timestamps, actor, provider response class, and run IDs.
5. Search logs, prompts, Slack messages, fixtures, and repository history for exposure; redact or purge copies according to the deletion policy.
6. Determine affected accounts, source windows, records, recipients, and retention stores. Notify the security/privacy owner through the approved internal incident path.
7. Re-enable only after access review, source-terms review, test collection against redacted data, and an explicit sign-off.

### Incident severity

- **Critical:** confirmed secret exposure, cross-account disclosure, unauthorized Slack/customer disclosure, or active connector compromise. Stop collection/output immediately, revoke access, preserve audit metadata, and escalate to the security/privacy incident process.
- **High:** a control can permit cross-account access, unbounded collection, raw-content retention, or model/tool authority without isolation. Block pilot until corrected and independently verified.
- **Medium:** missing provenance, incomplete deletion propagation, excessive scopes without observed exploitation, or a single-source control failure. Track to a dated remediation owner; do not hide it as a successful run.
- **Low:** documentation drift, stale allowlist metadata, or non-security usability gaps with no access expansion. Fix in normal maintenance.

## Findings and pilot gates

| ID | Severity | Finding | Disposition / mitigation | Pilot state |
| --- | --- | --- | --- | --- |
| SEC-23-01 | High | Production storage, encryption, tenant isolation, audit access, and deletion propagation are not represented in the checkout; the repository implementation is in-memory and count-bounded only. | Before pilot, provide deployment evidence for account-scoped authorization, encryption in transit/at rest, backup/cache/log retention, deletion verification, and operator access review. Until then, no production customer data. | **Open gate; no pilot approval** |
| SEC-23-02 | High | A future AI classifier could grant fetched content influence over instructions or tools if integrated without an explicit boundary. | Current detector is deterministic and suppresses instruction-like content. Any AI integration must use the isolation contract above, schema-validate output, deny tool authority, and add an issue-specific regression test before enablement. | **Resolved for current code; future integration blocked by gate** |
| SEC-23-03 | Medium | Source terms/robots approval and connector revocation are operational processes, not enforced by the source-adapter interfaces alone. | Maintain per-host terms/robots records, stop on prohibition/challenge, use read-only scoped credentials, and exercise the revocation runbook before pilot. | **Required operational control** |
| SEC-23-04 | Medium | Count-based pruning does not itself implement the 90-day time-based schedule or deletion requests. | Persistent storage must add time-based expiry, linked-record deletion, backup/cache propagation, and deletion receipts. | **Required before persistent rollout** |
| SEC-23-05 | Low | Slack allowlisting is currently a source-level constant, so channel ownership/configuration drift requires review. | Keep direct-message rejection and invoking-channel-only replies; review the allowlist during deployment/channel changes and verify Slack scopes. | **Accepted with operational review** |

**Release rule:** SEC-23-01, SEC-23-03, and SEC-23-04 must have evidence and an owner/date before pilot. No high-severity finding may be accepted as residual risk for the pilot.

## Internal app-security checklist completion

- [x] Threat model covers scheduled ingestion, untrusted fetched content, storage, classification/AI boundary, and Slack output.
- [x] Data classification, minimization, and default retention periods are documented.
- [x] Least privilege, secret handling, access control, and source/account scoping are documented.
- [x] Untrusted content is isolated from instructions, credentials, tool authority, and customer-facing output.
- [x] Source terms, robots, public-only collection, provenance, and LinkedIn exclusion are documented.
- [x] Connector revocation and incident procedures are documented.
- [x] Deletion, legal hold, backup/cache propagation, and verification procedures are documented.
- [x] Severity findings and pilot gates are recorded; no high-severity finding is approved for pilot.
- [ ] Deployment owner evidences production encryption, authorization, audit logging, retention/deletion execution, and connector revocation. This cannot be verified from the current checkout and remains a pre-pilot gate.

## Verification performed

The review was based on the current checkout and existing repository conventions, including:

- `lib/signals/contracts.ts`: strict schemas, source attribution, account-scoped observations/snapshots, bounded signal confidence/severity, and explicit run errors.
- `lib/signals/source-adapter.ts`: asynchronous window/cursor adapter boundary.
- `lib/signals/storage.ts`: schema validation, idempotent IDs, defensive copies, successful-run promotion, monotonic checkpoints, and explicit count pruning.
- `lib/signals/careers-source.ts`, `company-news-source.ts`, `project-source.ts`, and `usage-source.ts`: read-only client boundaries, bounded windows/pages, mapping checks, canonicalization, completeness/error handling, and minimized normalized records.
- `lib/signals/news-detector.ts` and its existing test: deterministic taxonomy and prompt-injection-like suppression.
- `agent/instructions.md`, `agent/subagents/d0-stats/instructions.md`, and `agent/channels/slack.ts`: customer-output boundary, specialist non-posting rule, no remote writes, required account context, and channel allowlist.
- `docs/issue-4-account-roster.md`, `docs/issue-5-data-sources.md`, and `docs/issue-6-source-strategy.md`: roster authority, source mapping, public/first-party collection, terms/robots, cadence, attribution, and retention expectations.

No runtime code or existing file was modified for this review.
