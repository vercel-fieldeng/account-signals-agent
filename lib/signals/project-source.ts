import {
  SCHEMA_VERSION,
  observationSchema,
  snapshotSchema,
  type Account,
  type Observation,
  type Snapshot,
} from "./contracts"
import {
  createEvidenceId,
  createObservationId,
  createSnapshotId,
} from "./stable-id"

export type ProjectRecordInput = {
  projectId: string
  teamId: string
  name: string
  environment?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  url?: string | null
}

export type ProjectPage = {
  projects: readonly ProjectRecordInput[]
  nextCursor?: string | null
}

export type ProjectListRequest = {
  teamId: string
  cursor?: string
  limit: number
}

/** Read-only boundary for the project connector. The collector never mutates it. */
export interface ProjectInventoryClient {
  readonly listProjects: (request: ProjectListRequest) => Promise<ProjectPage>
}

export type ProjectAccountMapping = {
  account: Account
  teamIds: readonly string[]
  previousProjectIds?: readonly string[]
}

export type ProjectInventoryInput = {
  client: ProjectInventoryClient
  accounts: readonly ProjectAccountMapping[]
  collectedAt: string
  window: {
    startedAt: string
    endedAt: string
  }
  pageSize?: number
  maxPages?: number
  /** Maximum number of accounts collected concurrently. */
  concurrency?: number
  /** Minimum delay between injected client calls, useful for provider rate limits. */
  minRequestIntervalMs?: number
  sleep?: (milliseconds: number) => Promise<void>
}

export type UnmappedProject = {
  projectId: string
  teamId: string
  reason: "team_not_mapped" | "conflicting_project_team"
}

export type ProjectSourceError = {
  accountId: string
  code: "client_failure" | "incomplete_pagination" | "invalid_page"
  message: string
  retryable: boolean
}

export type ProjectAccountResult = {
  accountId: string
  status: "succeeded" | "partial"
  projectCount: number
  newProjectCount: number
  snapshot?: Snapshot
  error?: ProjectSourceError
}

export type ProjectInventoryResult = {
  snapshots: Snapshot[]
  accounts: ProjectAccountResult[]
  unmappedProjects: UnmappedProject[]
  errors: ProjectSourceError[]
}

const DEFAULT_PAGE_SIZE = 100
const DEFAULT_MAX_PAGES = 100

function requiredText(value: string, field: string) {
  const normalized = value.normalize("NFKC").trim()
  if (!normalized) throw new Error(`${field} must not be empty`)
  return normalized
}

function optionalText(value: string | null | undefined) {
  if (value === null || value === undefined) return null
  const normalized = value.normalize("NFKC").trim()
  return normalized || null
}

function validTimestamp(value: string, field: string) {
  if (Number.isNaN(Date.parse(value))) throw new Error(`${field} must be an ISO timestamp`)
  return value
}

function pageLimit(value: number | undefined, field: string, fallback: number) {
  const result = value ?? fallback
  if (!Number.isInteger(result) || result < 1) {
    throw new Error(`${field} must be a positive integer`)
  }
  return result
}

function normalizeProject(input: ProjectRecordInput): ProjectRecordInput {
  const createdAt = input.createdAt ? validTimestamp(input.createdAt, "createdAt") : null
  const updatedAt = input.updatedAt ? validTimestamp(input.updatedAt, "updatedAt") : null
  const url = optionalText(input.url)
  if (url !== null) {
    try {
      new URL(url)
    } catch {
      throw new Error("url must be a valid URL")
    }
  }
  return {
    projectId: requiredText(input.projectId, "projectId"),
    teamId: requiredText(input.teamId, "teamId"),
    name: requiredText(input.name, "name"),
    environment: optionalText(input.environment),
    createdAt,
    updatedAt,
    url,
  }
}

function sourceReference(project: ProjectRecordInput, collectedAt: string) {
  return {
    schemaVersion: SCHEMA_VERSION,
    system: "vercel_projects" as const,
    recordId: project.projectId,
    url: project.url ?? null,
    collectedAt,
  }
}

function projectObservation(
  accountId: string,
  project: ProjectRecordInput,
  collectedAt: string,
): Observation {
  const source = sourceReference(project, collectedAt)
  const observedAt = project.createdAt ?? project.updatedAt ?? collectedAt
  const evidence = {
    schemaVersion: SCHEMA_VERSION,
    id: createEvidenceId(source.system, project.projectId, observedAt),
    kind: "project_record" as const,
    source,
    capturedAt: collectedAt,
    summary: `Project ${project.name} was added to the inventory`,
    excerpt: null,
    attributes: {
      projectId: project.projectId,
      teamId: project.teamId,
      projectName: project.name,
      environment: project.environment,
    },
  }

  return observationSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    id: createObservationId(accountId, source.system, project.projectId, observedAt),
    accountId,
    category: "new_project",
    source,
    observedAt,
    receivedAt: collectedAt,
    evidence: [evidence],
  })
}

function projectSnapshot(
  accountId: string,
  observations: Observation[],
  window: ProjectInventoryInput["window"],
  collectedAt: string,
): Snapshot {
  return snapshotSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    id: createSnapshotId(accountId, "vercel_projects", window.startedAt, window.endedAt),
    accountId,
    source: {
      schemaVersion: SCHEMA_VERSION,
      system: "vercel_projects",
      recordId: accountId,
      url: null,
      collectedAt,
    },
    windowStartedAt: window.startedAt,
    windowEndedAt: window.endedAt,
    capturedAt: collectedAt,
    observations,
    nextCursor: null,
  })
}

