import { describe, expect, it } from "vitest"
import { redactedAccounts } from "./redacted-fixtures"
import {
  detectNewProjectSignals,
  detectNewProjects,
  type ProjectSourceRecord,
} from "./project-detector"
import { createInMemorySignalRepository } from "./storage"

const account = redactedAccounts[0]
const collectedAt = "2026-09-14T10:00:00.000Z"

function project(overrides: Partial<ProjectSourceRecord> = {}): ProjectSourceRecord {
  return {
    id: "prj_alpha",
    name: "Alpha",
    createdAt: "2026-09-14T09:00:00.000Z",
    url: "https://vercel.com/acme/alpha",
    ...overrides,
  }
}

describe("project detector", () => {
  it("uses first run as a baseline and emits no alert", () => {
    const result = detectNewProjects({ account, currentProjects: [project()], collectedAt })

    expect(result.baseline).toBe(true)
    expect(result.currentProjectIds).toEqual(["prj_alpha"])
    expect(result.newProjectIds).toEqual([])
    expect(result.signals).toEqual([])
  })

  it("diffs stable IDs and creates validated project evidence", () => {
    const result = detectNewProjectSignals({
      account,
      previousProjects: [project()],
      currentProjects: [
        project({ id: "prj_beta", name: "Beta", createdAt: "2026-09-14T09:30:00.000Z" }),
        project({ name: "Alpha renamed", url: "https://vercel.com/acme/renamed" }),
      ],
      collectedAt,
    })

    expect(result.newProjectIds).toEqual(["prj_beta"])
    expect(result.signals).toHaveLength(1)
    expect(result.signals[0]).toMatchObject({
      category: "new_project",
      title: "New project detected",
      source: { system: "vercel_projects", recordId: "prj_beta" },
      evidence: [
        {
          kind: "project_record",
          attributes: {
            projectId: "prj_beta",
            projectName: "Beta",
            creationTime: "2026-09-14T09:30:00.000Z",
          },
        },
      ],
    })
  })

  it("does not alert for restore, rename, or move when the stable ID is known", () => {
    const result = detectNewProjects({
      account,
      previousProjects: [],
      currentProjects: [project({ name: "Alpha after restore", url: null })],
      knownProjectIds: ["prj_alpha"],
      collectedAt,
    })

    expect(result.newProjectIds).toEqual([])
    expect(result.signals).toEqual([])
  })

  it("is idempotent with the repository and preserves the signal ID", () => {
    const repository = createInMemorySignalRepository()
    const input = {
      account,
      previousProjects: [],
      currentProjects: [project()],
      collectedAt,
      repository,
    }

    const first = detectNewProjects(input)
    const second = detectNewProjects(input)

    expect(first.signals[0].id).toBe(second.signals[0].id)
    expect(repository.listSignals({ accountId: account.id })).toHaveLength(1)
    expect(repository.getSignal(first.signals[0].id)).toEqual(first.signals[0])
  })

  it("rejects duplicate or empty project IDs", () => {
    expect(() =>
      detectNewProjects({
        account,
        previousProjects: [],
        currentProjects: [project(), project({ name: "Duplicate" })],
        collectedAt,
      }),
    ).toThrow("unique")

    expect(() =>
      detectNewProjects({
        account,
        previousProjects: [],
        currentProjects: [project({ id: " " })],
        collectedAt,
      }),
    ).toThrow("must not be empty")
  })
})
