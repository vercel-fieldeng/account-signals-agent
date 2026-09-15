import type {
  CareerChange,
  CareerJob,
  CareersCacheEntry,
  CareersHttpClient,
  CareersSourceResult,
} from "./careers-source"
import { collectCareers } from "./careers-source"
import type {
  CompanyNewsClient,
  CompanyNewsCollectionResult,
} from "./company-news-source"
import { collectCompanyNews } from "./company-news-source"
import type { Account } from "./contracts"
import { classifyJob } from "./job-detector"
import { createExaCompanyNewsClient, type ExaHttpClient } from "./exa-news-client"

const MAX_ITEMS_PER_ACCOUNT = 10
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000
const DEFAULT_TIMEOUT_MS = 10_000

export type ExternalSourceWindow = {
  startedAt: string
  endedAt: string
}

export type ExternalSourceCollectionInput = {
  accounts: readonly Account[]
  window: ExternalSourceWindow
}

export type ExternalSourceItem = {
  title: string
  department: string | null
  location: string | null
  url: string
  observedAt: string
  postedAt: string | null
  change: "added" | "changed" | "removed"
  relevant: boolean
  relevanceRationale: string
  firstObserved: boolean
}

export type ExternalNewsItem = {
  title: string
  url: string
  excerpt: string
  author: string
  publishedAt: string
  kind: "article" | "post"
}

export type ExternalSourceAccountResult = {
  accountName: string
  status: "succeeded" | "partial" | "unsupported" | "unavailable" | "failed"
  currentCount: number
  relevantCount: number
  changedCount: number
  baselineAvailable: boolean
  items: ExternalSourceItem[]
  error?: { code: string; message: string; retryable: boolean }
}

export type ExternalNewsAccountResult = {
  accountName: string
  status: "succeeded" | "partial" | "unavailable" | "failed"
  articleCount: number
  items: ExternalNewsItem[]
  error?: { code: string; message: string; retryable: boolean }
}

export type ExternalSourceCollectionResult = {
  status: "succeeded" | "partial" | "unavailable"
  window: ExternalSourceWindow & { collectedAt: string }
  careers: {
    status: "succeeded" | "partial" | "unavailable"
    accounts: ExternalSourceAccountResult[]
  }
  companyNews: {
    status: "succeeded" | "partial" | "unavailable"
    accounts: ExternalNewsAccountResult[]
  }
  limitations: string[]
}

export type ExternalSourceCollectionOptions = {
  now?: () => string
  careersClient?: CareersHttpClient
  newsClient?: CompanyNewsClient
  careersCache?: Map<string, CareersCacheEntry>
  exaApiKey?: string
  enabled?: boolean
  checkRobots?: (url: string) => Promise<boolean> | boolean
  checkTerms?: (url: string) => Promise<boolean> | boolean
  signal?: AbortSignal
}

type PublicFetchOptions = {
  signal?: AbortSignal
  timeoutMs?: number
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "External source failed"
  return message.replace(/x-api-key|authorization|bearer\s+\S+/gi, "credential").slice(0, 300)
}

function accountNameById(accounts: readonly Account[]) {
  return new Map(accounts.map((account) => [account.id, account.name]))
}

function validateInput(input: ExternalSourceCollectionInput) {
  if (!Array.isArray(input.accounts) || input.accounts.length < 1) {
    throw new Error("External source collection requires at least one account")
  }
  const ids = new Set(input.accounts.map((account) => account.id))
  if (ids.size !== input.accounts.length) throw new Error("External source accounts must be unique")
  if (Number.isNaN(Date.parse(input.window.startedAt)) || Number.isNaN(Date.parse(input.window.endedAt))) {
    throw new Error("External source window must contain valid timestamps")
  }
  if (Date.parse(input.window.endedAt) < Date.parse(input.window.startedAt)) {
    throw new Error("External source window end must not precede its start")
  }
}

