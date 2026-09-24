import { z } from "zod";

import { readMcpServerCatalog, validateWorkbenchRequest, WorkbenchRequestError } from "../../../../services/api/src";
import { findMcpConsent, mcpDeclarationFingerprint, mcpSession, removeMcpConsent } from "../../../../services/api/src/mcp-consent.ts";
import { executeMcpTool } from "../../../../services/api/src/mcp-execution.ts";
import { runtimeRequestPolicy } from "../../credential-store";

export const runtime = "nodejs";

const requestSchema = z.object({
  toolId: z.string().min(1),
  toolCallId: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
}).strict();

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
  const session = mcpSession(incoming);
  const consent = findMcpConsent(session, body.toolId);
  if (!consent) return Response.json({ error: "This tool has no active MCP execution consent." }, { status: 403 });
  const catalog = readMcpServerCatalog();
  const declaration = catalog.servers.find(({ id }) => id === consent.serverId);
  if (!declaration || declaration.authorization.kind !== "none" ||
      !["127.0.0.1", "[::1]"].includes(new URL(declaration.endpoint).hostname) ||
      mcpDeclarationFingerprint(declaration) !== consent.declarationFingerprint) {
    removeMcpConsent(session, body.toolId);
    return Response.json({ error: "The local MCP server declaration was removed or changed." }, { status: 403 });
  }
  const outcome = await executeMcpTool(declaration, consent, body.arguments, incoming.signal);
  if (outcome.status === "failed" && outcome.failure.kind === "rejected") removeMcpConsent(session, body.toolId);
  return Response.json(outcome, { headers: { "cache-control": "no-store" } });
}
