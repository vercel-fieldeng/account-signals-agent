import { describe, expect, it } from "vitest"
import { accountSchema } from "./contracts"
import { normalizeAccountRoster, type AccountRosterSourceRow } from "./roster"
import { createAccountId, createOwnerId } from "./stable-id"

const redactedRoster: AccountRosterSourceRow[] = [
  {
    sourceRecordId: "sf_redacted_001",
    name: "  Northstar   Labs ",
    domains: "HTTPS://WWW.NORTHSTAR.EXAMPLE/",
    careersUrl: "https://northstar.example/careers#openings",
    linkedinCompanyUrl: "https://www.linkedin.com/company/northstar-example",
    ownerName: "Sam Maass",
    ownerRole: "SA",
  },
  {
    sourceRecordId: "sf_redacted_001",
    name: "Northstar Labs",
    domains: ["northstar.example", "www.northstar.example"],
    careersUrl: null,
    ownerName: "Stefan Nikolic",
    ownerRole: "AE",
  },
  {
    sourceRecordId: "sf_redacted_002",
    name: "Harbor Systems",
    domains: ["harbor.example"],
    careersUrl: "https://harbor.example/jobs",
    linkedinCompanyUrl: null,
    ownerName: "Sam Maass",
    ownerRole: null,
  },
]

describe("account roster adapter", () => {
  it("normalizes and validates rows, deduplicating shared accounts and retaining both owners", () => {
    const result = normalizeAccountRoster(redactedRoster)

    expect(result.warnings).toEqual([])
    expect(result.accounts).toHaveLength(2)
    expect(result.accounts[0]).toEqual({
      schemaVersion: 1,
      id: createAccountId("sf_redacted_001"),
      sourceRecordId: "sf_redacted_001",
      name: "Northstar Labs",
      domains: ["northstar.example"],
      careersUrl: "https://northstar.example/careers",
      linkedinCompanyUrl: "https://www.linkedin.com/company/northstar-example",
      owners: [
        {
          schemaVersion: 1,
          id: createOwnerId("solutions_architect", "sam maass"),
          name: "Sam Maass",
          role: "solutions_architect",
        },
        {
          schemaVersion: 1,
          id: createOwnerId("account_executive", "stefan nikolic"),
          name: "Stefan Nikolic",
          role: "account_executive",
        },
      ],
    })
    expect(result.accounts.every((account) => accountSchema.safeParse(account).success)).toBe(true)
  })

  it("returns valid accounts and structured warnings for bad and unmapped rows", () => {
    const result = normalizeAccountRoster([
      redactedRoster[0],
      {
        sourceRecordId: "sf_redacted_bad_domain",
        name: "Bad Domain Co",
        domains: ["not a domain", ""],
        ownerName: "Sam Maass",
        ownerRole: "solutions architect",
      },
      {
        sourceRecordId: "sf_redacted_unmapped",
        name: "Unmapped Co",
        domains: "unmapped.example",
        ownerName: "Unknown Owner",
        ownerRole: "",
      },
      {
        sourceRecordId: "sf_redacted_bad_url",
        name: "Bad URL Co",
        domains: "bad-url.example",
        careersUrl: "not a URL",
        ownerName: "Stefan Nikolic",
        ownerRole: "account executive",
      },
      {
        sourceRecordId: "",
        name: "No ID Co",
        domains: "no-id.example",
        ownerName: "Sam",
      },
    ])

    expect(result.accounts).toHaveLength(2)
    expect(result.accounts.map((account) => account.name)).toEqual([
      "Northstar Labs",
      "Bad URL Co",
    ])
    expect(result.warnings).toEqual([
      expect.objectContaining({
        rowIndex: 1,
        code: "invalid_domain",
        sourceRecordId: "sf_redacted_bad_domain",
      }),
      expect.objectContaining({
        rowIndex: 1,
        code: "missing_domain",
        sourceRecordId: "sf_redacted_bad_domain",
      }),
      expect.objectContaining({
        rowIndex: 2,
        code: "unmapped_owner",
        sourceRecordId: "sf_redacted_unmapped",
      }),
      expect.objectContaining({
        rowIndex: 3,
        code: "invalid_url",
        sourceRecordId: "sf_redacted_bad_url",
      }),
      expect.objectContaining({ rowIndex: 4, code: "missing_source_record_id" }),
    ])
  })

  it("uses source owner IDs so renames keep identity and same-name owners do not collide", () => {
    const first = normalizeAccountRoster([
      { ...redactedRoster[0], ownerName: "Sam Maass", sourceOwnerId: "owner-1" },
      { ...redactedRoster[0], ownerName: "Sam Maass", ownerRole: "SA", sourceOwnerId: "owner-2" },
    ])
    const renamed = normalizeAccountRoster([
      { ...redactedRoster[0], ownerName: "Samuel Maass", sourceOwnerId: "owner-1" },
      { ...redactedRoster[0], ownerName: "Sam Maass", sourceOwnerId: "owner-2" },
    ])

    expect(first.accounts[0].owners.map((owner) => owner.id)).toEqual([
      createOwnerId("solutions_architect", "owner-1"),
      createOwnerId("solutions_architect", "owner-2"),
    ])
    expect(renamed.accounts[0].owners.map((owner) => owner.id)).toEqual([
      createOwnerId("solutions_architect", "owner-1"),
      createOwnerId("solutions_architect", "owner-2"),
    ])
  })

  it("does not include row payloads in warnings", () => {
    const result = normalizeAccountRoster([
      {
        sourceRecordId: "sf_redacted_003",
        name: "Secret Customer Name",
        domains: "secret.example",
        ownerName: "Unmapped Person",
        ownerRole: "unknown",
      },
    ])

    expect(JSON.stringify(result.warnings)).not.toContain("Secret Customer Name")
    expect(JSON.stringify(result.warnings)).not.toContain("Unmapped Person")
  })
})
