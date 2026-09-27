import { z } from "zod";

import {
  isExecutableMcpDeclaration,
  readMcpServerCatalog,
  validateWorkbenchRequest,
  WorkbenchRequestError,
} from "../../../../services/api/src";
import { executeMcpTool } from "../../../../services/api/src/mcp-execution.ts";
import { runtimeRequestPolicy } from "../../credential-store";

export const runtime = "nodejs";

const requestSchema = z.object({
  toolCallId: z.string().min(1),
  serverId: z.string().min(1),
  remoteToolName: z.string().min(1),
  discoveryFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  arguments: z.record(z.string(), z.unknown()),
}).strict();

/**
 * Calls one tool on a declared MCP server.
 *
 * The page names a server ID, remote tool, and the fingerprint it was granted
 * against — never a URL, credential, or timeout. The operator's catalog is the
 * ceiling; the live fingerprint is checked before every call. Like command
 * execution, anything after request validation is a run event answered with a
 * 200 outcome, including a server this host can no longer serve.
 */
export async function POST(incoming: Request): Promise<Response> {
  let body: z.infer<typeof requestSchema>;
  try {
    validateWorkbenchRequest(incoming, runtimeRequestPolicy());
    body = requestSchema.parse(await incoming.json());
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invalid request." }, {
      status: error instanceof WorkbenchRequestError ? error.status : 400,
    });
  }
  if (Buffer.byteLength(JSON.stringify(body.arguments)) > 1_048_576) {
    return Response.json({ error: "MCP arguments exceed the 1 MiB limit." }, { status: 413 });
  }
  const declaration = readMcpServerCatalog().servers.find(({ id }) => id === body.serverId);
  const headers = { "cache-control": "no-store" };
  if (!declaration) {
    return Response.json({ status: "failed", failure: {
      kind: "unavailable", message: "This service no longer declares the MCP server this tool was granted to use.",
    } }, { headers });
  }
  if (!isExecutableMcpDeclaration(declaration)) {
    return Response.json({ status: "failed", failure: {
      kind: "unavailable", message: "This MCP server is declared for discovery only; this service does not execute its tools.",
    } }, { headers });
  }
  const outcome = await executeMcpTool(declaration, body, body.arguments, incoming.signal);
  return Response.json(outcome, { headers });
}
