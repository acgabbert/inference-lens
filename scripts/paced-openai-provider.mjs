import { createServer } from "node:http";

/**
 * A fixture with deliberate, known timing. The stall before the first byte and
 * the fixed gap between content deltas make time-to-first-token and
 * generation-phase throughput predictable, so derived run metrics can be
 * checked against numbers set here rather than against whatever a real
 * provider happened to do.
 */
const host = "127.0.0.1";
const port = Number.parseInt(process.env.INFERENCE_LENS_PACED_PORT ?? "4011", 10);
const firstByteDelayMs = Number.parseInt(
  process.env.INFERENCE_LENS_PACED_FIRST_BYTE_MS ?? "600",
  10,
);
const deltaIntervalMs = Number.parseInt(
  process.env.INFERENCE_LENS_PACED_DELTA_MS ?? "120",
  10,
);

const words = [
  "The ", "first ", "sunrise ", "on ", "Mars ",
  "is ", "pale ", "and ", "cold.",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Drains the request body. Its contents do not affect this fixture. */
async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function chunk(payload) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-paced-test",
    object: "chat.completion.chunk",
    ...payload,
  })}\n\n`;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);

  if (request.method === "GET" && url.pathname === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      object: "list",
      data: [{ id: "paced-test-model", object: "model" }],
    }));
    return;
  }

  if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("Not found.");
    return;
  }

  await readBody(request);

  await sleep(firstByteDelayMs);
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });

  for (const word of words) {
    await sleep(deltaIntervalMs);
    response.write(
      chunk({
        choices: [{ index: 0, delta: { content: word }, finish_reason: null }],
      }),
    );
  }

  response.write(
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
  );
  // Usage arrives in its own trailing chunk, the way providers report it when
  // stream_options.include_usage is set.
  response.write(
    chunk({
      choices: [],
      usage: {
        prompt_tokens: 187,
        completion_tokens: words.length,
        total_tokens: 187 + words.length,
      },
    }),
  );
  response.end("data: [DONE]\n\n");

  const generationMs = deltaIntervalMs * words.length;
  console.log(
    `Streamed ${words.length} deltas after a ${firstByteDelayMs} ms stall; ` +
      `expect roughly ${(words.length / (generationMs / 1000)).toFixed(1)} tok/s.`,
  );
});

server.listen(port, host, () => {
  console.log(`Paced OpenAI-compatible provider listening at http://${host}:${port}/v1`);
  console.log(
    `First byte after ${firstByteDelayMs} ms; one delta every ${deltaIntervalMs} ms; reports usage.`,
  );
});
