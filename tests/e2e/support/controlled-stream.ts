import { createServer, type ServerResponse } from "node:http";

/** A real SSE provider: the test releases each delta after checking the UI. */
export async function controlledStream() {
  let response: ServerResponse | undefined;
  let requestBody: { stream?: boolean; model?: string } | undefined;
  const server = createServer(async (request, reply) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      reply.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    try {
      requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      reply.writeHead(400).end("Invalid JSON");
      return;
    }
    if (requestBody?.stream !== true) {
      reply.writeHead(400).end("Expected stream=true");
      return;
    }
    response = reply;
    reply.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    reply.flushHeaders();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1`,
    request: () => requestBody,
    send(text: string) {
      if (!response) throw new Error("No streaming request received");
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
    },
    finish() {
      if (!response) throw new Error("No streaming request received");
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
