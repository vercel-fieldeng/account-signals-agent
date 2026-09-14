import { z } from "zod"

export const SCHEMA_VERSION = 1 as const

export const schemaVersionSchema = z.literal(SCHEMA_VERSION)
export const timestampSchema = z.iso.datetime({ offset: true })
export const stableIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*_[a-f0-9]{32}$/, "Expected a deterministic stable ID")

export const ownerRoleSchema = z.enum(["solutions_architect", "account_executive"])

export const ownerSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: stableIdSchema,
    name: z.string().trim().min(1),
    role: ownerRoleSchema,
  })
  .strict()

export const accountSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: stableIdSchema,
    sourceRecordId: z.string().trim().min(1),
    name: z.string().trim().min(1),
    domains: z.array(z.string().trim().min(1)).min(1),
    careersUrl: z.url().nullable(),
    linkedinCompanyUrl: z.url().nullable(),
    owners: z.array(ownerSchema).min(1),
  })
  .strict()
  .superRefine((account, context) => {
    const normalizedDomains = account.domains.map((domain) => domain.toLowerCase())
    if (new Set(normalizedDomains).size !== normalizedDomains.length) {
      context.addIssue({
        code: "custom",
        path: ["domains"],
        message: "Account domains must be unique (case-insensitive)",
      })
    }

    const ownerIds = account.owners.map((owner) => owner.id)
    if (new Set(ownerIds).size !== ownerIds.length) {
      context.addIssue({
        code: "custom",
        path: ["owners"],
        message: "Account owners must be unique",
      })
    }
  })

export const sourceSystemSchema = z.enum([
  "salesforce",
  "vercel_projects",
  "vercel_usage",
  "careers_page",
  "ats_feed",
  "sitemap",
  "linkedin_api",
  "company_news",
  "manual",
])

export const sourceReferenceSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    system: sourceSystemSchema,
    recordId: z.string().trim().min(1),
    url: z.url().nullable(),
    collectedAt: timestampSchema,
  })
  .strict()

export const signalCategorySchema = z.enum([
  "new_project",
  "consumption_growth",
  "it_hiring",
  "it_company_news",
])

export const evidenceKindSchema = z.enum([
  "project_record",
  "usage_metric",
  "job_posting",
  "company_article",
  "company_post",
])

const evidenceAttributeSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
])

export const evidenceSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: stableIdSchema,
    kind: evidenceKindSchema,
    source: sourceReferenceSchema,
    capturedAt: timestampSchema,
    summary: z.string().trim().min(1),
    excerpt: z.string().trim().min(1).nullable(),
    attributes: z.record(z.string(), evidenceAttributeSchema),
  })
  .strict()

export const observationSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: stableIdSchema,
    accountId: stableIdSchema,
    category: signalCategorySchema,
    source: sourceReferenceSchema,
    observedAt: timestampSchema,
    receivedAt: timestampSchema,
    evidence: z.array(evidenceSchema).min(1),
  })
  .strict()
  .superRefine((observation, context) => {
    if (
      !observation.evidence.some(
        (item) => item.source.system === observation.source.system,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "At least one evidence item must match the observation source system",
      })
    }

    if (Date.parse(observation.receivedAt) < Date.parse(observation.observedAt)) {
      context.addIssue({
        code: "custom",
        path: ["receivedAt"],
        message: "Observation receipt must not precede observation time",
      })
    }
  })

export const snapshotSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: stableIdSchema,
    accountId: stableIdSchema,
    source: sourceReferenceSchema,
    windowStartedAt: timestampSchema,
    windowEndedAt: timestampSchema,
    capturedAt: timestampSchema,
    observations: z.array(observationSchema),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (Date.parse(snapshot.windowEndedAt) < Date.parse(snapshot.windowStartedAt)) {
      context.addIssue({
        code: "custom",
        path: ["windowEndedAt"],
        message: "Snapshot window end must not precede its start",
      })
    }

    snapshot.observations.forEach((observation, index) => {
      if (observation.accountId !== snapshot.accountId) {
        context.addIssue({
          code: "custom",
          path: ["observations", index, "accountId"],
          message: "Snapshot observations must belong to the snapshot account",
        })
      }

      if (observation.source.system !== snapshot.source.system) {
        context.addIssue({
          code: "custom",
          path: ["observations", index, "source", "system"],
          message: "Snapshot observations must use the snapshot source system",
        })
      }
    })
  })

