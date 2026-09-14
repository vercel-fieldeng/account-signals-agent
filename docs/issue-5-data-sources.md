# Issue 5 — Project and consumption data sources

Status: source contract for implementation planning. This file is intentionally scoped to issue 5; it does not change the shared TypeScript contracts.

## Scope and current contract

The current contract already names the two relevant source systems:

- `vercel_projects`: project inventory and project lifecycle records.
- `vercel_usage`: consumption observations.

Both sources are represented through `SignalSourceAdapter.collect({ window, cursor })` and produce account-scoped snapshots. A normalized signal must retain the source reference, observation time, receipt time, evidence, and (for consumption) an explicit metric name, numeric value, unit, and previous value. `evidence.attributes` may carry source-specific fields, but it must not be used to hide the unit, time grain, or mapping status.

This document defines the intended source boundary. It does not claim that the connector, fields, or access described below have already been provisioned; items marked **to verify** must be confirmed during connector implementation or d0 discovery.

## Source definitions

### Project inventory (`vercel_projects`)

**System of record:** the Vercel project inventory connector, exposed to the signal pipeline as `vercel_projects`. The connector should return one record per project, including:

- stable project ID and team ID;
- project name (display only);
- account/team mapping status;
- environment or production indicator, when available;
- created/updated timestamps; and
- source collection timestamp.

The inventory is a point-in-time listing, not a consumption measure. A `new_project` observation is emitted only when a project ID is newly present relative to the prior successfully collected inventory for the same mapped team. A rename or metadata update is not a new project.

**Path:** `vercel_projects` adapter → project listing connector → account/team mapping filter → deterministic project-ID comparison → `project_record` evidence. The adapter must paginate with the `nextCursor` contract and record incomplete pagination as an error rather than treating the first page as the full inventory.

**To verify:** the concrete API/warehouse endpoint, required project fields, deletion semantics, pagination limit, and whether production status is available at inventory time. No endpoint URL or field name is asserted here because none is present in the current checkout.

### Consumption (`vercel_usage`)

**Canonical pilot metric:** production request quantity.

| Field | Definition |
| --- | --- |
| Metric name | `requests` (signal metric name: `weekly_requests` when the comparison window is weekly) |
| Unit | `requests` — count, not bytes, currency, or an entitlement |
| Source grain | one UTC calendar day per team/project/metric row |
| Aggregation | sum daily quantities over the requested UTC window; never sum across incompatible units or treat a stock level as additive |
| Growth comparison | current complete window versus the immediately preceding equal-length window |
| Missing data | unknown/incomplete, not zero; preserve source row counts and coverage dates |

**Preferred source/query path:** use `product.analytics.project_usage_metrics_daily` for project-level request quantities. Use `product.analytics.product_usage_team_sku_daily` when the approved feature mapping is team/SKU-grained or when the project-level source does not support the requested metric. These are source leads from the d0 specialist instructions, not proof of current availability; verify catalog definitions, field names, unit semantics, and duplicate/additive behavior in `DISCOVER` mode before approving a refresh query.

The query path is:

1. Resolve the Salesforce account to every verified Vercel team (never only the primary team).
2. In d0 `DISCOVER`, verify the source schema and the account/team mapping, then record the approved metric field, unit, identifiers, and UTC date column.
3. In `REFRESH`, execute the approved grouped query with only the verified team IDs and UTC start/end parameters changed.
4. Preserve team ID, project ID where available, metric/SKU ID, exact quantity, unit, source row count, coverage start/end, and freshness in the result.
5. Convert the grouped result into `vercel_usage` evidence and a `consumption_growth` observation. Leave threshold/event calculation to the deterministic caller.

A query template (field names are placeholders until discovery verifies them) is:

```sql
SELECT
  team_id,
  project_id,
  metric_id,
  usage_date,
  SUM(quantity) AS quantity,
  unit
FROM product.analytics.project_usage_metrics_daily
WHERE team_id IN (:verified_team_ids)
  AND usage_date >= :utc_start_date
  AND usage_date < :utc_end_date
GROUP BY team_id, project_id, metric_id, usage_date, unit
ORDER BY team_id, project_id, metric_id, usage_date;
```

Do not execute or approve this template until `DISCOVER` verifies the table, columns, units, and whether rows are additive. Revenue, fees, entitlements, and configuration are separate evidence types and must not be substituted for consumption quantity.

## Account → customer/team mapping

The mapping is two-stage and must be explicit in every retrieval:

1. **Salesforce account:** `account.sourceRecordId` is the verified Salesforce Account ID. The account record supplies the canonical account identity and owner context.
2. **Vercel customer/team:** a verified mapping resolves that Salesforce Account ID to one or more Vercel team IDs. Every mapped team is included; related Salesforce accounts and unverified teams are excluded.

The mapping artifact should retain `salesforceAccountId`, account name, `vercelTeamId`, mapping status, verification timestamp, and verification source. A domain match may help discovery, but it is not sufficient authorization for usage retrieval. If the mapping changes, use `DISCOVER` again and report mapping drift before changing a refresh query.

