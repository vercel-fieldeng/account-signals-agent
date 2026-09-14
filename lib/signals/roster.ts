import {
  SCHEMA_VERSION,
  accountSchema,
  type Account,
  type OwnerRole,
} from "./contracts"
import { createAccountId, createOwnerId } from "./stable-id"

/** The redacted shape expected from the authoritative Salesforce roster export. */
export type AccountRosterSourceRow = {
  sourceRecordId: string
  name: string
  domains: string | readonly string[]
  careersUrl?: string | null
  linkedinCompanyUrl?: string | null
  ownerName: string
  ownerRole?: string | null
  /** Stable source-system owner ID; preferred over the display name for identity. */
  sourceOwnerId?: string | null
}

export type RosterWarningCode =
  | "invalid_row"
  | "missing_source_record_id"
  | "missing_name"
  | "missing_domain"
  | "invalid_domain"
  | "invalid_url"
  | "unmapped_owner"
  | "conflicting_account_field"
  | "validation_failed"

export type RosterWarning = {
  rowIndex: number
  code: RosterWarningCode
  message: string
  sourceRecordId?: string
}

export type AccountRosterResult = {
  accounts: Account[]
  warnings: RosterWarning[]
}

type MutableAccount = {
  sourceRecordId: string
  name: string
  domains: string[]
  careersUrl: string | null
  linkedinCompanyUrl: string | null
  owners: Account["owners"]
  ambiguous: boolean
}

const ownerRoleAliases: Record<string, OwnerRole> = {
  ae: "account_executive",
  account_executive: "account_executive",
  "account executive": "account_executive",
  sa: "solutions_architect",
  solutions_architect: "solutions_architect",
  "solutions architect": "solutions_architect",
}

const namedOwners: Record<string, OwnerRole> = {
  "sam maass": "solutions_architect",
  "stefan nikolic": "account_executive",
}

function cleanText(value: unknown) {
  return typeof value === "string"
    ? value.normalize("NFKC").trim().replace(/\s+/g, " ")
    : ""
}

function normalizeDomain(value: unknown): string | null {
  const text = cleanText(value).toLowerCase()
  if (!text) return null

  const candidate = text.includes("://") ? text : `https://${text}`
  try {
    const url = new URL(candidate)
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      return null
    }
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "")
    return hostname && hostname.includes(".") ? hostname : null
  } catch {
    return null
  }
}

function normalizeUrl(value: unknown): string | null | "invalid" {
  if (value === null || value === undefined || cleanText(value) === "") return null
  const text = cleanText(value)
  try {
    const url = new URL(text)
    if (url.protocol !== "https:" && url.protocol !== "http:") return "invalid"
    url.hash = ""
    return url.toString()
  } catch {
    return "invalid"
  }
}

function resolveOwnerRole(value: unknown, ownerName: string, hasSourceOwnerId: boolean): OwnerRole | null {
  const namedRole = namedOwners[ownerName.toLowerCase()]
  const role = cleanText(value).toLowerCase().replace(/[\u2013\u2014]/g, "-")
  const normalizedRole = ownerRoleAliases[role]
  if (namedRole) return normalizedRole && normalizedRole !== namedRole ? null : namedRole
  // A source-owned row can safely use its authoritative role even when the
  // display name has changed or is not in the local compatibility map.
  return hasSourceOwnerId ? normalizedRole ?? null : null
}

function warning(
  rowIndex: number,
  code: RosterWarningCode,
  message: string,
  sourceRecordId?: string,
): RosterWarning {
  return { rowIndex, code, message, ...(sourceRecordId ? { sourceRecordId } : {}) }
}

/**
 * Converts Salesforce roster rows to validated accounts. One malformed row never
 * prevents valid rows from being returned.
 */