export const signalSeveritySchema = z.enum(["info", "warning", "critical"])
export const signalDirectionSchema = z.enum(["expansion", "risk", "neutral"])

export const signalMetricSchema = z
  .object({
    name: z.string().trim().min(1),
    value: z.number().finite(),
    unit: z.string().trim().min(1),
    previousValue: z.number().finite().nullable(),
  })
  .strict()

export const signalSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: stableIdSchema,
    account: accountSchema,
    category: signalCategorySchema,
    source: sourceReferenceSchema,
    observedAt: timestampSchema,
    receivedAt: timestampSchema,
    title: z.string().trim().min(1),
    detail: z.string().trim().min(1),
    direction: signalDirectionSchema,
    severity: signalSeveritySchema,
    evidence: z.array(evidenceSchema).min(1),
    confidence: z.number().finite().min(0).max(1),
    metric: signalMetricSchema.nullable(),
  })
  .strict()
  .superRefine((signal, context) => {
    if (!signal.evidence.some((item) => item.source.system === signal.source.system)) {
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "At least one evidence item must match the signal source system",
      })
    }
  })

export const normalizedSignalSchema = signalSchema

export const accountSignalSummarySchema = z
  .object({
    account: accountSchema,
    asOf: timestampSchema,
    expansionScore: z.number().int().min(0).max(100),
    riskScore: z.number().int().min(0).max(100),
    latestSignalAt: timestampSchema,
    expansionSignals: z.array(signalSchema),
    riskSignals: z.array(signalSchema),
    neutralSignals: z.array(signalSchema),
  })
  .strict()

export const signalDigestSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    generatedAt: timestampSchema,
    windowStartedAt: timestampSchema,
    windowEndedAt: timestampSchema,
    accounts: z.array(accountSignalSummarySchema),
  })
  .strict()

export const runStatusSchema = z.enum(["succeeded", "partial", "failed"])

export const runErrorSchema = z
  .object({
    source: sourceSystemSchema.nullable(),
    code: z.string().trim().min(1),
    message: z.string().trim().min(1),
    retryable: z.boolean(),
  })
  .strict()

export const runResultSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    id: stableIdSchema,
    status: runStatusSchema,
    startedAt: timestampSchema,
    completedAt: timestampSchema,
    windowStartedAt: timestampSchema,
    windowEndedAt: timestampSchema,
    snapshots: z.array(snapshotSchema),
    signals: z.array(signalSchema),
    errors: z.array(runErrorSchema),
  })
  .strict()
  .superRefine((run, context) => {
    if (run.completedAt < run.startedAt) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "Run completion must not precede its start",
      })
    }

    if (run.windowEndedAt < run.windowStartedAt) {
      context.addIssue({
        code: "custom",
        path: ["windowEndedAt"],
        message: "Run window end must not precede its start",
      })
    }

    if (run.status === "succeeded" && run.errors.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["errors"],
        message: "Successful runs cannot contain errors",
      })
    }

    if (run.status === "failed" && run.errors.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["errors"],
        message: "Failed runs must contain at least one error",
      })
    }
  })

export type OwnerRole = z.infer<typeof ownerRoleSchema>
export type Owner = z.infer<typeof ownerSchema>
export type Account = z.infer<typeof accountSchema>
export type SourceSystem = z.infer<typeof sourceSystemSchema>
export type SourceReference = z.infer<typeof sourceReferenceSchema>
export type SignalSource = SourceSystem
export type SignalCategory = z.infer<typeof signalCategorySchema>
export type Evidence = z.infer<typeof evidenceSchema>
export type Observation = z.infer<typeof observationSchema>
export type Snapshot = z.infer<typeof snapshotSchema>
export type SignalSeverity = z.infer<typeof signalSeveritySchema>
export type SignalDirection = z.infer<typeof signalDirectionSchema>
export type Signal = z.infer<typeof signalSchema>
export type NormalizedSignal = Signal
export type AccountSignalSummary = z.infer<typeof accountSignalSummarySchema>
export type SignalDigest = z.infer<typeof signalDigestSchema>
export type RunStatus = z.infer<typeof runStatusSchema>
export type RunResult = z.infer<typeof runResultSchema>
