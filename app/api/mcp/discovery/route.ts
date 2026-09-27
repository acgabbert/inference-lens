import { z } from "zod";

import { discoverMcpServer, readMcpServerCatalog, validateWorkbenchRequest, WorkbenchRequestError } from "../../../../services/api/src";
import { runtimeRequestPolicy } from "../../credential-store";

export const runtime = "nodejs";

const requestSchema = z.object({ serverId: z.string().min(1) }).strict();

export async function POST(incoming: Request): Promise<Response> {
  try {
    validateWorkbenchRequest(incoming, runtimeRequestPolicy());
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Invalid request." },
      { status: error instanceof WorkbenchRequestError ? error.status : 403 },
    );
  }
  let body: z.infer<typeof requestSchema>;
  try {
    body = requestSchema.parse(await incoming.json());
  } catch {
    return Response.json({ error: "Provide a declared MCP server ID." }, { status: 400 });
  }
  const source = readMcpServerCatalog();
  if (!source.available) return Response.json({ error: source.problem ?? "No MCP servers are configured." }, { status: 503 });
  const declaration = source.servers.find(({ id }) => id === body.serverId);
  if (!declaration) return Response.json({ error: "That MCP server is not declared by this service." }, { status: 404 });
  try {
    const discovery = await discoverMcpServer(declaration);
    return Response.json(discovery, { headers: { "cache-control": "no-store" } });
  } catch {
    // SDK and network errors may contain endpoints or headers. The browser gets
    // a fixed explanation; the configured server can be tested by its operator.
    return Response.json({ error: "The MCP server could not be discovered. Check its availability and host configuration." }, { status: 502 });
  }
}