function careerItem(
  change: CareerChange,
  account: Account,
  firstObserved: boolean,
): ExternalSourceItem {
  const job: CareerJob = change.kind === "changed" ? change.job : change.job
  const classification = classifyJob({
    jobId: job.jobId,
    title: job.title,
    department: job.department,
    location: job.location,
    url: job.url,
    postedAt: job.postedAt,
    company: account.name,
  })
  return {
    title: job.title,
    department: job.department,
    location: job.location,
    url: job.url,
    observedAt: job.observedAt,
    postedAt: job.postedAt,
    change: change.kind === "unchanged" ? "added" : change.kind,
    relevant: classification.relevant,
    relevanceRationale: classification.rationale,
    firstObserved,
  }
}

function careersResult(
  accounts: readonly Account[],
  result: CareersSourceResult,
  priorRecords: Map<string, CareerJob[]>,
): ExternalSourceAccountResult[] {
  const names = accountNameById(accounts)
  return result.accounts.map((account) => {
    const prior = priorRecords.get(account.accountId)
    const changed = account.changes.filter((change) => change.kind !== "unchanged")
    const items = changed
      .map((change) => careerItem(change, accounts.find((item) => item.id === account.accountId)!, prior === undefined))
      .sort((left, right) => Date.parse(right.postedAt ?? right.observedAt) - Date.parse(left.postedAt ?? left.observedAt))
      .slice(0, MAX_ITEMS_PER_ACCOUNT)
    const relevantCount = account.records.reduce((count, job) => count + (classifyJob({
      jobId: job.jobId,
      title: job.title,
      department: job.department,
      location: job.location,
      url: job.url,
      postedAt: job.postedAt,
      company: names.get(account.accountId) ?? "",
    }).relevant ? 1 : 0), 0)
    return {
      accountName: names.get(account.accountId) ?? "Unknown account",
      status: account.status,
      currentCount: account.records.length,
      relevantCount,
      changedCount: changed.length,
      baselineAvailable: prior !== undefined,
      items,
      ...(account.error ? { error: { code: account.error.code, message: account.error.message, retryable: account.error.retryable } } : {}),
    }
  })
}

function newsResult(
  accounts: readonly Account[],
  result: CompanyNewsCollectionResult,
): ExternalNewsAccountResult[] {
  const names = accountNameById(accounts)
  const failures = new Map(result.failures.map((failure) => [failure.accountId, failure]))
  const snapshots = new Map(result.snapshots.map((snapshot) => [snapshot.accountId, snapshot]))
  return accounts.map((account) => {
    const snapshot = snapshots.get(account.id)
    const failure = failures.get(account.id)
    const items = (snapshot?.observations ?? []).flatMap((observation) => observation.evidence.map((evidence) => ({
      title: evidence.summary,
      url: evidence.source.url ?? "",
      excerpt: evidence.excerpt ?? "",
      author: typeof evidence.attributes.author === "string" ? evidence.attributes.author : "",
      publishedAt: typeof evidence.attributes.publishedAt === "string" ? evidence.attributes.publishedAt : observation.observedAt,
      kind: evidence.kind === "company_post" ? "post" as const : "article" as const,
    }))).slice(0, MAX_ITEMS_PER_ACCOUNT)
    const status = failure ? (snapshot ? "partial" : "failed") : "succeeded"
    return {
      accountName: names.get(account.id) ?? "Unknown account",
      status,
      articleCount: snapshot?.observations.length ?? 0,
      items,
      ...(failure ? { error: { code: failure.code, message: failure.message, retryable: !/invalid_source|incomplete_pagination/.test(failure.code) } } : {}),
    }
  })
}

function combineStatus(careers: ExternalSourceCollectionResult["careers"], news: ExternalSourceCollectionResult["companyNews"]): ExternalSourceCollectionResult["status"] {
  if (careers.status === "unavailable" && news.status === "unavailable") return "unavailable"
  if (careers.status === "partial" || news.status === "partial" || careers.status === "unavailable" || news.status === "unavailable") return "partial"
  return "succeeded"
}

