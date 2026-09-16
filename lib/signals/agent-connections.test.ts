import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import d0Connection from "../../agent/connections/d0"
import indexConnection from "../../agent/connections/index"

const instructions = readFileSync(resolve(process.cwd(), "agent/instructions.md"), "utf8")

describe("root data connection safeguards", () => {
  it("uses environment-backed bearer and protection credentials with bounded Index tools", async () => {
    const previousBypass = process.env.INDEX_PROTECTION_BYPASS
    const previousToken = process.env.INDEX_ACCESS_TOKEN
    process.env.INDEX_PROTECTION_BYPASS = "test-bypass"
    process.env.INDEX_ACCESS_TOKEN = "test-token"
    try {
      expect(indexConnection.url).toBe("https://index.vercel.sh/api/mcp")
      expect(indexConnection.tools).toEqual({
        allow: ["search_meetings", "get_meeting_transcript", "sfdc_lookup"],
      })
      expect(indexConnection.auth).toMatchObject({ principalType: "app" })
      const auth = indexConnection.auth as { getToken: () => Promise<{ token: string }> }
      await expect(auth.getToken()).resolves.toEqual({ token: "test-token" })
      expect(typeof indexConnection.headers).toBe("function")
      const headers = await (indexConnection.headers as () => Promise<Record<string, string>> | Record<string, string>)()
      expect(headers).toEqual({ "x-vercel-protection-bypass": "test-bypass" })
    } finally {
      if (previousBypass === undefined) delete process.env.INDEX_PROTECTION_BYPASS
      else process.env.INDEX_PROTECTION_BYPASS = previousBypass
      if (previousToken === undefined) delete process.env.INDEX_ACCESS_TOKEN
      else process.env.INDEX_ACCESS_TOKEN = previousToken
    }
  })

  it("uses the verified user connector and only exposes the bounded d0 lifecycle", () => {
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
      "Do not ask the user to repeat sign-in blindly",
    ]) {
      expect(instructions).toContain(invariant)
    }

    expect(instructions).not.toContain("delegate d0 data retrieval")
    expect(instructions).not.toContain("Delegate requests for d0 statistics")
  })
})