## Latency, access, and credentials

Known constraints from the current repository:

- The source adapter is asynchronous and windowed; collection may be paginated and may return a cursor.
- Every source reference records `collectedAt`; every observation records both `observedAt` and `receivedAt`.
- d0 retrieval may be asynchronous and must be polled to completion; expected and returned row counts, coverage dates, and freshness are required.
- A daily usage source is not assumed to be complete through the current UTC day. The caller must use the latest complete source date and expose the freshness boundary.
- No latency SLA or exact source lag is defined in this checkout. The implementation must measure/report observed lag rather than invent a fixed SLA.
- Access is account-scoped and read-only. Missing permissions, unavailable catalogs, failed mapping, and incomplete pagination are explicit source errors, not empty datasets.

Credentials and connectors are configuration concerns only:

- Salesforce access: the existing authenticated Salesforce connector, used to resolve the Account ID and account metadata.
- d0 access: the existing authenticated d0 capability, used for catalog discovery and approved usage queries.
- Project inventory access: the authenticated Vercel project connector represented by `vercel_projects` (**connector to verify**).
- Usage access: the authenticated d0/warehouse connector represented by `vercel_usage` (**source access to verify**).

Secrets, tokens, connection strings, raw customer IDs, and private URLs must never be committed to this repository. Runtime configuration should reference secret-manager/environment bindings; this document contains no credentials.

## Unmapped and incomplete behavior

- **No Salesforce mapping:** do not query project or usage data; emit a blocked/unmapped result with the Salesforce Account ID, reason, and required mapping action.
- **Partially mapped account:** process only verified teams, mark the result incomplete, and include expected versus returned team scope. Never present partial scope as complete.
- **Project without a mapped team:** retain it only in source diagnostics if needed; do not attach it to an account and do not emit a customer signal.
- **Usage row without a mapped team/project:** exclude it from account evidence and report an unmapped row count. Do not convert it to zero or assign it by name/domain.
- **Missing daily usage row:** do not infer zero usage. Mark coverage incomplete unless the source explicitly provides a verified zero.
- **Metric/unit ambiguity or source drift:** block approval of the refresh query and return to `DISCOVER`; do not substitute a similarly named metric.
- **Permission or connector failure:** return a failed/partial run error with `retryable` set according to the failure, preserving any successful source snapshots.

## Redacted fixtures

These fixtures are deliberately small and contain no real identifiers. They illustrate the boundary data expected by the source adapters, not a claim that the placeholder table columns are already verified.

### New-project scenario

```json
{
  "scenario": "new-project",
  "salesforceAccountId": "sf_account_redacted_001",
  "vercelTeamId": "team_redacted_001",
  "mappingStatus": "verified",
  "inventory": {
    "source": "vercel_projects",
    "collectedAt": "2026-09-14T09:02:00.000Z",
    "previousProjectIds": ["prj_redacted_existing_001"],
    "currentProject": {
      "projectId": "prj_redacted_new_001",
      "teamId": "team_redacted_001",
      "name": "redacted-production-app",
      "environment": "production",
      "createdAt": "2026-09-13T16:30:00.000Z"
    },
    "expectedEvidence": {
      "kind": "project_record",
      "projectCountDelta": 1,
      "newProjectId": "prj_redacted_new_001"
    }
  }
}
```

### Consumption-growth scenario

```json
{
  "scenario": "consumption-growth",
  "salesforceAccountId": "sf_account_redacted_001",
  "verifiedTeamIds": ["team_redacted_001", "team_redacted_002"],
  "mappingStatus": "verified",
  "usage": {
    "source": "vercel_usage",
    "sourceTable": "product.analytics.project_usage_metrics_daily",
    "metric": "requests",
    "unit": "requests",
    "grain": "UTC day",
    "currentWindow": {
      "start": "2026-09-07",
      "endExclusive": "2026-09-14",
      "quantity": 142000
    },
    "previousWindow": {
      "start": "2026-08-31",
      "endExclusive": "2026-09-07",
      "quantity": 100000
    },
    "coverage": {
      "latestCompleteDate": "2026-09-13",
      "expectedRows": 14,
      "returnedRows": 14,
      "complete": true
    },
    "expectedEvidence": {
      "kind": "usage_metric",
      "currentValue": 142000,
      "previousValue": 100000,
      "unit": "requests"
    }
  }
}
```

The growth fixture is an example of source quantities and comparison windows. The `42%` narrative used elsewhere in the repository is derived presentation, not a source field; production code must calculate it only after complete, unit-compatible windows are verified.

## Assumptions requiring follow-up

1. `product.analytics.project_usage_metrics_daily` is the correct request-quantity source and its quantity field is additive; verify in d0 catalog discovery.
2. The project inventory connector can expose stable project/team IDs and paginate deterministically; verify connector/API behavior.
3. Salesforce-to-team mappings are available through the authenticated connector and can enumerate every verified team for an account.
4. The operational freshness budget is not yet defined. Until it is, report observed source lag and completeness on every run instead of applying an unverified SLA.