export function normalizeAccountRoster(
  rows: readonly AccountRosterSourceRow[],
): AccountRosterResult {
  const warnings: RosterWarning[] = []
  const grouped = new Map<string, MutableAccount>()

  rows.forEach((row, rowIndex) => {
    if (!row || typeof row !== "object") {
      warnings.push(warning(rowIndex, "invalid_row", "Roster row must be an object"))
      return
    }

    const sourceRecordId = cleanText(row.sourceRecordId)
    const name = cleanText(row.name)
    if (!sourceRecordId) {
      warnings.push(warning(rowIndex, "missing_source_record_id", "Roster row has no source record ID"))
      return
    }
    if (!name) {
      warnings.push(warning(rowIndex, "missing_name", "Roster row has no account name", sourceRecordId))
      return
    }

    const rawDomains = Array.isArray(row.domains) ? row.domains : [row.domains]
    const domains: string[] = []
    for (const rawDomain of rawDomains) {
      const domain = normalizeDomain(rawDomain)
      if (domain) {
        if (!domains.includes(domain)) domains.push(domain)
      } else if (cleanText(rawDomain)) {
        warnings.push(warning(rowIndex, "invalid_domain", "Roster row contains an invalid domain", sourceRecordId))
      }
    }
    if (domains.length === 0) {
      warnings.push(warning(rowIndex, "missing_domain", "Roster row has no valid domain", sourceRecordId))
      return
    }

    const ownerName = cleanText(row.ownerName)
    const sourceOwnerId = cleanText(row.sourceOwnerId)
    const ownerRole = resolveOwnerRole(row.ownerRole, ownerName, Boolean(sourceOwnerId))
    if (!ownerName || !ownerRole) {
      warnings.push(warning(rowIndex, "unmapped_owner", "Roster row owner is not mapped to a supported role", sourceRecordId))
      return
    }

    const normalizedCareersUrl = normalizeUrl(row.careersUrl)
    const normalizedLinkedInUrl = normalizeUrl(row.linkedinCompanyUrl)
    if (normalizedCareersUrl === "invalid") {
      warnings.push(warning(rowIndex, "invalid_url", "Roster row has an invalid careers URL", sourceRecordId))
    }
    if (normalizedLinkedInUrl === "invalid") {
      warnings.push(warning(rowIndex, "invalid_url", "Roster row has an invalid LinkedIn/company URL", sourceRecordId))
    }

    const account = grouped.get(sourceRecordId)
    const owner = {
      schemaVersion: SCHEMA_VERSION,
      // Keep the legacy name fallback for older exports, but never let a supplied
      // source ID be replaced by (or coupled to) a mutable display name.
      id: createOwnerId(ownerRole, sourceOwnerId || ownerName.toLowerCase()),
      name: ownerName,
      role: ownerRole,
    } as const

    if (!account) {
      grouped.set(sourceRecordId, {
        sourceRecordId,
        name,
        domains,
        careersUrl: normalizedCareersUrl === "invalid" ? null : normalizedCareersUrl,
        linkedinCompanyUrl:
          normalizedLinkedInUrl === "invalid" ? null : normalizedLinkedInUrl,
        owners: [owner],
        ambiguous: false,
      })
      return
    }

    if (account.name !== name) {
      account.ambiguous = true
      warnings.push(warning(rowIndex, "conflicting_account_field", "Shared account has conflicting names; account excluded", sourceRecordId))
    }
    for (const domain of domains) {
      if (!account.domains.includes(domain)) account.domains.push(domain)
    }
    if (normalizedCareersUrl !== "invalid" && account.careersUrl && normalizedCareersUrl && account.careersUrl !== normalizedCareersUrl) {
      account.ambiguous = true
      warnings.push(warning(rowIndex, "conflicting_account_field", "Shared account has conflicting careers URLs; account excluded", sourceRecordId))
    } else if (!account.careersUrl && normalizedCareersUrl !== "invalid") {
      account.careersUrl = normalizedCareersUrl
    }
    if (normalizedLinkedInUrl !== "invalid" && account.linkedinCompanyUrl && normalizedLinkedInUrl && account.linkedinCompanyUrl !== normalizedLinkedInUrl) {
      account.ambiguous = true
      warnings.push(warning(rowIndex, "conflicting_account_field", "Shared account has conflicting LinkedIn/company URLs; account excluded", sourceRecordId))
    } else if (!account.linkedinCompanyUrl && normalizedLinkedInUrl !== "invalid") {
      account.linkedinCompanyUrl = normalizedLinkedInUrl
    }
    if (!account.owners.some((existing) => existing.id === owner.id)) account.owners.push(owner)
  })

  const accounts: Account[] = []
  for (const account of grouped.values()) {
    if (account.ambiguous) continue

    const { ambiguous: _, ...accountFields } = account
    const parsed = accountSchema.safeParse({
      schemaVersion: SCHEMA_VERSION,
      id: createAccountId(account.sourceRecordId),
      ...accountFields,
    })
    if (parsed.success) accounts.push(parsed.data)
    else {
      warnings.push(
        warning(
          -1,
          "validation_failed",
          "Normalized account failed the shared account contract",
          account.sourceRecordId,
        ),
      )
    }
  }

  return { accounts, warnings }
}

export const normalizeRoster = normalizeAccountRoster