function createRequestPacer(input: ProjectInventoryInput) {
  const minimumDelay = input.minRequestIntervalMs ?? 0
  if (!Number.isFinite(minimumDelay) || minimumDelay < 0) throw new Error("minRequestIntervalMs must be non-negative")
  const sleep = input.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  let availableAt = 0
  let chain = Promise.resolve()
  return async function pace() {
    if (minimumDelay === 0) return
    chain = chain.then(async () => {
      await sleep(Math.max(0, availableAt - Date.now()))
      availableAt = Date.now() + minimumDelay
    })
    await chain
  }
}

async function collectAccount(
  input: ProjectInventoryInput,
  mapping: ProjectAccountMapping,
  pageSize: number,
  maxPages: number,
  unmappedProjects: UnmappedProject[],
  pace: () => Promise<void>,
): Promise<ProjectAccountResult> {
  const accountId = mapping.account.id
  const projects = new Map<string, ProjectRecordInput>()
  const teamIds = [...new Set(mapping.teamIds.map((teamId) => teamId.trim()).filter(Boolean))].sort()

  try {
    for (const teamId of teamIds) {
      let cursor: string | undefined
      const seenCursors = new Set<string>()
      let pages = 0
      do {
        if (pages >= maxPages) {
          throw { code: "incomplete_pagination", message: `Pagination exceeded ${maxPages} pages`, retryable: true }
        }
        if (cursor && seenCursors.has(cursor)) {
          throw { code: "incomplete_pagination", message: "Pagination returned a repeated cursor", retryable: true }
        }
        if (cursor) seenCursors.add(cursor)

        await pace()
        const page = await input.client.listProjects({ teamId, ...(cursor ? { cursor } : {}), limit: pageSize })
        if (!page || !Array.isArray(page.projects)) {
          throw { code: "invalid_page", message: "Project client returned an invalid page", retryable: false }
        }
        pages += 1

        for (const rawProject of page.projects) {
          const project = normalizeProject(rawProject)
          if (project.teamId !== teamId || !teamIds.includes(project.teamId)) {
            unmappedProjects.push({ projectId: project.projectId, teamId: project.teamId, reason: "team_not_mapped" })
            continue
          }
          const existing = projects.get(project.projectId)
          if (existing && existing.teamId !== project.teamId) {
            unmappedProjects.push({ projectId: project.projectId, teamId: project.teamId, reason: "conflicting_project_team" })
            projects.delete(project.projectId)
            continue
          }
          projects.set(project.projectId, existing ?? project)
        }
        cursor = page.nextCursor === null || page.nextCursor === undefined ? undefined : requiredText(page.nextCursor, "nextCursor")
      } while (cursor)
    }

    const previous = new Set(mapping.previousProjectIds ?? [])
    const newProjects = [...projects.values()]
      .filter((project) => !previous.has(project.projectId))
      .sort((left, right) => left.projectId.localeCompare(right.projectId))
    const observations = newProjects.map((project) => projectObservation(accountId, project, input.collectedAt))
    const snapshot = projectSnapshot(accountId, observations, input.window, input.collectedAt)
    return { accountId, status: "succeeded", projectCount: projects.size, newProjectCount: newProjects.length, snapshot }
  } catch (error) {
    const sourceError: ProjectSourceError = {
      accountId,
      code: isProjectSourceError(error) ? error.code : "client_failure",
      message: error instanceof Error ? error.message : isProjectSourceError(error) ? error.message : "Project client failed",
      retryable: isProjectSourceError(error) ? error.retryable : true,
    }
    return { accountId, status: "partial", projectCount: projects.size, newProjectCount: 0, error: sourceError }
  }
}

function isProjectSourceError(value: unknown): value is Omit<ProjectSourceError, "accountId"> {
  return Boolean(value && typeof value === "object" && "code" in value && "message" in value && "retryable" in value)
}

/** Collects all mapped accounts without allowing one account failure to abort the run. */
export async function collectProjectInventory(input: ProjectInventoryInput): Promise<ProjectInventoryResult> {
  const pageSize = pageLimit(input.pageSize, "pageSize", DEFAULT_PAGE_SIZE)
  const maxPages = pageLimit(input.maxPages, "maxPages", DEFAULT_MAX_PAGES)
  validTimestamp(input.collectedAt, "collectedAt")
  validTimestamp(input.window.startedAt, "window.startedAt")
  validTimestamp(input.window.endedAt, "window.endedAt")
  if (Date.parse(input.window.endedAt) < Date.parse(input.window.startedAt)) throw new Error("window endedAt must not precede startedAt")

  const concurrency = pageLimit(input.concurrency, "concurrency", 4)
  const unmappedProjects: UnmappedProject[] = []
  const pace = createRequestPacer(input)
  const accounts: ProjectAccountResult[] = []
  let nextAccount = 0
  const worker = async () => {
    while (true) {
      const index = nextAccount++
      if (index >= input.accounts.length) return
      accounts[index] = await collectAccount(input, input.accounts[index], pageSize, maxPages, unmappedProjects, pace)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, input.accounts.length) }, worker))
  const errors = accounts.flatMap((account) => account.error ? [account.error] : [])
  return {
    snapshots: accounts.flatMap((account) => account.snapshot ? [account.snapshot] : []),
    accounts,
    unmappedProjects: unmappedProjects.sort((left, right) => left.projectId.localeCompare(right.projectId) || left.teamId.localeCompare(right.teamId)),
    errors,
  }
}
