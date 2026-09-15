// d0 validates the resource independently of scope at its OAuth authorize endpoint.
// Connect does not infer it from the MCP URL; every phase must use the same parameters.
export const D0_CONNECTOR_UID = "d0-web.vercel.tools/d0"
export const D0_MCP_RESOURCE = "https://d0-web.vercel.tools/eve/v1/mcp"

export function d0TokenParams() {
  return {
    scopes: ["d0:invoke"],
    resources: [D0_MCP_RESOURCE],
  }
}
