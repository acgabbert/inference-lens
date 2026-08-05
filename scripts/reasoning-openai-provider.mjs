import { createServer } from "node:http";

import { stopOnSignal } from "./fixture-shutdown.mjs";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.INFERENCE_LENS_REASONING_PORT ?? "4014", 10);
const deltaMs = Number.parseInt(
  process.env.INFERENCE_LENS_REASONING_DELTA_MS ?? "90",
  10,
);

/**
 * Reasoning deltas, split so a fence and a list straddle chunk boundaries —
 * the same discipline as markdown-openai-provider.mjs, but for
 * `delta.reasoning_content`. Streamed entirely before the answer, matching how
 * a real reasoning model finishes thinking before writing.
 */
const reasoningDeltas = [
  "## Plan\n\nThe user wants ",
  "**caching** explained simply.\n\n",
  "- Start from the ",
  "one-line definition\n",
  "- Then note the tradeoff\n\n",
  "```text\nread: check cache -> else load, then store\n```\n",
];

const answerDeltas = [
  "A cache stores a **value** for reuse ",
  "so the next read skips the slow path.",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chunk(delta, finishReason = null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-reasoning",
    object: "chat.completion.chunk",
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  })}\n\n`;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);

  if (request.method === "GET" && url.pathname === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        object: "list",
        data: [{ id: "reasoning-test-model", object: "model" }],
      }),
    );
    return;
  }

  if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("Not found.");
    return;
  }

  // Drained even though the content is fixed: an unread body stalls the client.
  for await (const ignored of request) void ignored;

  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  for (const reasoning_content of reasoningDeltas) {
    response.write(chunk({ reasoning_content }));
    await sleep(deltaMs);
  }
  for (const content of answerDeltas) {
    response.write(chunk({ content }));
    await sleep(deltaMs);
  }
  response.write(chunk({}, "stop"));
  response.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-reasoning",
      object: "chat.completion.chunk",
      choices: [],
      usage: {
        prompt_tokens: 12,
        completion_tokens: answerDeltas.length,
        completion_tokens_details: { reasoning_tokens: reasoningDeltas.length },
        total_tokens: 12 + answerDeltas.length,
      },
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
  console.log(
    `streamed ${reasoningDeltas.length} reasoning deltas and ${answerDeltas.length} answer deltas`,
  );
});

stopOnSignal(server);

server.listen(port, host, () => {
  console.log(`Reasoning provider listening at http://${host}:${port}/v1`);
});
