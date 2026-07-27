import { createServer } from "node:http";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.INFERENCE_LENS_FLAKY_PORT ?? "4010", 10);
let chatRequestCount = 0;
let firstRequestBody;

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);

  if (request.method === "GET" && url.pathname === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      object: "list",
      data: [{ id: "flaky-test-model", object: "model" }],
    }));
    return;
  }

  if (request.method === "POST" && url.pathname === "/reset") {
    chatRequestCount = 0;
    firstRequestBody = undefined;
    response.writeHead(204);
    response.end();
    console.log("Flaky provider reset.");
    return;
  }

  if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("Not found.");
    return;
  }

  const body = await readBody(request);
  chatRequestCount += 1;
  if (chatRequestCount === 1) {
    firstRequestBody = body;
    response.writeHead(503, {
      "content-type": "text/plain",
      "retry-after": "1",
    });
    response.end("Intentional first-attempt failure.");
    console.log("Attempt 1: returned HTTP 503.");
    return;
  }

  const bodyMatches = body === firstRequestBody;
  console.log(
    `Attempt ${chatRequestCount}: request body ${bodyMatches ? "matches" : "DOES NOT MATCH"} attempt 1.`,
  );
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  response.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-flaky-test",
      object: "chat.completion.chunk",
      choices: [{
        index: 0,
        delta: { content: "Recovered on retry." },
        finish_reason: null,
      }],
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-flaky-test",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
});

server.listen(port, host, () => {
  console.log(`Flaky OpenAI-compatible provider listening at http://${host}:${port}/v1`);
  console.log("The first chat request returns 503; later identical requests succeed.");
  console.log(`Reset with: curl -X POST http://${host}:${port}/reset`);
});
