import { createServer } from "node:http";

import { stopOnSignal } from "./fixture-shutdown.mjs";

// Exercises the model picker's favorites feature against a catalogue the
// size OpenRouter actually returns (300+ models), where a flat list is
// unusable. Chat completions are not the point of this fixture — it answers
// with a fixed line so a run can still complete — /v1/models is.
const host = "127.0.0.1";
const port = Number.parseInt(
  process.env.INFERENCE_LENS_LARGE_CATALOGUE_PORT ?? "4017",
  10,
);

const vendors = [
  "openai",
  "anthropic",
  "google",
  "meta-llama",
  "mistralai",
  "cohere",
  "deepseek",
  "qwen",
  "x-ai",
  "nvidia",
];
const families = [
  "gpt-4o",
  "gpt-4.1",
  "o3",
  "o4-mini",
  "claude-3.5-sonnet",
  "claude-3-opus",
  "claude-3-haiku",
  "gemini-2.0-flash",
  "gemini-1.5-pro",
  "llama-3.3-70b",
  "llama-3.1-8b",
  "mixtral-8x22b",
  "command-r-plus",
  "deepseek-v3",
  "deepseek-r1",
  "qwen2.5-72b",
  "grok-2",
  "nemotron-70b",
];

const models = [];
for (const vendor of vendors) {
  for (const family of families) {
    models.push({ id: `${vendor}/${family}`, object: "model" });
  }
}
// families × vendors = 180; pad with numbered variants to comfortably clear
// the "300+" scale named in the motivating OpenRouter comparison.
let padIndex = 0;
while (models.length < 320) {
  const vendor = vendors[padIndex % vendors.length];
  models.push({
    id: `${vendor}/experimental-${String(padIndex).padStart(3, "0")}`,
    object: "model",
  });
  padIndex += 1;
}

function chunk(content, finishReason = null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-large-catalogue",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }],
  })}\n\n`;
}

async function readJson(request) {
  const chunks = [];
  for await (const part of request) chunks.push(part);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);

  if (request.method === "GET" && url.pathname === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: models }));
    return;
  }

  if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("Not found.");
    return;
  }

  try {
    await readJson(request);
  } catch {
    response.writeHead(400, { "content-type": "text/plain" });
    response.end("Invalid JSON.");
    return;
  }

  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  response.write(chunk("Large-catalogue fixture reply."));
  response.write(chunk("", "stop"));
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-large-catalogue",
    object: "chat.completion.chunk",
    choices: [],
    usage: { prompt_tokens: 1, completion_tokens: 4, total_tokens: 5 },
  })}\n\n`);
  response.end("data: [DONE]\n\n");
});

stopOnSignal(server);

server.listen(port, host, () => {
  console.log(
    `Large-catalogue provider listening at http://${host}:${port}/v1 (${models.length} models)`,
  );
});
