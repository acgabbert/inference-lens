import { readFileSync } from "node:fs";
import { z } from "zod";

export const MCP_SERVERS_VARIABLE = "INFERENCE_LENS_MCP_SERVERS";
export const MCP_CONNECT_TIMEOUT_MS = 10_000;
export const MCP_CALL_TIMEOUT_MS = 30_000;
export const MCP_MAX_RESPONSE_BYTES = 1_048_576;

const environmentName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const authSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("bearer-env"), environmentVariable: environmentName }).strict(),
  z.object({
    kind: z.literal("header-env"),
    headerName: z.string().regex(/^[A-Za-z][A-Za-z0-9-]*$/),
    environmentVariable: environmentName,
  }).strict(),
]);

const declarationSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
  label: z.string().trim().min(1),
  endpoint: z.url(),
  transport: z.literal("streamable-http"),
  authorization: authSchema,
  connectTimeoutMs: z.number().int().positive().max(60_000).default(MCP_CONNECT_TIMEOUT_MS),
  callTimeoutMs: z.number().int().positive().max(600_000).default(MCP_CALL_TIMEOUT_MS),
  maxResponseBytes: z.number().int().positive().max(16_777_216).default(MCP_MAX_RESPONSE_BYTES),
}).strict().superRefine((declaration, context) => {
  let endpoint: URL;
  try { endpoint = new URL(declaration.endpoint); } catch { return; }
  if (endpoint.username || endpoint.password || endpoint.hash || endpoint.search) {
    context.addIssue({ code: "custom", path: ["endpoint"], message: "Credentials, queries, and fragments are not allowed in an MCP endpoint." });
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
    context.addIssue({ code: "custom", path: ["endpoint"], message: "Use HTTPS, or HTTP on a loopback address." });
  }
  if (declaration.authorization.kind === "header-env" &&
      /^(host|cookie|origin|authorization|proxy-authorization|mcp-session-id|mcp-protocol-version)$/i.test(declaration.authorization.headerName)) {
    context.addIssue({ code: "custom", path: ["authorization", "headerName"], message: "This header is managed by the host or transport." });
  }
});

const catalogSchema = z.object({
  schemaVersion: z.literal(1),
  servers: z.array(declarationSchema),
}).strict().superRefine((catalog, context) => {
  const ids = new Set<string>();
  catalog.servers.forEach((server, index) => {
    if (ids.has(server.id)) context.addIssue({ code: "custom", path: ["servers", index, "id"], message: `Duplicate server id "${server.id}".` });
    ids.add(server.id);
  });
});

export type McpServerDeclaration = z.infer<typeof declarationSchema>;

export interface McpServerCatalogSource {
  available: boolean;
  problem?: string;
  servers: McpServerDeclaration[];
}

export function parseMcpServerCatalog(value: unknown): McpServerDeclaration[] {
  const result = catalogSchema.safeParse(value);
  if (!result.success) {
    throw new Error(result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  }
  return result.data.servers;
}

/** The operator catalog is the ceiling; browser input never supplies a URL. */
export function readMcpServerCatalog(
  environment: Record<string, string | undefined> = process.env,
): McpServerCatalogSource {
  const catalogPath = environment[MCP_SERVERS_VARIABLE]?.trim();
  if (!catalogPath) return { available: false, servers: [] };
  try {
    const servers = parseMcpServerCatalog(JSON.parse(readFileSync(catalogPath, "utf8")));
    return { available: true, servers };
  } catch (error) {
    return {
      available: false,
      servers: [],
      problem: `${MCP_SERVERS_VARIABLE} could not be used: ${error instanceof Error ? error.message : "unknown error"}`,
    };
  }
}

/**
 * The execution ceiling: an unauthenticated server at a literal loopback
 * address. Other declared servers can be discovered but never called.
 */
export function isExecutableMcpDeclaration(server: McpServerDeclaration): boolean {
  const url = new URL(server.endpoint);
  return url.protocol === "http:" && server.authorization.kind === "none" &&
    ["127.0.0.1", "[::1]"].includes(url.hostname);
}

export function publicMcpServer(server: McpServerDeclaration): {
  id: string; label: string; endpointIdentity: string; executionAvailable: boolean;
} {
  return {
    id: server.id, label: server.label, endpointIdentity: new URL(server.endpoint).origin,
    executionAvailable: isExecutableMcpDeclaration(server),
  };
}
