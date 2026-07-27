import { createServer } from "node:http";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.INFERENCE_LENS_MARKDOWN_PORT ?? "4013", 10);
const deltaMs = Number.parseInt(
  process.env.INFERENCE_LENS_MARKDOWN_DELTA_MS ?? "90",
  10,
);

/**
 * Every block kind the renderer supports, split so that fences and list items
 * straddle chunk boundaries. A parser that only ever sees whole blocks is not
 * being tested by a stream.
 */
const deltas = [
  "## Caching\n\nA cache trades ",
  "**memory** for *latency*.\n\n",
  "- Reads hit `memory` first\n",
  "- Misses fall through to the database\n\n",
  "```ts\nconst hit = cache.get(key)",
  ";\nif (!hit) cache.set(key, load(key));\n```\n\n",
  "> A stale read is a correctness bug, not a performance one.\n\n",
  "| Layer | Latency |\n| --- | --- |\n",
  "| Cache | 1 ms |\n| Database | 40 ms |\n\n",
  "See [the docs](https://example.com/caching) for eviction policies.\n",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chunk(content, finishReason = null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-markdown",
    object: "chat.completion.chunk",
    choices: [
      {
        index: 0,
        delta: content ? { content } : {},
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
        data: [{ id: "markdown-test-model", object: "model" }],
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
  for (const delta of deltas) {
    response.write(chunk(delta));
    await sleep(deltaMs);
  }
  response.write(chunk("", "stop"));
  response.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-markdown",
      object: "chat.completion.chunk",
      choices: [],
      usage: {
        prompt_tokens: 12,
        completion_tokens: deltas.length,
        total_tokens: 12 + deltas.length,
      },
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
  console.log(`streamed ${deltas.length} markdown deltas`);
});

server.listen(port, host, () => {
  console.log(`Markdown provider listening at http://${host}:${port}/v1`);
});
