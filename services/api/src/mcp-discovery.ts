import { createHash } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Tool } from "@modelcontextprotocol/client";

import type {
  McpDiscoveredTool,
  McpDiscoveryResponse,
} from "../../../packages/contracts/src/mcp-discovery.ts";
import type { JsonObject, JsonValue } from "../../../packages/core/src/run-kernel/types.ts";
import { publicMcpServer } from "./mcp-server-catalog.ts";
import type { McpServerDeclaration } from "./mcp-server-catalog.ts";

const DISCOVERY_MAX_TOOLS = 512;
const DISCOVERY_MAX_BYTES = 4_194_304;
const SCHEMA_MAX_BYTES = 65_536;
const POOL_IDLE_MS = 300_000;
const supportedVersions = new Set(["2026-07-28", "2025-11-25"]);

function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function boundedSchema(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const seen = new WeakSet<object>();
  let nodes = 0;
  function visit(item: unknown, depth: number): boolean {
    if (++nodes > 4096 || depth > 32) return false;
    if (item === null || typeof item === "string" || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item !== "object") return false;
    if (seen.has(item)) return false;
    seen.add(item);
    return Object.values(item).every((child) => visit(child, depth + 1));
  }
  if (!visit(value, 0)) return;
  try {
    if (Buffer.byteLength(JSON.stringify(value)) > SCHEMA_MAX_BYTES) return;
    return structuredClone(value) as JsonObject;
  } catch { return; }
}

export function normalizeMcpTools(rawTools: readonly Tool[]): McpDiscoveredTool[] {
  if (rawTools.length > DISCOVERY_MAX_TOOLS) throw new Error("The MCP server returned too many tools.");
  const counts = new Map<string, number>();
  rawTools.forEach((tool) => counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1));
  return rawTools.map((tool) => {
    const base = {
      remoteName: tool.name,
      ...(typeof tool.title === "string" && tool.title.length <= 512 ? { title: tool.title } : {}),
      ...(typeof tool.description === "string" && tool.description.length <= 16_384 ? { description: tool.description } : {}),
    };
    const inputSchema = boundedSchema(tool.inputSchema);
    const outputSchema = tool.outputSchema === undefined ? undefined : boundedSchema(tool.outputSchema);
    const invalidReason =
      counts.get(tool.name)! > 1 ? "Duplicate remote tool name." :
      tool.name.length > 256 || tool.title && tool.title.length > 512 || tool.description && tool.description.length > 16_384 ? "The tool name, title, or description is too long." :
      !inputSchema || inputSchema.type !== "object" ? "The input schema must be a bounded JSON Schema object with type object." :
      tool.outputSchema !== undefined && !outputSchema ? "The output schema is too large or invalid." :
      undefined;
    if (invalidReason) return { ...base, invalidReason };
    const material = {
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: inputSchema!,
      outputSchema: outputSchema ?? null,
      annotations: tool.annotations ?? null,
    } as JsonValue;
    return {
      ...base,
      inputSchema: inputSchema!,
      ...(outputSchema === undefined ? {} : { outputSchema }),
      fingerprint: createHash("sha256").update(canonical(material)).digest("hex"),
    };
  });
}

interface PooledClient {
  key: string;
  client: Client;
  idle?: ReturnType<typeof setTimeout>;
  budget: { bytes: number };
}

const clients = new Map<string, PooledClient>();
const discoveryQueues = new Map<string, Promise<void>>();

function authorizationHeader(
  declaration: McpServerDeclaration,
  environment: Record<string, string | undefined>,
): [string, string] | undefined {
  const auth = declaration.authorization;
  if (auth.kind === "none") return;
  const secret = environment[auth.environmentVariable];
  if (!secret) throw new Error("The MCP server's configured authorization variable is unset.");
  return auth.kind === "bearer-env"
    ? ["authorization", `Bearer ${secret}`]
    : [auth.headerName, secret];
}

