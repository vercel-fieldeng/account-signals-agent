import { createHash } from "node:crypto"

const namespacePattern = /^[a-z][a-z0-9_]*$/

function normalizePart(part: string | number) {
  return String(part).normalize("NFKC").trim()
}

export function createStableId(
  namespace: string,
  ...identityParts: readonly (string | number)[]
) {
  if (!namespacePattern.test(namespace)) {
    throw new Error("Stable ID namespace must use lowercase letters, numbers, or underscores")
  }

  if (identityParts.length === 0) {
    throw new Error("Stable IDs require at least one identity part")
  }

  const normalizedParts = identityParts.map(normalizePart)
  if (normalizedParts.some((part) => part.length === 0)) {
    throw new Error("Stable ID identity parts cannot be empty")
  }

  const canonicalIdentity = normalizedParts
    .map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`)
    .join("|")
  const digest = createHash("sha256").update(canonicalIdentity).digest("hex").slice(0, 32)

  return `${namespace}_${digest}`
}

export function createAccountId(sourceRecordId: string) {
  return createStableId("acct", "salesforce", sourceRecordId)
}

export function createOwnerId(role: string, sourceRecordId: string) {
  return createStableId("owner", role, sourceRecordId)
}

export function createEvidenceId(
  sourceSystem: string,
  sourceRecordId: string,
  capturedAt: string,
) {
  return createStableId("evidence", sourceSystem, sourceRecordId, capturedAt)
}

export function createObservationId(
  accountId: string,
  sourceSystem: string,
  sourceRecordId: string,
  observedAt: string,
) {
  return createStableId(
    "observation",
    accountId,
    sourceSystem,
    sourceRecordId,
    observedAt,
  )
}

export function createSnapshotId(
  accountId: string,
  sourceSystem: string,
  windowStartedAt: string,
  windowEndedAt: string,
) {
  return createStableId(
    "snapshot",
    accountId,
    sourceSystem,
    windowStartedAt,
    windowEndedAt,
  )
}

export function createSignalId(
  accountId: string,
  category: string,
  sourceSystem: string,
  sourceRecordId: string,
  observedAt: string,
) {
  return createStableId(
    "signal",
    accountId,
    category,
    sourceSystem,
    sourceRecordId,
    observedAt,
  )
}

export function createRunId(
  windowStartedAt: string,
  windowEndedAt: string,
  startedAt: string,
) {
  return createStableId("run", windowStartedAt, windowEndedAt, startedAt)
}
