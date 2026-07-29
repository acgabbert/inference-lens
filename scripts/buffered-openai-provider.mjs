import { createServer } from "node:http";

const host = "127.0.0.1";
const port = Number.parseInt(
  process.env.INFERENCE_LENS_BUFFERED_PORT ?? "4014",
  10,
);
const answer = "Buffered fixture response: 2 + 2 = 4.";

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);

  if (request.method === "GET" && url.pathname === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      object: "list",
      data: [{ id: "buffered-test-model", object: "model" }],
    }));
    return;
  }

  if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("Not found.");
    return;
  }

  let body;
  try {
    body = await readJson(request);
  } catch {
    response.writeHead(400, { "content-type": "text/plain" });
    response.end("Invalid JSON.");
    return;
  }
  if (body.stream !== false || "stream_options" in body) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({
      error: "Expected stream=false with no stream_options.",
    }));
    return;
  }

  response.writeHead(200, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify({
    id: "chatcmpl-buffered-fixture",
    object: "chat.completion",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: answer,
      },
      finish_reason: "stop",
    }],
    usage: {
      prompt_tokens: 4,
      completion_tokens: 7,
      total_tokens: 11,
    },
  }));
  console.log("served buffered response with 4 input, 7 output, 11 total tokens");
});

server.listen(port, host, () => {
  console.log(
    `Buffered provider listening at http://${host}:${port}/v1`,
  );
});
