import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { InteractiveAuthorizationDefinition, ConnectionPrincipal } from "eve/connections"
import rootD0Connection from "../../agent/connections/d0"
import {
  AUTOMATION_CHANNEL_ID,
  AUTOMATION_OPERATOR_USER_ID,
  AUTOMATION_SETUP_MARKER,
  AUTOMATION_WORKSPACE_ID,
  automationSetupAuth,
} from "./automation-policy"
import { AUTOMATION_CONNECTORS, executeAutomationSetup } from "./automation-setup"
import { D0_CONNECTOR_UID, D0_MCP_RESOURCE, d0TokenParams } from "./d0-authorization"

vi.mock("@vercel/oidc", () => ({
  getVercelOidcToken: vi.fn(async () => "synthetic-oidc-token"),
}))

// A package-local OIDC copy may not use Vitest's module mock. Supply a syntactic
// dummy only for that test path; all HTTP remains stubbed and it grants no access.
beforeEach(() => {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")
  const payload = Buffer.from(JSON.stringify({ exp: 4100000000 })).toString("base64url")
  vi.stubEnv("VERCEL_OIDC_TOKEN", `${header}.${payload}.`)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

type RequestRecord = {
  url: string
  body: Record<string, unknown>
}

const authorizeEndpoint = `https://api.vercel.com/v1/connect/authorize/${encodeURIComponent(D0_CONNECTOR_UID)}`
const tokenEndpoint = `https://api.vercel.com/v1/connect/token/${encodeURIComponent(D0_CONNECTOR_UID)}`

function installFetchFake() {
  const requests: RequestRecord[] = []
  const fetchFake = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url !== authorizeEndpoint && url !== tokenEndpoint) {
      throw new Error(`unexpected endpoint: ${url}`)
    }
    if (init?.method !== "POST" || typeof init.body !== "string") {
      throw new Error(`unexpected request shape for ${url}`)
    }
    const body = JSON.parse(init.body) as Record<string, unknown>
    requests.push({ url, body })
    if (url === authorizeEndpoint) {
      return new Response(JSON.stringify({ url: "https://d0.example.test/consent" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response(
      JSON.stringify({
        token: "synthetic-access-token",
        expiresAt: Date.now() + 60 * 60 * 1000,
        connector: { id: "synthetic-connector", uid: D0_CONNECTOR_UID, type: "oauth" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  })
  vi.stubGlobal("fetch", fetchFake)
  return { requests, fetchFake }
}

function userPrincipal(caseName: string): Extract<ConnectionPrincipal, { type: "user" }> {
  return {
    type: "user",
    id: `fixture-${caseName}`,
    issuer: "https://fixture.example.test",
  }
}

function connection() {
  return { url: D0_MCP_RESOURCE }
}

function d0InteractiveAuth(value: unknown): InteractiveAuthorizationDefinition {
  if (
    typeof value !== "object" ||
    value === null ||
    !("getToken" in value) ||
    !("startAuthorization" in value) ||
    !("completeAuthorization" in value)
  ) {
    throw new Error("expected an interactive D0 authorization definition")
  }
  return value as InteractiveAuthorizationDefinition
}

function expectD0Params(
  body: Record<string, unknown>,
  principal: Extract<ConnectionPrincipal, { type: "user" }>,
) {
  expect(body.scopes).toEqual(["d0:invoke"])
  expect(body.resources).toEqual([D0_MCP_RESOURCE])
  expect(body.subject).toEqual({ type: "user", id: principal.id, issuer: principal.issuer })
}

describe("D0 authorization serialization", () => {
  it("returns fresh params with the exact resource URL and no origin or trailing slash", () => {
    const first = d0TokenParams()
    const second = d0TokenParams()

    expect(first).not.toBe(second)
    expect(first.scopes).not.toBe(second.scopes)
    expect(first.resources).not.toBe(second.resources)
    first.scopes.push("fixture-only")
    first.resources.push("https://fixture.example.test/")

    expect(second).toEqual({ scopes: ["d0:invoke"], resources: [D0_MCP_RESOURCE] })
    expect(D0_MCP_RESOURCE).toBe("https://d0-web.vercel.tools/eve/v1/mcp")
    expect(new URL(D0_MCP_RESOURCE).origin).toBe("https://d0-web.vercel.tools")
    expect(D0_MCP_RESOURCE.endsWith("/")).toBe(false)
  })

  it("serializes scopes, resources, and the stable user subject through every root auth phase", async () => {
    const { requests } = installFetchFake()
    const auth = d0InteractiveAuth(rootD0Connection.auth)
    const phases = [
      ["startAuthorization", userPrincipal("root-start")],
      ["getToken", userPrincipal("root-token")],
      ["completeAuthorization", userPrincipal("root-complete")],
    ] as const

    await auth.startAuthorization({
      principal: phases[0][1],
      connection: connection(),
      callbackUrl: "https://fixture.example.test/callback",
    })
    await auth.getToken({ principal: phases[1][1], connection: connection() })
    await auth.completeAuthorization({
      principal: phases[2][1],
      connection: connection(),
      callbackUrl: "https://fixture.example.test/callback",
      callback: { method: "GET", params: {} },
    })

    expect(requests).toHaveLength(3)
    expect(requests[0].url).toBe(authorizeEndpoint)
    expect(requests[1].url).toBe(tokenEndpoint)
    expect(requests[2].url).toBe(tokenEndpoint)
    expectD0Params(requests[0].body, phases[0][1])
    expectD0Params(requests[1].body, phases[1][1])
    expectD0Params(requests[2].body, phases[2][1])
    expect(requests[0].body.returnUrl).toBe("https://fixture.example.test/callback")
    expect(requests[0].body.deviceCode).toBe(true)
    expect(JSON.stringify(requests)).not.toContain("synthetic-access-token")
    expect(JSON.stringify(requests)).not.toContain("synthetic-oidc-token")
  })

  it("uses the same params in the actual setup-constructed D0 definition", async () => {
    const { requests } = installFetchFake()
    const captured: unknown[] = []
    const current = automationSetupAuth(
      {
        authenticator: "slack-webhook",
        principalId: `slack:${AUTOMATION_WORKSPACE_ID}:${AUTOMATION_OPERATOR_USER_ID}`,
        principalType: "user",
        issuer: `slack:${AUTOMATION_WORKSPACE_ID}`,
        attributes: {
          user_id: AUTOMATION_OPERATOR_USER_ID,
          team_id: AUTOMATION_WORKSPACE_ID,
          channel_id: AUTOMATION_CHANNEL_ID,
          author_type: "user",
        },
      },
      "1700000000.123456",
    )
    const beginSetup = vi.fn(async () => ({
      ticket: { requestId: "fixture-request", generation: 1 },
      scheduledFor: null,
    }))
    const completeSetup = vi.fn(async () => ({
      id: "fixture-internal-id",
      dueAt: "2024-01-01T00:05:00.000Z",
      status: "scheduled" as const,
    }))

    await executeAutomationSetup(
      {
        session: { auth: { current, initiator: null }, parent: undefined },
        getToken: vi.fn(async (provider: unknown) => {
          captured.push(provider)
          return "synthetic-provider-token"
        }),
      },
      { beginSetup, completeSetup },
      "production",
    )

    expect(AUTOMATION_CONNECTORS[0].uid).toBe(D0_CONNECTOR_UID)
    expect(AUTOMATION_CONNECTORS[0].tokenParams()).toEqual(d0TokenParams())
    expect(captured).toHaveLength(1)

    const auth = d0InteractiveAuth(captured[0])
    const principal = userPrincipal("setup-definition")
    await auth.getToken({ principal, connection: connection() })

    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe(tokenEndpoint)
    expectD0Params(requests[0].body, principal)
    expect(JSON.stringify(requests)).not.toContain("synthetic-provider-token")
    expect(beginSetup).toHaveBeenCalledTimes(1)
    expect(completeSetup).toHaveBeenCalledTimes(1)
  })
})
