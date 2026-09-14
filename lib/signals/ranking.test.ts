import { describe, expect, it } from "vitest"
import type { NormalizedSignal } from "./contracts"
import { createStableId } from "./stable-id"
import {
  createRankedSignalDigestInput,
  DEFAULT_RANKING_CONFIG,
  opportunityTheme,
  type RankingOptions,
  rankSignals,
} from "./ranking"

const account = {
  schemaVersion: 1 as const,
  id: createStableId("acct", "ranking-account"),
  sourceRecordId: "ranking-account",
  name: "Ranking Co",
  domains: ["ranking.example.com"],
  careersUrl: null,
  linkedinCompanyUrl: null,
  owners: [{
    schemaVersion: 1 as const,
    id: createStableId("owner", "sa", "ranking-account"),
    name: "A. Architect",
    role: "solutions_architect" as const,
  }],
}

function signal(input: Partial<NormalizedSignal> & Pick<NormalizedSignal, "id" | "category" | "observedAt" | "source">): NormalizedSignal {
  return {
    schemaVersion: 1,
    id: input.id,
    account,
    category: input.category,
    source: input.source,
    observedAt: input.observedAt,
    receivedAt: input.receivedAt ?? input.observedAt,
    title: input.title ?? "Signal",
    detail: input.detail ?? "A signal detail",
    direction: input.direction ?? "expansion",
    severity: input.severity ?? "warning",
    evidence: input.evidence ?? [{
      schemaVersion: 1,
      id: createStableId("evidence", input.id),
      kind: input.category === "it_hiring" ? "job_posting" : input.category === "new_project" ? "project_record" : input.category === "consumption_growth" ? "usage_metric" : "company_article",
      source: input.source,
      capturedAt: input.observedAt,
      summary: input.title ?? "Signal",
      excerpt: null,
      attributes: input.category === "it_hiring" ? { jobIdentity: "provider:role-1" } : {},
    }],
    confidence: input.confidence ?? 0.8,
    metric: input.metric ?? null,
  }
}

const source = (system: NormalizedSignal["source"]["system"], recordId: string) => ({
  schemaVersion: 1 as const,
  system,
  recordId,
  url: null,
  collectedAt: "2026-09-14T00:00:00.000Z",
})

const base = "2026-09-14T00:00:00.000Z"

describe("rankSignals", () => {
  it("groups themes and keeps deterministic ties", () => {
    const signals = [
      signal({ id: createStableId("signal", "a"), category: "new_project", observedAt: base, source: source("vercel_projects", "project-a") }),
      signal({ id: createStableId("signal", "b"), category: "it_hiring", observedAt: base, source: source("careers_page", "job-a") }),
    ]
    const result = rankSignals(signals, { asOf: base })
    expect(result[0].opportunities.map((item) => item.theme)).toEqual(["platform-adoption", "it-hiring"])
    expect(result[0].opportunities[0].score).toBe(result[0].opportunities[0].scoreBreakdown.total)
  })

  it("raises corroborated opportunities", () => {
    const one = signal({ id: createStableId("signal", "one"), category: "it_company_news", observedAt: base, source: source("company_news", "news-1"), title: "Cloud migration" })
    const two = signal({ id: createStableId("signal", "two"), category: "it_company_news", observedAt: base, source: source("linkedin_api", "news-2"), title: "Cloud migration" })
    const [result] = rankSignals([one, two], { asOf: base })
    expect(result.opportunities[0].corroboratingSourceSystems).toEqual(["company_news", "linkedin_api"])
    expect(result.opportunities[0].scoreBreakdown.corroboration).toBe(DEFAULT_RANKING_CONFIG.weights.corroboration)
  })

  it("deduplicates recurrence but records recurrence and material change", () => {
    const repeated = signal({ id: createStableId("signal", "repeat-1"), category: "consumption_growth", observedAt: base, source: source("vercel_usage", "requests"), metric: { name: "requests", value: 120, unit: "count", previousValue: 100 } })
    const same = signal({ ...repeated, id: createStableId("signal", "repeat-2"), observedAt: "2026-09-13T00:00:00.000Z" })
    const changed = signal({ ...repeated, id: createStableId("signal", "changed"), observedAt: "2026-09-14T01:00:00.000Z", metric: { name: "requests", value: 160, unit: "count", previousValue: 120 } })
    const [result] = rankSignals([repeated, same, changed], { asOf: base })
    const opportunity = result.opportunities[0]
    expect(opportunity.sourceSignals).toHaveLength(2)
    expect(opportunity.recurrenceCount).toBe(3)
    expect(opportunity.materialChangeCount).toBe(2)
    expect(opportunity.deduplicatedSignalIds).toHaveLength(3)
  })

  it("caps each account and explains omitted low-value opportunities", () => {
    const signals = ["new_project", "it_hiring", "it_company_news", "consumption_growth"].map((category, index) => signal({
      id: createStableId("signal", "cap", index),
      category: category as NormalizedSignal["category"],
      observedAt: base,
      source: source(category === "new_project" ? "vercel_projects" : category === "it_hiring" ? "careers_page" : category === "consumption_growth" ? "vercel_usage" : "company_news", `cap-${index}`),
      title: category === "it_company_news" ? "Cloud migration" : undefined,
    }))
    const [result] = rankSignals(signals, { asOf: base, config: { maxOpportunitiesPerAccount: 2 } })
    expect(result.opportunities).toHaveLength(2)
    expect(result.omittedOpportunityCount).toBe(2)
    expect(result.omittedOpportunityIds).toHaveLength(2)
    expect(result.omittedSignalCount).toBe(2)
  })

  it("rejects non-finite and negative merged ranking configuration values", () => {
    const item = signal({ id: createStableId("signal", "invalid-config"), category: "new_project", observedAt: base, source: source("vercel_projects", "invalid-config") })
    expect(() => rankSignals([item], { config: { weights: { magnitude: Number.NaN } } })).toThrow(/Invalid ranking configuration/)
    expect(() => rankSignals([item], { config: { recencyHalfLifeDays: Number.POSITIVE_INFINITY } })).toThrow(/Invalid ranking configuration/)
    expect(() => rankSignals([item], { config: { maxOpportunitiesPerAccount: -1 } })).toThrow(/Invalid ranking configuration/)
  })

  it("rejects unknown signal-type weight entries", () => {
    const item = signal({ id: createStableId("signal", "invalid-signal-type"), category: "new_project", observedAt: base, source: source("vercel_projects", "invalid-signal-type") })
    expect(() => rankSignals([item], {
      config: { weights: { signalType: { unknown_signal: 10 } } } as unknown as RankingOptions["config"],
    })).toThrow(/signal type/)
  })

  it("returns a typed digest input without changing the shared digest contract", () => {
    const item = signal({ id: createStableId("signal", "digest"), category: "new_project", observedAt: base, source: source("vercel_projects", "digest") })
    const digest = createRankedSignalDigestInput([item], base, base)
    expect(digest.accounts[0].opportunities[0].sourceSignalIds).toEqual([item.id])
    expect(opportunityTheme(item)).toBe("platform-adoption")
  })
})