function statusForAccounts<T extends { status: string }>(accounts: readonly T[], unavailable: boolean): "succeeded" | "partial" | "unavailable" {
  if (unavailable) return "unavailable"
  if (accounts.some((account) => account.status === "partial" || account.status === "failed" || account.status === "unsupported" || account.status === "unavailable")) return "partial"
  return "succeeded"
}

function abortableSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function headers(response: Response): Record<string, string> {
  return Object.fromEntries(response.headers.entries())
}

function defaultCareersClient(options: PublicFetchOptions = {}): CareersHttpClient {
  const fetcher = globalThis.fetch.bind(globalThis)
  return async (request) => {
    const response = await fetcher(request.url, {
      method: "GET",
      headers: request.headers,
      redirect: "follow",
      signal: abortableSignal(options.signal ?? request.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
    return {
      status: response.status,
      headers: headers(response),
      body: await response.text(),
      url: response.url,
    }
  }
}

function defaultExaClient(options: PublicFetchOptions = {}): { search: ExaHttpClient; page: ExaHttpClient } {
  const fetcher = globalThis.fetch.bind(globalThis)
  const request = async (input: RequestInfo | URL, init?: RequestInit) => fetcher(input, {
    ...init,
    signal: abortableSignal(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  })
  return { search: request, page: request }
}

function robotsRules(body: string, url: string): boolean {
  const path = new URL(url).pathname || "/"
  let applies = false
  const rules: Array<{ allow: boolean; path: string }> = []
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim()
    const separator = line.indexOf(":")
    if (separator < 0) continue
    const key = line.slice(0, separator).trim().toLowerCase()
    const value = line.slice(separator + 1).trim()
    if (key === "user-agent") {
      applies = value === "*"
    } else if (applies && (key === "allow" || key === "disallow") && value) {
      rules.push({ allow: key === "allow", path: value.replace(/\*/g, "") })
    }
  }
  const matching = rules.filter((rule) => path.startsWith(rule.path)).sort((left, right) => right.path.length - left.path.length)
  return matching.length === 0 || matching[0].allow
}

function createRobotsChecker(options: PublicFetchOptions = {}) {
  const cache = new Map<string, Promise<{ available: boolean; body: string }>>()
  const fetcher = globalThis.fetch.bind(globalThis)
  return async (url: string) => {
    const origin = new URL(url).origin
    let rules = cache.get(origin)
    if (!rules) {
      rules = (async () => {
        try {
          const response = await fetcher(`${origin}/robots.txt`, {
            method: "GET",
            headers: { accept: "text/plain" },
            signal: abortableSignal(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
          })
          if (response.status === 404 || response.status === 410) return { available: true, body: "" }
          if (!response.ok) return { available: false, body: "" }
          return { available: true, body: await response.text() }
        } catch {
          return { available: false, body: "" }
        }
      })()
      cache.set(origin, rules)
    }
    const result = await rules
    return result.available && robotsRules(result.body, url)
  }
}

export async function collectExternalSignals(
  input: ExternalSourceCollectionInput,
  options: ExternalSourceCollectionOptions = {},
): Promise<ExternalSourceCollectionResult> {
  validateInput(input)
  const now = options.now ?? (() => new Date().toISOString())
  const collectedAt = now()
  const limitations: string[] = []

  if (options.enabled !== true) {
    return {
      status: "unavailable",
      window: { ...input.window, collectedAt },
      careers: { status: "unavailable", accounts: input.accounts.map((account) => ({ accountName: account.name, status: "unavailable", currentCount: 0, relevantCount: 0, changedCount: 0, baselineAvailable: false, items: [], error: { code: "disabled", message: "External source collection is disabled", retryable: false } })) },
      companyNews: { status: "unavailable", accounts: input.accounts.map((account) => ({ accountName: account.name, status: "unavailable", articleCount: 0, items: [], error: { code: "disabled", message: "External source collection is disabled", retryable: false } })) },
      limitations: ["External source collection is disabled by deployment configuration."],
    }
  }

  const publicOptions = { signal: options.signal, timeoutMs: DEFAULT_TIMEOUT_MS }
  const careersAccounts = input.accounts.filter((account) => account.careersUrl).map((account) => ({ accountId: account.id, careersUrl: account.careersUrl! }))
  const priorRecords = new Map<string, CareerJob[]>()
  const cache = options.careersCache ?? new Map<string, CareersCacheEntry>()
  for (const account of careersAccounts) {
    const prior = cache.get(account.careersUrl)
    if (prior) priorRecords.set(account.accountId, prior.records)
  }

  const careers = careersAccounts.length === 0
    ? null
    : await collectCareers({
        client: options.careersClient ?? defaultCareersClient(publicOptions),
        accounts: careersAccounts,
        window: input.window,
        receivedAt: collectedAt,
        now,
        cache,
        concurrency: 4,
        retries: 1,
        maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
        checkRobots: options.checkRobots ?? createRobotsChecker(publicOptions),
        checkTerms: options.checkTerms,
      })
  const careersAccountsResult = careers
    ? careersResult(input.accounts, careers, priorRecords)
    : input.accounts.map((account) => ({ accountName: account.name, status: "unavailable" as const, currentCount: 0, relevantCount: 0, changedCount: 0, baselineAvailable: false, items: [], error: { code: "missing_careers_url", message: "No public careers URL is configured", retryable: false } }))
  const careersUnavailable = careers === null || careersAccountsResult.every((account) => account.status === "unsupported" || account.status === "unavailable")
  const careersSummary = { status: statusForAccounts(careersAccountsResult, careersUnavailable), accounts: careersAccountsResult }
  if (careersUnavailable) limitations.push("No usable public careers source succeeded for the requested accounts.")

  let companyNewsSummary: ExternalSourceCollectionResult["companyNews"]
  if (!options.exaApiKey?.trim()) {
    companyNewsSummary = {
      status: "unavailable",
      accounts: input.accounts.map((account) => ({ accountName: account.name, status: "unavailable", articleCount: 0, items: [], error: { code: "missing_exa_api_key", message: "Company-news discovery is not configured", retryable: false } })),
    }
    limitations.push("Company news is unavailable because EXA_API_KEY is not configured.")
  } else {
    const clients = options.newsClient
      ? { client: options.newsClient }
      : (() => {
          const transport = defaultExaClient(publicOptions)
          return {
            client: createExaCompanyNewsClient({
              apiKey: options.exaApiKey!,
              httpClient: transport.search,
              pageClient: transport.page,
              checkRobots: options.checkRobots ?? createRobotsChecker(publicOptions),
              checkTerms: options.checkTerms,
            }),
          }
        })()
    const news = await collectCompanyNews(input.accounts, clients.client, { ...input.window, collectedAt })
    const newsAccountsResult = newsResult(input.accounts, news)
    const newsUnavailable = newsAccountsResult.every((account) => account.status === "failed")
    companyNewsSummary = { status: statusForAccounts(newsAccountsResult, false), accounts: newsAccountsResult }
    if (newsUnavailable) limitations.push("No attributable first-party company-news page succeeded for the requested accounts.")
  }

  const result = {
    status: combineStatus(careersSummary, companyNewsSummary),
    window: { ...input.window, collectedAt },
    careers: careersSummary,
    companyNews: companyNewsSummary,
    limitations,
  } satisfies ExternalSourceCollectionResult
  return result
}

export function createProductionExternalSourceOptions(signal?: AbortSignal): ExternalSourceCollectionOptions {
  return {
    enabled: process.env.EXTERNAL_SOURCES_ENABLED === "1",
    exaApiKey: process.env.EXA_API_KEY,
    checkTerms: () => process.env.EXTERNAL_SOURCE_TERMS_APPROVED === "1",
    signal,
  }
}

export const externalSourceLimits = { maxItemsPerAccount: MAX_ITEMS_PER_ACCOUNT }
