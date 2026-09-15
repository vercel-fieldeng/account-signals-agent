import { rankSignals } from "./ranking"
import type { RankedAccountOpportunities, RankedSignalDigestInput } from "./ranking"
import type {
  AccountSignalSummary,
  NormalizedSignal,
  RunResult,
  SignalDigest,
  SignalSeverity,
} from "./contracts"

/** Main Slack summaries stay below the evaluation target; extended evidence belongs in a thread. */
export const DAILY_DIGEST_MAX_CHARS = 1_800
export const SLACK_SECTION_MAX_CHARS = 1_800
export const SLACK_MAX_BLOCKS = 50
export const MAX_DAILY_DIGEST_ACCOUNTS = 3

const severityRank: Record<SignalSeverity, number> = {
  critical: 3,
  warning: 2,
  info: 1,
}

const categoryLabel: Record<NormalizedSignal["category"], string> = {
  new_project: "New project",
  consumption_growth: "Consumption growth",
  it_hiring: "IT hiring",
  it_company_news: "IT company news",
}

export type RankedOpportunity = {
  signal: NormalizedSignal
  rank: number
  score: number
  sourceUrl: string | null
  evidence: NormalizedSignal["evidence"][number]
}

export type AccountCoverage = {
  covered: number
  total: number
}

export type DailyDigestSource = SignalDigest | RankedSignalDigestInput

export type DailyDigestInput = {
  digest: DailyDigestSource
  run?: Pick<RunResult, "status" | "errors">
  accountCoverage?: AccountCoverage
}

export type SlackDigestBlock =
  | { type: "header"; text: { type: "plain_text"; text: string } }
  | { type: "section"; text: { type: "mrkdwn"; text: string } }
  | { type: "context"; elements: Array<{ type: "mrkdwn"; text: string }> }

export type SlackDigestMessage = {
  text: string
  blocks: SlackDigestBlock[]
}

export type DailyDigestRender = {
  text: string
  slack: SlackDigestMessage
  opportunities: RankedOpportunity[]
  truncated: boolean
}

function inputOf(input: DailyDigestSource | DailyDigestInput): DailyDigestInput {
  return "digest" in input ? input : { digest: input }
}

function allSignals(summary: AccountSignalSummary): NormalizedSignal[] {
  return [
    ...summary.expansionSignals,
    ...summary.riskSignals,
    ...summary.neutralSignals,
  ]
}

function score(signal: NormalizedSignal): number {
  return severityRank[signal.severity] * 100 + Math.round(signal.confidence * 10)
}

function validSourceUrl(url: string | null | undefined): url is string {
  if (!url) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}

function sourceUrlFor(signal: NormalizedSignal): string | null {
  return [signal.source.url, ...signal.evidence.map((evidence) => evidence.source.url)].find(validSourceUrl) ?? null
}

function compareSignals(left: NormalizedSignal, right: NormalizedSignal): number {
  return (
    score(right) - score(left) ||
    right.observedAt.localeCompare(left.observedAt) ||
    left.account.name.localeCompare(right.account.name) ||
    left.id.localeCompare(right.id)
  )
}

function isRankedAccounts(
  accounts: SignalDigest["accounts"] | RankedAccountOpportunities[],
): accounts is RankedAccountOpportunities[] {
  return accounts.length > 0 && "opportunities" in accounts[0]
}

export function rankOpportunities(digest: DailyDigestSource): RankedOpportunity[] {
  const signals = isRankedAccounts(digest.accounts)
    ? digest.accounts.flatMap((account) =>
        account.opportunities.flatMap((opportunity) => opportunity.sourceSignals),
      )
    : rankSignals(
        digest.accounts.flatMap(allSignals),
        { asOf: digest.windowEndedAt },
      ).flatMap((account) =>
        account.opportunities.flatMap((opportunity) => opportunity.sourceSignals),
      )
  return signals
    .sort(compareSignals)
    .map((signal, index) => ({
      signal,
      rank: index + 1,
      score: score(signal),
      sourceUrl: sourceUrlFor(signal),
      evidence: signal.evidence[0],
    }))
}

export const rankDigestOpportunities = rankOpportunities

function dateOnly(timestamp: string): string {
  return timestamp.slice(0, 10)
}

function sourceText(url: string | null): string {
  return url ? `<${url}|source>` : "source URL unavailable"
}

