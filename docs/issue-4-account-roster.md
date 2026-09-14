# Issue 4: Account roster source and ownership rules

## Purpose

This document defines the input roster for account-signal collection. It does not change the shared signal contracts, add a Salesforce adapter, or authorize access to any customer record.

## Authoritative source and access path

- **System of record:** the Salesforce **Account** record.
- **Authoritative record key:** Salesforce Account `Id` (the value represented as `sourceRecordId` in the shared `Account` contract).
- **Access path:** use the repository's authorized Salesforce access path to resolve and read the Account record before collecting signals. The caller must verify the Salesforce Account ID and account name before passing the account to downstream work. This matches the existing agent instructions, which require a verified Salesforce Account ID and name before d0 delegation.
- **Not authoritative:** Vercel projects, Vercel usage, careers pages, ATS feeds, LinkedIn, company news, and manually supplied names/domains may enrich an account or provide signal evidence, but they do not create, rename, merge, or select roster accounts.
- **No fallback:** if the Salesforce Account record cannot be read or its identity cannot be verified, do not substitute a website, domain, project, or display name as the roster key.

The current shared contracts do not define a Salesforce client or query. This policy therefore defines the source and access boundary without assuming a connector implementation or Salesforce field API names beyond the Account `Id` and the verified account name.

## Stable account identity

For each included Salesforce Account:

```text
account.sourceRecordId = Salesforce Account.Id
account.id = createAccountId(account.sourceRecordId)
        = createStableId("acct", "salesforce", account.sourceRecordId)
```

The stable ID is deterministic and must not be based on account name, website, owner, or domain. A Salesforce rename, domain change, or ownership change preserves `account.id` as long as the Salesforce Account `Id` is unchanged. A different Salesforce Account `Id` is a different account, even if the names or domains match.

## Required roster fields

The source-to-contract mapping must provide, or explicitly represent as unavailable where the shared contract permits it:

| Field | Requirement | Contract representation |
| --- | --- | --- |
| Salesforce Account ID | Required, non-empty, verified | `sourceRecordId`; used to derive `id` |
| Account name | Required, non-empty, verified against Salesforce | `name` |
| Company domains | At least one non-empty domain; normalize for comparison and reject case-insensitive duplicates | `domains` |
| Careers URL | URL or unavailable | `careersUrl` (`null` when unavailable) |
| LinkedIn company URL | URL or unavailable | `linkedinCompanyUrl` (`null` when unavailable) |
| Matched owner(s) | At least one included owner; each has a stable owner ID, name, and supported role | `owners` |
| Schema version | Current shared schema version | `schemaVersion` |

The shared `accountSchema` is the final validation boundary. Unknown account fields must not be added to the shared object, and missing optional enrichment must be represented as `null`, not as guessed values.

## Ownership and union semantics

The roster is the **union** of two Salesforce ownership views:

1. Accounts assigned to **Sam Maass**, whose role is `solutions_architect`.
2. Accounts assigned to **Stefan Nikolic**, whose role is `account_executive`.

Operational rules:

- Include an account when it appears in either view (`SA ∪ AE`), not only when it appears in both (`SA ∩ AE`).
- Deduplicate the union by Salesforce Account `Id`.
- If an account appears in both views, emit one account with both matched owners; never emit duplicate account rows or duplicate owner IDs.
- If an account appears in only one view, emit it once with that matched owner. Do not invent the other owner.
- Owner display names are not identity keys. Owner IDs must be stable for the owner-role/source identity and must remain unique within an account.
- Ownership is evaluated from the current authoritative Salesforce assignment at roster collection time; signal evidence sources cannot add an owner.

The existing owner role vocabulary is limited to `solutions_architect` and `account_executive`. Sam and Stefan are the named roster selectors for those respective roles; this document does not imply that every person with either role is included.

## Inclusion and exclusion

### Include

Include an account only when all of the following are true:

- Its Salesforce Account record was read through the authorized Salesforce path.
- Its Salesforce Account `Id` and name were verified.
- Its current owner assignment matches Sam Maass as the solutions architect selector or Stefan Nikolic as the account executive selector.
- The account can satisfy the shared account contract, including at least one valid domain and at least one matched owner.

### Exclude

Exclude an account from this roster when:

- it is not in either selected Salesforce owner view;
- it is a contact, lead, opportunity, project, team, domain, or other non-Account record;
- it is found only through a downstream signal source or an unverified manual list;
- it has no usable Salesforce Account `Id`, no verified name, or no valid domain for the shared contract; or
- it is a duplicate representation of an Account `Id` already emitted.

Exclusion from this roster is not a claim that the customer does not exist or has no signals. It means the account is outside this run's authoritative selection.

## Changes, missing records, and duplicates

- **Ownership changes:** on the next roster refresh, add an account that newly matches either selected owner and remove an account that no longer matches either. Preserve its stable account ID across ownership changes when the Salesforce Account `Id` is unchanged. Do not rewrite historical signal IDs merely because ownership changed.
- **Missing Salesforce record or access failure:** do not silently emit a partial account from cached names, domains, or downstream evidence. Mark the roster/run as incomplete or blocked through the existing run error/status path, with the Salesforce source and a non-secret diagnostic. Never convert missing data into an empty or disabled account.
- **Missing optional field:** retain the account and use `null` for `careersUrl` or `linkedinCompanyUrl`; do not fabricate URLs. A missing required field fails that account's contract validation and excludes it from the emitted roster for that run.
- **Duplicate Account IDs:** collapse exact duplicate source rows into one account after validating that their required identity and owner data agree. If duplicate rows for the same Salesforce Account `Id` disagree on name, ownership, or other required identity data, do not choose silently: exclude the ambiguous account from the emitted roster and record a non-secret data-quality error for review.
- **Name/domain collisions across different Account IDs:** keep separate accounts. The Salesforce Account `Id`, not the name or domain, controls identity.

## Redacted fixture expectations

Any fixture added for this policy must be synthetic and safe to commit:

- Use clearly redacted IDs such as `sf_account_redacted_001` and non-customer example domains such as `example` domains.
- Use synthetic owner names or the requested role labels only; never include real customer names, emails, Salesforce URLs, access tokens, query exports, or copied CRM fields.
- Exercise the union cases: SA-only, AE-only, and the same Account ID matched by both owners.
- Assert that the union is deduplicated by `sourceRecordId`, that `account.id` is derived from Salesforce identity, and that optional URLs may be `null`.
- Keep any typed sample in an issue-4-specific file under `docs/` (or another new issue-4-specific path); do not modify `lib/signals/contracts.ts` or shared fixtures to support the sample.

No typed fixture is added by this issue because the existing shared redacted fixtures already validate the account shape, stable account ID derivation, both supported owner roles, and contract parsing. The policy above is intentionally documentation-only until a roster adapter and its source-specific tests are introduced.
