import {
  SCHEMA_VERSION,
  signalSchema,
  type Account,
  type Signal,
} from "./contracts"
import { createEvidenceId, createSignalId } from "./stable-id"
import type { SignalRepository } from "./storage"

/**
 * Narrow local boundary for issue #10's project source. The existing collector
 * returns snapshots and only immediate `previousProjectIds`; that is not enough
 * for this detector's historical restore handling. Its `ProjectRecordInput`
 * records can be mapped here (projectId -> id) without changing shared files.
 */
export type ProjectSourceRecord = {
  /** Stable Vercel project ID. Names, slugs, and team placement are mutable. */
  id: string
  name: string
  createdAt: string
  url?: string | null
  /** Optional source metadata is deliberately not part of identity. */
  updatedAt?: string
}

export type ProjectDetectorInput = {
  account: Account
  currentProjects: readonly ProjectSourceRecord[]
  /** The immediately preceding successful source result. */
  previousProjects?: readonly ProjectSourceRecord[]
  /** IDs seen in older successful results, used to recognize restores. */
  knownProjectIds?: readonly string[]
  /** Time at which the source result was collected. */
  collectedAt: string
  /** Optional explicit receive time; defaults to collectedAt. */
  receivedAt?: string
  /** Optional repository for idempotent writes. */
  repository?: SignalRepository
}

export type ProjectDetectorResult = {
  /** True when there was no prior successful project result. */
  baseline: boolean
  currentProjectIds: string[]
  newProjectIds: string[]
  signals: Signal[]
}

function assertTimestamp(value: string, field: string) {
  if (Number.isNaN(Date.parse(value))) throw new Error(`${field} must be an ISO timestamp`)
}

function validateProjects(projects: readonly ProjectSourceRecord[]) {
  const ids = projects.map((project) => project.id.trim())
  if (ids.some((id) => id.length === 0)) throw new Error("Project IDs must not be empty")
  if (new Set(ids).size !== ids.length) throw new Error("Project IDs must be unique")

  projects.forEach((project) => {
    if (project.name.trim().length === 0) throw new Error("Project names must not be empty")
    assertTimestamp(project.createdAt, `Project ${project.id} createdAt`)
    if (project.updatedAt !== undefined) {
      assertTimestamp(project.updatedAt, `Project ${project.id} updatedAt`)
    }
  })
}

function createProjectSignal(
  account: Account,
  project: ProjectSourceRecord,
  collectedAt: string,
  receivedAt: string,
  repository?: SignalRepository,
) {
  const observedAt = project.createdAt
  const source = {
    schemaVersion: SCHEMA_VERSION,
    system: "vercel_projects" as const,
    recordId: project.id,
    url: project.url ?? null,
    collectedAt,
  }
  const id = createSignalId(
    account.id,
    "new_project",
    source.system,
    project.id,
    observedAt,
  )

  const existing = repository?.getSignal(id)
  if (existing) return existing

  const evidence = {
    schemaVersion: SCHEMA_VERSION,
    id: createEvidenceId(source.system, project.id, observedAt),
    kind: "project_record" as const,
    source,
    capturedAt: observedAt,
    summary: `Project ${project.name.trim()} was created`,
    excerpt: null,
    attributes: {
      projectId: project.id,
      projectName: project.name.trim(),
      creationTime: project.createdAt,
      ...(project.url ? { url: project.url } : {}),
    },
  }

  const signal = signalSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    id,
    account,
    category: "new_project",
    source,
    observedAt,
    receivedAt,
    title: "New project detected",
    detail: `A new Vercel project, ${project.name.trim()}, was created for the account.`,
    direction: "expansion",
    severity: "warning",
    evidence: [evidence],
    confidence: 1,
    metric: {
      name: "projects",
      value: 1,
      unit: "project",
      previousValue: 0,
    },
  })

  if (repository) return repository.saveSignal(signal).value
  return signal
}

/**
 * Detects project IDs that are genuinely new to the account.
 *
 * An omitted previousProjects value is a first-run baseline: all current IDs
 * are returned as baseline state and no alert is emitted. knownProjectIds is
 * intentionally separate so a source can retain IDs across delete/restore and
 * team-move events. Name, URL, updatedAt, and ordering changes never alert.
 */
export function detectNewProjects(input: ProjectDetectorInput): ProjectDetectorResult {
  validateProjects(input.currentProjects)
  if (input.previousProjects) validateProjects(input.previousProjects)
  assertTimestamp(input.collectedAt, "collectedAt")
  const receivedAt = input.receivedAt ?? input.collectedAt
  assertTimestamp(receivedAt, "receivedAt")

  const current = [...input.currentProjects].sort((left, right) => left.id.localeCompare(right.id))
  const currentProjectIds = current.map((project) => project.id)
  const baseline = input.previousProjects === undefined && input.knownProjectIds === undefined
  if (baseline) {
    return { baseline: true, currentProjectIds, newProjectIds: [], signals: [] }
  }

  const previousIds = new Set([
    ...(input.previousProjects ?? []).map((project) => project.id),
    ...(input.knownProjectIds ?? []),
  ])
  const newProjects = current.filter((project) => !previousIds.has(project.id))
  const signals = newProjects.map((project) =>
    createProjectSignal(input.account, project, input.collectedAt, receivedAt, input.repository),
  )

  return {
    baseline: false,
    currentProjectIds,
    newProjectIds: newProjects.map((project) => project.id),
    signals,
  }
}

/** Alias emphasizing that the returned objects are contract-validated signals. */
export const detectNewProjectSignals = detectNewProjects
