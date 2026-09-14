import {
  SCHEMA_VERSION,
  type Account,
  type NormalizedSignal,
  type Observation,
  type RunResult,
  type Snapshot,
} from "./contracts"
import {
  createAccountId,
  createEvidenceId,
  createObservationId,
  createOwnerId,
  createRunId,
  createSignalId,
  createSnapshotId,
} from "./stable-id"

const solutionsArchitect = {
  schemaVersion: SCHEMA_VERSION,
  id: createOwnerId("solutions_architect", "owner_redacted_sa"),
  name: "A. Rivera",
  role: "solutions_architect",
} as const

const accountExecutive = {
  schemaVersion: SCHEMA_VERSION,
  id: createOwnerId("account_executive", "owner_redacted_ae"),
  name: "M. Chen",
  role: "account_executive",
} as const

export const redactedAccounts = [
  {
    schemaVersion: SCHEMA_VERSION,
    id: createAccountId("sf_account_redacted_001"),
    sourceRecordId: "sf_account_redacted_001",
    name: "Northstar Labs",
    domains: ["northstar.example"],
    careersUrl: "https://northstar.example/careers",
    linkedinCompanyUrl: "https://www.linkedin.com/company/northstar-example",
    owners: [solutionsArchitect, accountExecutive],
  },
  {
    schemaVersion: SCHEMA_VERSION,
    id: createAccountId("sf_account_redacted_002"),
    sourceRecordId: "sf_account_redacted_002",
    name: "Harbor Systems",
    domains: ["harbor.example"],
    careersUrl: "https://harbor.example/jobs",
    linkedinCompanyUrl: "https://www.linkedin.com/company/harbor-example",
    owners: [solutionsArchitect, accountExecutive],
  },
] satisfies Account[]

const [northstarAccount, harborAccount] = redactedAccounts

function source(
  system:
    | "vercel_projects"
    | "vercel_usage"
    | "ats_feed"
    | "company_news",
  recordId: string,
  collectedAt: string,
  url: string | null,
) {
  return {
    schemaVersion: SCHEMA_VERSION,
    system,
    recordId,
    url,
    collectedAt,
  } as const
}

const newProjectObservedAt = "2026-09-13T16:30:00.000Z"
const consumptionObservedAt = "2026-09-14T08:00:00.000Z"
const hiringObservedAt = "2026-09-13T19:10:00.000Z"
const newsObservedAt = "2026-09-14T07:15:00.000Z"

const newProjectSource = source(
  "vercel_projects",
  "project_redacted_001",
  "2026-09-13T16:31:00.000Z",
  null,
)
const consumptionSource = source(
  "vercel_usage",
  "usage_redacted_002",
  "2026-09-14T08:02:00.000Z",
  null,
)
const hiringSource = source(
  "ats_feed",
  "job_redacted_003",
  "2026-09-13T19:12:00.000Z",
  "https://harbor.example/jobs/platform-engineer",
)
const newsSource = source(
  "company_news",
  "article_redacted_004",
  "2026-09-14T07:17:00.000Z",
  "https://harbor.example/news/infrastructure-update",
)

