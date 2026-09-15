# Morning account change monitor

## Agreed outcome

Every day at **08:00 Europe/Berlin**, including daylight-saving changes, post one evidence-backed change digest to the existing Account Signals Slack channel (`C0C1GJNPV0V`). Cover the union of Sam Maass's SA accounts and Stefan Nikolic's AE accounts, deduplicated by verified Salesforce Account ID.

This is **not a generic account briefing**. The required signal families are:

1. Material changes in consumption, with comparable complete periods, units, baseline values, and source freshness.
2. Changes in Vercel product adoption, verified through the appropriate usage/configuration evidence. Do not substitute project creation, billing line-item appearance, entitlement, or missing records for adoption.
3. New or materially changed Tech/IT job postings, with source links; suppress removals/reposts as new-hiring alerts.
4. New, attributable, potentially Vercel-relevant public-web news discovered through Exa. Scope searches to the account’s public domains and bounded publication windows; validate the canonical first-party page before emitting a company-news signal. Do not treat Exa snippets or search metadata as evidence.

The first successful observation establishes a baseline rather than announcing historical records as new. Source failures must leave the last successful baseline intact. Missing coverage is not zero usage or a healthy no-change day. Repeated observations and delivery retries must not create repeated alerts.

## Authorization

Slack delivery uses the application's existing bot grant. Salesforce and d0 currently support user-subject OAuth with refresh enabled. Eve supports a handler-form schedule dispatched as a previously authenticated user, but the schedule owner must be bound from a verified channel/session auth context, not a prompt-supplied ID. Save identity metadata, not credentials. Reuse the same principal ID and issuer across runs.

A missing/revoked grant must fail explicitly and request operator repair rather than repeatedly attempting sign-in during each morning job. Do not change the existing connectors to unsupported app authentication.

Production traces showed d0 subagent OAuth event forwarding failing with `HookNotFoundError`, followed by `ConnectionAuthorizationFailedError`. The root agent now owns d0 connection calls to avoid that child-to-parent authorization handoff. This mitigation requires a fresh production authorization test; local compilation is not proof of a usable saved grant.

## Persistent state

A dedicated **private Vercel Blob** store was provisioned in Frankfurt (`fra1`) for this project, attached to production and development using OIDC, without a static read-write token. Preview is deliberately not attached to production state.

`lib/signals/blob-storage.ts` provides private, uncached reads and ETag-conditional transactions around the shared repository. Callbacks must be synchronous and free of external side effects. It stores a bounded versioned state document; malformed state and write conflicts fail without overwriting newer state. The JSON filesystem adapter is for local use, not durable serverless storage.

Retention is currently count-bounded; time-based retention/deletion and account offboarding must be implemented before storing routine customer history.

## Enablement gates — not yet an enabled schedule

- [ ] Verify one successful d0 request and saved-grant reuse under the intended schedule owner.
- [ ] Bind the automation owner from a verified session and implement pause/revocation handling.
- [ ] Resolve the authoritative SA/AE roster and all verified account-to-team mappings.
- [ ] Integrate actual consumption and product-adoption inputs with deterministic comparisons; schema/query leads in older source documents are not verified production contracts.
- [ ] Configure approved careers/ATS endpoints and collection-policy enforcement per account.
- [ ] Configure and validate Exa search credentials, account-domain scoping, attribution, and coverage limitations.
- [ ] Connect live collectors and detectors to Blob-backed state and a durable delivery ledger.
- [ ] Implement time-based retention and deletion of linked records.
- [ ] Register the DST-correct 08:00 schedule, verify it in Vercel, and run a real end-to-end baseline/delta/retry test before enabling unattended delivery.

Do not enable a synthetic or generic morning briefing as a substitute for these requirements.
