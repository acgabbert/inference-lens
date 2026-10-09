import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A chat-completions provider that asks for one tool call, then answers with
 * whatever the tool returned. The final answer can only contain the tool's
 * text if a real result reached the provider, so a check on it is evidence
 * the grant served the call rather than a mock or nothing.
 */
export async function toolCallingProvider(call: { name: string; arguments: Record<string, unknown> }) {
  const requests: Array<{ messages: Array<{ role: string; content?: unknown }> }> = [];
  const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    const toolMessage = body.messages.find(({ role }: { role: string }) => role === "tool");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: `chatcmpl-${requests.length}`,
      object: "chat.completion",
      choices: [toolMessage
        ? { index: 0, message: { role: "assistant", content: `The tool said: ${JSON.stringify(toolMessage.content)}` }, finish_reason: "stop" }
        : {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "call_1", type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }],
            },
            finish_reason: "tool_calls",
          }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