export const redactedSignals = [
  {
    schemaVersion: SCHEMA_VERSION,
    id: createSignalId(
      northstarAccount.id,
      "new_project",
      newProjectSource.system,
      newProjectSource.recordId,
      newProjectObservedAt,
    ),
    account: northstarAccount,
    category: "new_project",
    source: newProjectSource,
    observedAt: newProjectObservedAt,
    receivedAt: "2026-09-13T16:31:00.000Z",
    title: "New production project detected",
    detail: "A new production project appeared for the account.",
    direction: "expansion",
    severity: "warning",
    evidence: [
      {
        schemaVersion: SCHEMA_VERSION,
        id: createEvidenceId(
          newProjectSource.system,
          newProjectSource.recordId,
          newProjectObservedAt,
        ),
        kind: "project_record",
        source: newProjectSource,
        capturedAt: newProjectObservedAt,
        summary: "New production project created",
        excerpt: null,
        attributes: { environment: "production", projectCountDelta: 1 },
      },
    ],
    confidence: 0.99,
    metric: {
      name: "production_projects",
      value: 4,
      unit: "projects",
      previousValue: 3,
    },
  },
  {
    schemaVersion: SCHEMA_VERSION,
    id: createSignalId(
      northstarAccount.id,
      "consumption_growth",
      consumptionSource.system,
      consumptionSource.recordId,
      consumptionObservedAt,
    ),
    account: northstarAccount,
    category: "consumption_growth",
    source: consumptionSource,
    observedAt: consumptionObservedAt,
    receivedAt: "2026-09-14T08:02:00.000Z",
    title: "Production usage accelerated",
    detail: "Weekly production requests increased 42% over the prior period.",
    direction: "expansion",
    severity: "critical",
    evidence: [
      {
        schemaVersion: SCHEMA_VERSION,
        id: createEvidenceId(
          consumptionSource.system,
          consumptionSource.recordId,
          consumptionObservedAt,
        ),
        kind: "usage_metric",
        source: consumptionSource,
        capturedAt: consumptionObservedAt,
        summary: "Weekly requests increased from 100,000 to 142,000",
        excerpt: null,
        attributes: { currentValue: 142000, previousValue: 100000, unit: "requests" },
      },
    ],
    confidence: 0.98,
    metric: {
      name: "weekly_requests",
      value: 142000,
      unit: "requests",
      previousValue: 100000,
    },
  },
  {
    schemaVersion: SCHEMA_VERSION,
    id: createSignalId(
      harborAccount.id,
      "it_hiring",
      hiringSource.system,
      hiringSource.recordId,
      hiringObservedAt,
    ),
    account: harborAccount,
    category: "it_hiring",
    source: hiringSource,
    observedAt: hiringObservedAt,
    receivedAt: "2026-09-13T19:12:00.000Z",
    title: "Platform engineering role opened",
    detail: "The account published a new role for its infrastructure organization.",
    direction: "expansion",
    severity: "warning",
    evidence: [
      {
        schemaVersion: SCHEMA_VERSION,
        id: createEvidenceId(hiringSource.system, hiringSource.recordId, hiringObservedAt),
        kind: "job_posting",
        source: hiringSource,
        capturedAt: hiringObservedAt,
        summary: "New platform engineering role found in the approved ATS feed",
        excerpt: "Build and operate the company platform.",
        attributes: { department: "IT", location: "Remote" },
      },
    ],
    confidence: 0.91,
    metric: null,
  },
  {
    schemaVersion: SCHEMA_VERSION,
    id: createSignalId(
      harborAccount.id,
      "it_company_news",
      newsSource.system,
      newsSource.recordId,
      newsObservedAt,
    ),
    account: harborAccount,
    category: "it_company_news",
    source: newsSource,
    observedAt: newsObservedAt,
    receivedAt: "2026-09-14T07:17:00.000Z",
    title: "Infrastructure consolidation announced",
    detail: "A company article described a planned consolidation of infrastructure vendors.",
    direction: "risk",
    severity: "critical",
    evidence: [
      {
        schemaVersion: SCHEMA_VERSION,
        id: createEvidenceId(newsSource.system, newsSource.recordId, newsObservedAt),
        kind: "company_article",
        source: newsSource,
        capturedAt: newsObservedAt,
        summary: "Company-authored infrastructure update discovered by the news index",
        excerpt: "We are consolidating core infrastructure vendors.",
        attributes: { publisher: "Harbor Systems", attributed: true },
      },
    ],
    confidence: 0.84,
    metric: null,
  },
] satisfies NormalizedSignal[]

export const redactedObservations = redactedSignals.map(
  (signal): Observation => ({
    schemaVersion: SCHEMA_VERSION,
    id: createObservationId(
      signal.account.id,
      signal.source.system,
      signal.source.recordId,
      signal.observedAt,
    ),
    accountId: signal.account.id,
    category: signal.category,
    source: signal.source,
    observedAt: signal.observedAt,
    receivedAt: signal.receivedAt,
    evidence: signal.evidence,
  }),
)

const windowStartedAt = "2026-09-13T09:00:00.000Z"
const windowEndedAt = "2026-09-14T09:00:00.000Z"

export const redactedSnapshots = redactedObservations.map(
  (observation): Snapshot => ({
    schemaVersion: SCHEMA_VERSION,
    id: createSnapshotId(
      observation.accountId,
      observation.source.system,
      windowStartedAt,
      windowEndedAt,
    ),
    accountId: observation.accountId,
    source: observation.source,
    windowStartedAt,
    windowEndedAt,
    capturedAt: windowEndedAt,
    observations: [observation],
    nextCursor: null,
  }),
)

export const redactedRunResult = {
  schemaVersion: SCHEMA_VERSION,
  id: createRunId(windowStartedAt, windowEndedAt, "2026-09-14T09:00:01.000Z"),
  status: "succeeded",
  startedAt: "2026-09-14T09:00:01.000Z",
  completedAt: "2026-09-14T09:00:04.000Z",
  windowStartedAt,
  windowEndedAt,
  snapshots: redactedSnapshots,
  signals: redactedSignals,
  errors: [],
} satisfies RunResult
