import { defineTool } from "eve/tools"
import { z } from "zod"
import { accountSchema } from "../../lib/signals/contracts"
import { readExternalSourceCache, writeExternalSourceCache } from "../../lib/signals/external-source-cache"
import {
  collectExternalSignals,
  createProductionExternalSourceOptions,
} from "../../lib/signals/external-sources"

const inputSchema = z.object({
  accounts: z.array(accountSchema).min(1),
  startedAt: z.iso.datetime({ offset: true }),
  endedAt: z.iso.datetime({ offset: true }),
}).strict().superRefine((input, context) => {
  if (Date.parse(input.endedAt) < Date.parse(input.startedAt)) {
    context.addIssue({ code: "custom", path: ["endedAt"], message: "endedAt must not precede startedAt" })
  }
  const ids = input.accounts.map((account) => account.id)
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["accounts"], message: "accounts must be unique" })
  }
})

export default defineTool({
  description:
    "Collect bounded public first-party careers and company-news evidence for the already verified Salesforce account roster. Call once after account identity, domains, careers URLs, and owner assignments have been verified. This tool never uses LinkedIn, treats Exa as discovery only, and reports unavailable or partial sources explicitly.",
  inputSchema,
  async execute(input, ctx) {
    const options = createProductionExternalSourceOptions(ctx.abortSignal)
    let cacheState: Awaited<ReturnType<typeof readExternalSourceCache>> | undefined
    const cacheLimitations: string[] = []
    if (options.enabled) {
      try {
        cacheState = await readExternalSourceCache()
        options.careersCache = cacheState.careers
      } catch {
        // Source retrieval remains useful without a baseline, but the result must
        // say that first-observed careers records cannot prove a new opening.
        cacheState = { careers: new Map() }
        options.careersCache = cacheState.careers
        cacheLimitations.push("Careers baseline cache was unavailable; careers records are first-observed for this run.")
      }
    }

    const result = await collectExternalSignals(
      { accounts: input.accounts, window: { startedAt: input.startedAt, endedAt: input.endedAt } },
      options,
    )
    if (cacheState && options.enabled) {
      try {
        await writeExternalSourceCache(cacheState.careers, cacheState.etag)
      } catch {
        cacheLimitations.push("Careers baseline cache could not be persisted; the next run may be first-observed.")
      }
    }
    result.limitations.push(...cacheLimitations)
    return result
  },
})

export { inputSchema as collectExternalSignalsInputSchema }
