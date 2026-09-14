import { z } from "zod"

export const signalSourceSchema = z.enum([
  "salesforce",
  "billing",
  "usage",
  "support",
  "manual",
])

export const signalSeveritySchema = z.enum(["info", "warning", "critical"])
export const signalDirectionSchema = z.enum(["expansion", "risk", "neutral"])

export const normalizedSignalSchema = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1),
  accountName: z.string().min(1),
  ownerName: z.string().min(1).nullable(),
  source: signalSourceSchema,
  sourceRecordId: z.string().min(1),
  observedAt: z.iso.datetime(),
  receivedAt: z.iso.datetime(),
  title: z.string().min(1),
  detail: z.string().min(1),
  direction: signalDirectionSchema,
  severity: signalSeveritySchema,
  metric: z
    .object({
      name: z.string().min(1),
      value: z.number(),
      unit: z.string().min(1),
      previousValue: z.number().nullable(),
    })
    .nullable(),
  sourceUrl: z.url().nullable(),
})

export const accountSignalSummarySchema = z.object({
  accountId: z.string().min(1),
  accountName: z.string().min(1),
  ownerName: z.string().min(1).nullable(),
  asOf: z.iso.datetime(),
  expansionScore: z.number().int().min(0).max(100),
  riskScore: z.number().int().min(0).max(100),
  latestSignalAt: z.iso.datetime(),
  expansionSignals: z.array(normalizedSignalSchema),
  riskSignals: z.array(normalizedSignalSchema),
  neutralSignals: z.array(normalizedSignalSchema),
})

export const signalDigestSchema = z.object({
  generatedAt: z.iso.datetime(),
  windowStartedAt: z.iso.datetime(),
  windowEndedAt: z.iso.datetime(),
  accounts: z.array(accountSignalSummarySchema),
})

export type SignalSource = z.infer<typeof signalSourceSchema>
export type SignalSeverity = z.infer<typeof signalSeveritySchema>
export type SignalDirection = z.infer<typeof signalDirectionSchema>
export type NormalizedSignal = z.infer<typeof normalizedSignalSchema>
export type AccountSignalSummary = z.infer<typeof accountSignalSummarySchema>
export type SignalDigest = z.infer<typeof signalDigestSchema>
