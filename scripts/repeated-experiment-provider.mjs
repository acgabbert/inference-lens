import { createServer } from "node:http";

import { stopOnSignal } from "./fixture-shutdown.mjs";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.INFERENCE_LENS_REPEAT_PORT ?? "4016", 10);
let repetition = 0;

function chunk(content, finishReason = null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-repeated-experiment",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }],
  })}\n\n`;
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  if (request.method === "GET" && url.pathname === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: [{ id: "repeat-fixture-model", object: "model" }] }));
    return;
  }
  if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("Not found.");
    return;
  }

  repetition += 1;
  const answer = `Deterministic repetition ${repetition}`;
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  response.write(chunk(answer));
  response.write(chunk("", "stop"));
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-repeated-experiment",
    object: "chat.completion.chunk",
    choices: [],
    usage: { prompt_tokens: 3, completion_tokens: repetition, total_tokens: repetition + 3 },
  })}\n\n`);
  response.end("data: [DONE]\n\n");
  console.log(answer);
});

stopOnSignal(server);

server.listen(port, host, () => {
  console.log(`Repeated experiment fixture listening at http://${host}:${port}/v1`);
});