function boundedFetch(
  declaration: McpServerDeclaration,
  header: [string, string] | undefined,
  budget: { bytes: number },
): typeof fetch {
  const endpoint = new URL(declaration.endpoint);
  return async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.origin !== endpoint.origin || target.pathname !== endpoint.pathname || target.search !== endpoint.search) {
      throw new Error("The MCP transport tried to contact an undeclared endpoint.");
    }
    const headers = new Headers(init?.headers);
    if (header) headers.set(...header);
    const response = await fetch(input, { ...init, headers, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error("MCP redirects are not allowed.");
    }
    const limit = Math.min(declaration.maxResponseBytes, DISCOVERY_MAX_BYTES);
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > limit) {
      await response.body?.cancel();
      throw new Error("The MCP response is too large.");
    }
    if (!response.body) return response;
    let responseBytes = 0;
    const bounded = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        responseBytes += chunk.byteLength;
        budget.bytes += chunk.byteLength;
        if (responseBytes > limit || budget.bytes > DISCOVERY_MAX_BYTES) {
          controller.error(new Error("The MCP discovery response is too large."));
        } else controller.enqueue(chunk);
      },
    }));
    return new Response(bounded, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

async function pooledClient(
  declaration: McpServerDeclaration,
  environment: Record<string, string | undefined>,
): Promise<PooledClient> {
  const auth = authorizationHeader(declaration, environment);
  const key = createHash("sha256").update(JSON.stringify([declaration, auth])).digest("hex");
  const existing = clients.get(declaration.id);
  if (existing?.key === key) {
    if (existing.idle) clearTimeout(existing.idle);
    return existing;
  }
  if (existing) {
    clients.delete(declaration.id);
    if (existing.idle) clearTimeout(existing.idle);
    await existing.client.close();
  }
  const budget = { bytes: 0 };
  const client = new Client(
    { name: "inference-lens", version: "0.2.0" },
    { versionNegotiation: { mode: "auto" }, listMaxPages: 64, inputRequired: { autoFulfill: false } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(declaration.endpoint), {
    fetch: boundedFetch(declaration, auth, budget),
  });
  try {
    await client.connect(transport, { timeout: declaration.connectTimeoutMs });
    if (!supportedVersions.has(client.getNegotiatedProtocolVersion() ?? "")) {
      throw new Error("The MCP server negotiated an unsupported protocol version.");
    }
    const item = { key, client, budget };
    clients.set(declaration.id, item);
    return item;
  } catch (error) {
    await client.close();
    throw error;
  }
}

async function discoverUnlocked(
  declaration: McpServerDeclaration,
  environment: Record<string, string | undefined> = process.env,
): Promise<McpDiscoveryResponse> {
  const item = await pooledClient(declaration, environment);
  item.budget.bytes = 0;
  try {
    const catalog = await item.client.listTools(undefined, {
      timeout: declaration.connectTimeoutMs,
      cacheMode: "refresh",
    });
    const server = item.client.getServerVersion();
    const capabilities = item.client.getServerCapabilities();
    return {
      server: publicMcpServer(declaration),
      serverIdentity: { name: server?.name ?? "Unknown server", version: server?.version ?? "unknown" },
      protocolVersion: item.client.getNegotiatedProtocolVersion() ?? "unknown",
      capabilities: { tools: Boolean(capabilities?.tools) },
      refreshedAt: new Date().toISOString(),
      tools: normalizeMcpTools(catalog.tools),
    };
  } catch (error) {
    clients.delete(declaration.id);
    await item.client.close();
    throw error;
  } finally {
    if (clients.get(declaration.id) === item) {
      item.idle = setTimeout(() => {
        clients.delete(declaration.id);
        void item.client.close();
      }, POOL_IDLE_MS);
      item.idle.unref?.();
    }
  }
}

/** Serialize refreshes per server so a pooled client's byte budget is per discovery. */
export async function discoverMcpServer(
  declaration: McpServerDeclaration,
  environment: Record<string, string | undefined> = process.env,
): Promise<McpDiscoveryResponse> {
  const preceding = discoveryQueues.get(declaration.id);
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  discoveryQueues.set(declaration.id, turn);
  if (preceding) await preceding;
  try {
    return await discoverUnlocked(declaration, environment);
  } finally {
    release();
    if (discoveryQueues.get(declaration.id) === turn) discoveryQueues.delete(declaration.id);
  }
}