function shorten(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

function statusText(input: DailyDigestInput): string {
  if (!input.run || input.run.status === "succeeded") return "Status: complete"
  if (input.run.status === "partial") {
    const count = input.run.errors.length
    return `Status: PARTIAL — ${count} source ${count === 1 ? "failure" : "failures"}`
  }
  return `Status: FAILED — ${input.run.errors.length} source ${
    input.run.errors.length === 1 ? "failure" : "failures"
  }`
}

function coverageText(input: DailyDigestInput, opportunities: RankedOpportunity[]): string {
  const covered = input.accountCoverage?.covered ?? new Set(
    opportunities.map(({ signal }) => signal.account.id),
  ).size
  const total = input.accountCoverage?.total ?? covered
  return `Account coverage: ${covered}/${total}`
}

function opportunityLines(opportunity: RankedOpportunity, displayRank: number): string[] {
  const { signal, evidence } = opportunity
  return [
    `${displayRank}. *${signal.account.name}* — ${categoryLabel[signal.category]} (${signal.severity})`,
    `Why: ${shorten(signal.title, 180)} — ${shorten(signal.detail, 360)}`,
    `Evidence: ${shorten(evidence.summary, 260)}${evidence.excerpt ? ` — “${shorten(evidence.excerpt, 180)}”` : ""}`,
    `Observed: ${dateOnly(signal.observedAt)} · ${sourceText(opportunity.sourceUrl)}`,
  ]
}

function renderOpportunity(opportunity: RankedOpportunity, displayRank: number): string {
  return opportunityLines(opportunity, displayRank).join("\n")
}

/** Keep one primary finding per account so the visible ranking is contiguous and account-distinct. */
function primaryAccountOpportunities(opportunities: RankedOpportunity[]): RankedOpportunity[] {
  const seen = new Set<string>()
  const selected: RankedOpportunity[] = []
  for (const opportunity of opportunities) {
    const accountId = opportunity.signal.account.id
    if (seen.has(accountId)) continue
    seen.add(accountId)
    selected.push(opportunity)
    if (selected.length === MAX_DAILY_DIGEST_ACCOUNTS) break
  }
  return selected
}

function unsupportedSection(count: number): string {
  return `Unsupported signals — source URL unavailable: ${count} signal${count === 1 ? "" : "s"} omitted from opportunities.`
}

function headerLines(input: DailyDigestInput, opportunities: RankedOpportunity[]): string[] {
  return [
    `*Daily account signals — ${dateOnly(input.digest.generatedAt)}*`,
    `${coverageText(input, opportunities)} · ${statusText(input)}`,
  ]
}

function boundedText(
  input: DailyDigestInput,
  opportunities: RankedOpportunity[],
  maxChars: number,
): { text: string; truncated: boolean } {
  const header = headerLines(input, opportunities).join("\n")
  const supported = opportunities.filter((opportunity) => opportunity.sourceUrl !== null)
  const unsupportedCount = opportunities.length - supported.length
  if (supported.length === 0 && unsupportedCount === 0) {
    return { text: `${header}\n\nNo new account signals today. Coverage is healthy.`, truncated: false }
  }

  const selected = primaryAccountOpportunities(supported)
  const omittedSupported = supported.length - selected.length
  const sections: string[] = [header]
  const renderableSections = [
    ...selected.map((opportunity, index) => renderOpportunity(opportunity, index + 1)),
    ...(omittedSupported > 0 ? [`Additional evidence omitted from the main summary: ${omittedSupported} signal${omittedSupported === 1 ? "" : "s"}.`] : []),
    ...(unsupportedCount > 0 ? [unsupportedSection(unsupportedCount)] : []),
  ]
  let truncated = omittedSupported > 0
  for (const section of renderableSections) {
    const candidate = `${sections.join("\n\n")}\n\n${section}`
    if (candidate.length > maxChars) {
      truncated = true
      break
    }
    sections.push(section)
  }
  if (sections.length < renderableSections.length + 1) {
    truncated = true
  }
  if (truncated) {
    const marker = "\n\n… additional signals truncated for Slack size limits."
    while (`${sections.join("\n\n")}${marker}`.length > maxChars && sections.length > 1) {
      sections.pop()
    }
    return { text: `${sections.join("\n\n")}${marker}`, truncated: true }
  }
  return { text: sections.join("\n\n"), truncated: false }
}

function slackBlocks(text: string): SlackDigestBlock[] {
  const lines = text.split("\n")
  const first = lines.shift() ?? "Daily account signals"
  const metadata = lines.shift()
  const sections = lines.join("\n").split("\n\n").filter(Boolean)
  const blocks: SlackDigestBlock[] = [
    { type: "header", text: { type: "plain_text", text: first.replaceAll("*", "") } },
  ]
  if (metadata) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: metadata }] })
  }
  for (const section of sections) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: shorten(section, SLACK_SECTION_MAX_CHARS) },
    })
  }
  return blocks.slice(0, SLACK_MAX_BLOCKS)
}

export function renderDailyDigest(
  input: SignalDigest | DailyDigestInput,
  options: { maxChars?: number } = {},
): DailyDigestRender {
  const normalizedInput = inputOf(input)
  const opportunities = rankOpportunities(normalizedInput.digest)
  const rendered = boundedText(
    normalizedInput,
    opportunities,
    options.maxChars ?? DAILY_DIGEST_MAX_CHARS,
  )
  return {
    text: rendered.text,
    slack: { text: rendered.text, blocks: slackBlocks(rendered.text) },
    opportunities,
    truncated: rendered.truncated,
  }
}

export const renderSignalDigest = renderDailyDigest
