import { defineTool } from "eve/tools"
import { z } from "zod"
import { executeAutomationSetup } from "../../lib/signals/automation-setup"

export default defineTool({
  description:
    "Register one-time automation consent, schedule an initial native diagnostic five minutes after the d0 grant resolves, and enable one daily 08:00 Europe/Berlin diagnostic. This does not retrieve customer data during setup.",
  inputSchema: z.object({}).strict(),
  async execute(_input, ctx) {
    return executeAutomationSetup(ctx)
  },
})
