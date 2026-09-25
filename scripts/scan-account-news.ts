/**
 * Local dry run of the account news monitor. Uses in-memory state and never
 * writes the delivery ledger, so it cannot suppress or duplicate brief output.
 *
 *   npx -y tsx --env-file=.env.local scripts/scan-account-news.ts [--watchlist <file>] [--exa-fixtures <file>]
 *
 * --watchlist      read the watchlist from a local file instead of private Blob.
 * --model          judge model override; --dump-state <file> writes every verdict; --now <iso> fixes the clock.
 * --exa-fixtures   JSON object of account name -> saved Exa results, replacing live search
 *                  (useful because the production EXA_API_KEY is sensitive and not pullable).
 * The judge always calls the real model through AI Gateway (VERCEL_OIDC_TOKEN or AI_GATEWAY_API_KEY).
 */
import { readFileSync, writeFileSync } from "node:fs"
import { emptyNewsState, newsWatchlistSchema, scanAccountNews, type ExaFetch, type ExaNewsRequest, type NewsMonitorState } from "../lib/signals/account-news"
import { createNewsJudge } from "../lib/signals/account-news-judge"
import { NewsWatchlistStore } from "../lib/signals/account-news-store"

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main() {
  const watchlistFile = flag("--watchlist")
  const fixturesFile = flag("--exa-fixtures")
  const watchlist = watchlistFile
    ? newsWatchlistSchema.parse(JSON.parse(readFileSync(watchlistFile, "utf8")))
    : await new NewsWatchlistStore().load()
  if (!watchlist) throw new Error("No watchlist configured")

  let fetchImpl: ExaFetch | undefined
  if (fixturesFile) {
    const fixtures = JSON.parse(readFileSync(fixturesFile, "utf8")) as Record<string, unknown[]>
    // Longest search name first, so "Red Bull Racing" is not answered with "Red Bull" results.
    const byQuery = new Map([...watchlist.accounts].sort((x, y) => y.searchName.length - x.searchName.length).map((account) => [account.searchName, account.name]))
    fetchImpl = async (_url, init) => {
      const body = JSON.parse(String(init.body)) as ExaNewsRequest
      const name = [...byQuery.entries()].find(([searchName]) => body.query.startsWith(searchName))?.[1]
      return new Response(JSON.stringify({ results: name ? fixtures[name] ?? [] : [] }), { status: 200 })
    }
  }

  let state: NewsMonitorState = emptyNewsState()
  const started = Date.now()
  const result = await scanAccountNews({
    enabled: true,
    exaApiKey: fixturesFile ? "fixtures" : process.env.EXA_API_KEY,
    loadWatchlist: async () => watchlist,
    loadReportedIds: async () => [],
    stateStore: { load: async () => ({ state }), save: async (next) => { state = next } },
    judge: createNewsJudge({ model: flag("--model") }),
    fetch: fetchImpl,
    now: flag("--now") ? () => new Date(flag("--now") as string) : undefined,
  })
  console.log(JSON.stringify({ ...result, durationMs: Date.now() - started }, null, 2))
  const neutral = Object.values(state.items).filter((item) => item.verdict === "neutral").length
  console.error(`Judged items remembered: ${Object.keys(state.items).length} (${neutral} neutral)`)
  const dump = flag("--dump-state")
  if (dump) writeFileSync(dump, JSON.stringify(state, null, 2))
}

await main()
