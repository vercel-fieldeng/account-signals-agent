import { describe, expect, it } from "vitest"
import { observationSchema, snapshotSchema } from "./contracts"
import { redactedAccounts } from "./redacted-fixtures"
import {
  collectProjectInventory,
  type ProjectInventoryClient,
  type ProjectPage,
  type ProjectRecordInput,
} from "./project-source"

const collectedAt = "2026-09-14T09:00:00.000Z"
const window = {
  startedAt: "2026-09-13T00:00:00.000Z",
  endedAt: collectedAt,
}

const projects: ProjectRecordInput[] = [
  {
    projectId: "prj_redacted_001",
    teamId: "team_redacted_001",
    name: "redacted-production-app",
    environment: "production",
    createdAt: "2026-09-13T16:30:00.000Z",
  },
  {
    projectId: "prj_redacted_002",
    teamId: "team_redacted_001",
    name: "redacted-dashboard",
    environment: "preview",
    createdAt: "2026-09-13T17:30:00.000Z",
  },
]

function clientFor(pages: Record<string, ProjectPage[]>): ProjectInventoryClient {
  return {
    async listProjects({ teamId, cursor }) {
      const pageIndex = cursor ? Number(cursor) : 0
      const page = pages[teamId]?.[pageIndex]
      if (!page) throw new Error(`No fixture page for ${teamId}/${pageIndex}`)
      return page
    },
  }
}

function input(client: ProjectInventoryClient, overrides: Record<string, unknown> = {}) {
  return {
    client,
    accounts: [
      {
        account: redactedAccounts[0],
        teamIds: ["team_redacted_001"],
        previousProjectIds: [],
      },
    ],
    collectedAt,
    window,
    ...overrides,
  }
}

describe("project inventory source", () => {
  it("returns a valid empty snapshot for zero pages", async () => {
    const result = await collectProjectInventory(
      input(clientFor({ "team_redacted_001": [{ projects: [] }] })),
    )

    expect(result.errors).toEqual([])
    expect(result.unmappedProjects).toEqual([])
    expect(result.accounts[0]).toMatchObject({ status: "succeeded", projectCount: 0, newProjectCount: 0 })
    expect(result.snapshots[0].observations).toEqual([])
    expect(snapshotSchema.safeParse(result.snapshots[0]).success).toBe(true)
  })

  it("normalizes one page and excludes projects already in the previous inventory", async () => {
    const result = await collectProjectInventory(
      input(clientFor({ "team_redacted_001": [{ projects }] }), {
        accounts: [{
          account: redactedAccounts[0],
          teamIds: ["team_redacted_001"],
          previousProjectIds: ["prj_redacted_001"],
        }],
      }),
    )

    expect(result.accounts[0]).toMatchObject({ projectCount: 2, newProjectCount: 1 })
    expect(result.snapshots[0].observations.map(({ source }) => source.recordId)).toEqual([
      "prj_redacted_002",
    ])
    expect(observationSchema.safeParse(result.snapshots[0].observations[0]).success).toBe(true)
  })

  it("follows deterministic bounded pagination across many pages", async () => {
    const result = await collectProjectInventory(
      input(clientFor({
        "team_redacted_001": [
          { projects: [projects[1]], nextCursor: "1" },
          { projects: [projects[0]], nextCursor: "2" },
          { projects: [], nextCursor: null },
        ],
      }), { pageSize: 1, maxPages: 5 }),
    )

    expect(result.accounts[0]).toMatchObject({ status: "succeeded", projectCount: 2, newProjectCount: 2 })
    expect(result.snapshots[0].observations.map(({ source }) => source.recordId)).toEqual([
      "prj_redacted_001",
      "prj_redacted_002",
    ])
  })

  it("reports projects returned for an unmapped team without emitting an observation", async () => {
    const result = await collectProjectInventory(
      input(clientFor({
        "team_redacted_001": [{
          projects: [projects[0], { ...projects[1], teamId: "team_unmapped_999" }],
        }],
      })),
    )

    expect(result.unmappedProjects).toEqual([{
      projectId: "prj_redacted_002",
      teamId: "team_unmapped_999",
      reason: "team_not_mapped",
    }])
    expect(result.snapshots[0].observations.map(({ source }) => source.recordId)).toEqual([
      "prj_redacted_001",
    ])
  })

  it("isolates a failed account and records incomplete pagination", async () => {
    const result = await collectProjectInventory({
      client: {
        async listProjects({ teamId }) {
          if (teamId === "team_failed") throw new Error("fixture connector failure")
          return { projects: [projects[0]] }
        },
      },
      accounts: [
        { account: redactedAccounts[0], teamIds: ["team_failed"] },
        { account: redactedAccounts[1], teamIds: ["team_redacted_001"] },
      ],
      collectedAt,
      window,
    })

    expect(result.accounts.map(({ status }) => status)).toEqual(["partial", "succeeded"])
    expect(result.errors).toEqual([expect.objectContaining({
      accountId: redactedAccounts[0].id,
      code: "client_failure",
    })])
    expect(result.snapshots).toHaveLength(1)
  })

  it("bounds account concurrency and paces injected client calls", async () => {
    let active = 0
    let maximum = 0
    const sleeps: number[] = []
    const result = await collectProjectInventory({
      client: { async listProjects() { active += 1; maximum = Math.max(maximum, active); await Promise.resolve(); active -= 1; return { projects: [] } } },
      accounts: redactedAccounts.map((account, index) => ({ account, teamIds: [`team_${index}`] })),
      collectedAt, window, concurrency: 1, minRequestIntervalMs: 10, sleep: async (ms) => { sleeps.push(ms) },
    })
    expect(result.errors).toEqual([])
    expect(maximum).toBe(1)
    expect(sleeps).toHaveLength(2)
  })

  it("does not treat a page cap as a complete inventory", async () => {
    const result = await collectProjectInventory(
      input(clientFor({
        "team_redacted_001": [{ projects: [projects[0]], nextCursor: "1" }],
      }), { maxPages: 1 }),
    )

    expect(result.accounts[0]).toMatchObject({ status: "partial" })
    expect(result.errors[0]).toMatchObject({ code: "incomplete_pagination", retryable: true })
    expect(result.snapshots).toEqual([])
  })
})
