import { defineTool } from "eve/tools"
import { z } from "zod"
import { executeAutomationSetup } from "../../lib/signals/automation-setup"

export default defineTool({
  description:
    "Register one-time automation consent and schedule one native diagnostic five minutes after Salesforce and d0 grants resolve. This does not retrieve customer data or schedule Slack messages.",
  inputSchema: z.object({}).strict(),
  async execute(_input, ctx) {
    return executeAutomationSetup(ctx)
  },
})
