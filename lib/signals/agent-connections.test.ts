import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import d0Connection from "../../agent/connections/d0"

const instructions = readFileSync(resolve(process.cwd(), "agent/instructions.md"), "utf8")

describe("root d0 connection safeguards", () => {
  it("uses the verified user connector and only exposes the bounded lifecycle", () => {
    expect(d0Connection.url).toBe("https://d0-web.vercel.tools/eve/v1/mcp")
    expect(d0Connection.auth).toMatchObject({
      principalType: "user",
      vercelConnect: { connector: "d0-web.vercel.tools/d0" },
    })
    expect(d0Connection.tools).toEqual({
      allow: ["agent_start", "agent_get", "agent_update", "agent_cancel"],
    })
  })

  it("keeps the root lifecycle and evidence invariants explicit", () => {
    for (const invariant of [
      "Salesforce Account ID and verified name first",
      "actual current UTC date/time",
      "call `agent_start` exactly once",
      "Honor every returned `pollAfterMs`",
      "pending input",
      "authorization URL",
      "never start a second invocation",
      "Do not perform duplicate analysis",
      "Do not guess direct SQL",
      "Do not create schedules",
      "A browser-consent callback",
      "Do not ask the user to repeat both sign-ins blindly",
    ]) {
      expect(instructions).toContain(invariant)
    }

    expect(instructions).not.toContain("delegate d0 data retrieval")
    expect(instructions).not.toContain("Delegate requests for d0 statistics")
  })
})
