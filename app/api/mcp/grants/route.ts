import { z } from "zod";

import { discoverMcpServer, readMcpServerCatalog, validateSameOrigin, validateWorkbenchRequest, WorkbenchRequestError } from "../../../../services/api/src";
import {
  createMcpSession, listMcpConsents, mcpDeclarationFingerprint, mcpSession, mcpSessionCookie,
  publicMcpConsent, removeMcpConsent, setMcpConsent,
} from "../../../../services/api/src/mcp-consent.ts";
import { runtimeRequestPolicy } from "../../credential-store";

export const runtime = "nodejs";

const grantSchema = z.object({
  toolId: z.string().min(1).max(256),
  serverId: z.string().min(1),
  remoteToolName: z.string().min(1),
  discoveryFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  mode: z.enum(["ask", "automatic"]),
}).strict();
const revokeSchema = z.object({ toolId: z.string().min(1) }).strict();

function failure(error: unknown): Response {
  return Response.json({ error: error instanceof Error ? error.message : "Invalid request." }, {
    status: error instanceof WorkbenchRequestError ? error.status : 400,
  });
}

function isLocalUnauthenticated(endpoint: string, authKind: string): boolean {
  const url = new URL(endpoint);
  return authKind === "none" && url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "[::1]");
}

export async function GET(incoming: Request): Promise<Response> {
  try { validateSameOrigin(incoming, runtimeRequestPolicy()); }
  catch (error) { return failure(error); }
  return Response.json({ grants: listMcpConsents(mcpSession(incoming)).map(publicMcpConsent) }, {
    headers: { "cache-control": "no-store" },
  });
}

export async function POST(incoming: Request): Promise<Response> {
  let body: z.infer<typeof grantSchema>;
  try {
    validateWorkbenchRequest(incoming, runtimeRequestPolicy());
    body = grantSchema.parse(await incoming.json());
  } catch (error) { return failure(error); }
  const source = readMcpServerCatalog();
  const declaration = source.servers.find(({ id }) => id === body.serverId);
  if (!declaration || !isLocalUnauthenticated(declaration.endpoint, declaration.authorization.kind)) {
    return Response.json({ error: "MCP execution requires a declared unauthenticated loopback server." }, { status: 403 });
  }
  try {
    const discovery = await discoverMcpServer(declaration);
    const tool = discovery.tools.find(({ remoteName }) => remoteName === body.remoteToolName);
    if (!tool || tool.invalidReason || tool.fingerprint !== body.discoveryFingerprint) {
      return Response.json({ error: "The MCP tool changed or is no longer available. Refresh discovery before granting execution." }, { status: 409 });
    }
  } catch {
    return Response.json({ error: "The MCP server could not be checked." }, { status: 502 });
  }
  const session = mcpSession(incoming) ?? createMcpSession();
  const grant = { ...body, grantedAt: new Date().toISOString(), declarationFingerprint: mcpDeclarationFingerprint(declaration) };
  setMcpConsent(session, grant);
  return Response.json({ grant: publicMcpConsent(grant) }, {
    status: 201,
    headers: { "cache-control": "no-store", "set-cookie": mcpSessionCookie(session, new URL(incoming.url).protocol === "https:") },
  });
}

export async function DELETE(incoming: Request): Promise<Response> {
  let body: z.infer<typeof revokeSchema>;
  try {
    validateWorkbenchRequest(incoming, runtimeRequestPolicy());
    body = revokeSchema.parse(await incoming.json());
  } catch (error) { return failure(error); }
  removeMcpConsent(mcpSession(incoming), body.toolId);
  return Response.json({ grants: listMcpConsents(mcpSession(incoming)).map(publicMcpConsent) }, {
    headers: { "cache-control": "no-store" },
  });
}
