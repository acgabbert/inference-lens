import { createServer } from "node:http";
import { Readable } from "node:stream";

import { Server, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";

const port = Number(process.env.INFERENCE_LENS_MCP_FIXTURE_PORT ?? 44018);
let revision = 1;
let discoveryRequests = 0;
let calls = 0;
/** Every `/mcp` request, answered or refused: evidence that nothing contacted a downed server. */
let mcpRequests = 0;
let lastCall = null;
/** While down, every MCP request fails as a stopped server's would. */
let down = false;
/**
 * `hold` calls still waiting for `/release` or `/drop`.
 *
 * A call that is actually in flight is the only way to interrupt one: the
 * `slow` record outlives only this fixture's 200 ms catalog timeout, so a stop
 * or an outage against it would land on an already-failed call.
 */
const held = new Set();
/** Open `/mcp` connections, so `/drop` can sever them as a killed process would. */
const sockets = new Set();

const server = new Server(
  { name: "inference-lens-discovery-fixture", version: "1.0.0" },
  { capabilities: { tools: { listChanged: true } } },
);
server.setRequestHandler("tools/list", async (request) => {
  discoveryRequests++;
  if (!request.params?.cursor) return {
    tools: [{
      name: "lookup_record",
      title: "Look up a record",
      description: revision === 1 ? "Find a synthetic record." : "Find an updated synthetic record.",
      inputSchema: {
        type: "object",
        properties: { record_id: { type: "string" } },
        required: ["record_id"],
        additionalProperties: false,
      },
    }],
    nextCursor: "page-2",
  };
  return {
    tools: [{
      name: "second_tool",
      description: "A tool on the second page. <img src=x onerror=window.__mcpInjected=1>",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    }],
  };
});
server.setRequestHandler("tools/call", async (request) => {
  calls++;
  lastCall = { name: request.params.name, arguments: request.params.arguments };
  if (request.params.name !== "lookup_record") {
    return { content: [{ type: "text", text: "Unknown fixture tool." }], isError: true };
  }
  const recordId = request.params.arguments?.record_id;
  if (recordId === "tool-error") return {
    content: [{ type: "text", text: "Record lookup rejected by fixture." }], isError: true,
  };
  if (recordId === "slow") {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return { content: [{ type: "text", text: "late response" }] };
  }
  if (recordId === "hold") {
    await new Promise((resolve) => {
      held.add(resolve);
    });
    return { content: [{ type: "text", text: "Record hold: released" }] };
  }
  if (recordId === "protocol-error") throw new Error("Synthetic MCP protocol failure");
  if (recordId === "malformed") return { content: "bad" };
  if (recordId === "structured") return {
    content: [], structuredContent: { record_id: "structured", value: 7 },
  };
  if (recordId === "go-down") {
    // Answers this call, then behaves as a server that stopped right after.
    down = true;
    return { content: [{ type: "text", text: "Record go-down: local MCP result" }] };
  }
  if (recordId === "two-parts") return {
    content: [{ type: "text", text: "first" }, { type: "text", text: "second" }],
  };
  return { content: [{ type: "text", text: `Record ${recordId}: local MCP result` }] };
});
const transport = new WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
  enableJsonResponse: true,
});
await server.connect(transport);

const http = createServer(async (incoming, outgoing) => {
  const pathname = new URL(incoming.url ?? "/", `http://127.0.0.1:${port}`).pathname;
  if (pathname === "/status") {
    outgoing.setHeader("content-type", "application/json");
    outgoing.end(JSON.stringify({ revision, discoveryRequests, calls, lastCall, down, held: held.size, mcpRequests }));
    return;
  }
  if (pathname === "/restore" && incoming.method === "POST") {
    revision = 1;
    down = false;
    outgoing.end("restored");
    return;
  }
  if (pathname === "/release" && incoming.method === "POST") {
    for (const resolve of held) resolve();
    held.clear();
    outgoing.end("released");
    return;
  }
  if (pathname === "/drop" && incoming.method === "POST") {
    // Severs every open MCP connection mid-response, then refuses new ones:
    // what the host sees when the server process is killed during a call.
    down = true;
    for (const socket of sockets) socket.destroy();
    for (const resolve of held) resolve();
    held.clear();
    outgoing.end("dropped");
    return;
  }
  if (pathname === "/change" && incoming.method === "POST") {
    revision = 2;
    outgoing.end("changed");
    return;
  }
  if (pathname === "/mcp") mcpRequests++;
  if (down && pathname === "/mcp") {
    incoming.socket.destroy();
    return;
  }
  if (pathname !== "/mcp") {
    outgoing.statusCode = 404;
    outgoing.end("not found");
    return;
  }
  sockets.add(incoming.socket);
  outgoing.on("close", () => sockets.delete(incoming.socket));
  try {
    const request = new Request(`http://127.0.0.1:${port}${incoming.url}`, {
      method: incoming.method,
      headers: incoming.headers,
      ...(incoming.method === "GET" || incoming.method === "HEAD" ? {} : { body: incoming, duplex: "half" }),
    });
    const response = await transport.handleRequest(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body).pipe(outgoing);
    else outgoing.end();
  } catch {
    outgoing.statusCode = 500;
    outgoing.end("fixture error");
  }
});
http.listen(port, "127.0.0.1", () => {
  process.stdout.write(`MCP discovery fixture at http://127.0.0.1:${port}/mcp\n`);
});
process.on("SIGTERM", () => http.close(() => process.exit(0)));
