import { defineTool } from "eve/tools"
import { z } from "zod"
import { scanAccountNews } from "../../lib/signals/account-news"
import { createNewsJudge } from "../../lib/signals/account-news-judge"
import { BlobNewsStateStore, NewsWatchlistStore } from "../../lib/signals/account-news-store"
import { ReportedSignalStore } from "../../lib/signals/reported-signals"

const inputSchema = z.object({}).strict()

export default defineTool({
  description:
    "Scan the whole account watchlist for public news from the last 7 days and return only events an LLM judge rated as material for Vercel: an Opportunity (relaunch, new digital or AI product, new technology leader, funding, expansion) or a Risk (competing platform, layoffs or cost cuts, acquisition, leader departure). Neutral news and events already delivered are excluded, so most days return no events. Takes no input; call exactly once per brief. Each event has an id that must be listed on the Reported signal IDs line once it is shown.",
  inputSchema,
  async execute(_input, ctx) {
    const watchlist = new NewsWatchlistStore()
    const ledger = new ReportedSignalStore()
    return scanAccountNews({
      enabled: process.env.EXTERNAL_SOURCES_ENABLED === "1" && process.env.EXTERNAL_SOURCE_TERMS_APPROVED === "1",
      exaApiKey: process.env.EXA_API_KEY,
      loadWatchlist: () => watchlist.load(),
      loadReportedIds: () => ledger.listRecent(),
      stateStore: new BlobNewsStateStore(),
      judge: createNewsJudge(),
      signal: ctx.abortSignal,
    })
  },
})

export { inputSchema as scanAccountNewsInputSchema }
