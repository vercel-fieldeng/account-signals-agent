/**
 * Operator script for the private account news watchlist.
 *
 *   npx -y tsx --env-file=.env.local scripts/news-watchlist.ts push <watchlist.json>
 *   npx -y tsx --env-file=.env.local scripts/news-watchlist.ts show
 *
 * The watchlist holds customer names, so it lives only in private Blob storage
 * and in a local file outside the repository.
 */
import { readFileSync } from "node:fs"
import { newsWatchlistSchema } from "../lib/signals/account-news"
import { NEWS_WATCHLIST_PATH, NewsWatchlistStore } from "../lib/signals/account-news-store"

async function main() {
  const [command, file] = process.argv.slice(2)
  const store = new NewsWatchlistStore()
  if (command === "push" && file) {
    const watchlist = newsWatchlistSchema.parse(JSON.parse(readFileSync(file, "utf8")))
    await store.replace(watchlist)
    console.log(`Uploaded ${watchlist.accounts.length} accounts to ${NEWS_WATCHLIST_PATH}`)
    return
  }
  if (command === "show") {
    const watchlist = await store.load()
    if (!watchlist) {
      console.log(`No watchlist at ${NEWS_WATCHLIST_PATH}`)
      return
    }
    console.log(`${watchlist.accounts.length} accounts at ${NEWS_WATCHLIST_PATH}`)
    for (const account of watchlist.accounts) console.log(`- ${account.name} (${account.searchName}${account.context ? `, ${account.context}` : ""})`)
    return
  }
  console.error("Usage: news-watchlist.ts push <watchlist.json> | show")
  process.exitCode = 2
}

await main()
