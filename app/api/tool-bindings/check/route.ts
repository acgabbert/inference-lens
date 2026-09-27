import { z } from "zod";

import {
  discoverMcpServer,
  readCommandToolCatalog,
  readMcpServerCatalog,
  validateWorkbenchRequest,
  WorkbenchRequestError,
} from "../../../../services/api/src";
import { checkToolBindings } from "../../../../services/api/src/tool-binding-check.ts";
import { runtimeRequestPolicy } from "../../credential-store";

export const runtime = "nodejs";

const bindingSchema = z.discriminatedUnion("kind", [
  z.object({ toolId: z.string().min(1).max(256), kind: z.literal("command"), commandId: z.string().min(1) }).strict(),
  z.object({
    toolId: z.string().min(1).max(256),
    kind: z.literal("mcp"),
    serverId: z.string().min(1),
    remoteToolName: z.string().min(1),
    discoveryFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
]);
const requestSchema = z.object({ bindings: z.array(bindingSchema).max(256) }).strict();

/**
 * Whether each local grant can be served by this host right now.
 *
 * Grants live in the browser; the declarations they name live here. This is
 * the one place the two are compared before cost is incurred: when a grant is
 * made, and before a batch sends its first provider request.
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
  const results = await checkToolBindings(body.bindings, {
    mcpServers: readMcpServerCatalog().servers,
    commandIds: readCommandToolCatalog().commands.map(({ id }) => id),
    discover: (declaration) => discoverMcpServer(declaration),
  });
  return Response.json({ results }, { headers: { "cache-control": "no-store" } });
}
