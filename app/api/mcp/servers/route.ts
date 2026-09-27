import { MCP_SERVERS_VARIABLE, publicMcpServer, readMcpServerCatalog, validateSameOrigin, WorkbenchRequestError } from "../../../../services/api/src";
import type { McpServersResponse } from "../../../../packages/contracts/src";
import { runtimeRequestPolicy } from "../../credential-store";

export const runtime = "nodejs";

export function GET(incoming: Request): Response {
  try {
    validateSameOrigin(incoming, runtimeRequestPolicy());
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Invalid request." },
      { status: error instanceof WorkbenchRequestError ? error.status : 403 },
    );
  }
  const source = readMcpServerCatalog();
  const body: McpServersResponse = {
    available: source.available,
    ...(source.problem === undefined ? {} : { problem: source.problem }),
    configurationVariable: MCP_SERVERS_VARIABLE,
    servers: source.servers.map(publicMcpServer),
  };
  return Response.json(body, { headers: { "cache-control": "no-store" } });
}
