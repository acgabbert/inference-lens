import { createServer } from "node:http";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.INFERENCE_LENS_ECHO_PORT ?? "4012", 10);

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function chunk(content, finishReason = null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-template-echo",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }],
  })}\n\n`;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);

  if (request.method === "GET" && url.pathname === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      object: "list",
      data: [{ id: "template-echo-model", object: "model" }],
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

  const received = Array.isArray(body.messages)
    ? body.messages
        .map((message) => `${message.role}=${JSON.stringify(message.content)}`)
        .join(" | ")
    : "messages=missing";
  const answer = `Fixture received ${received}`;

  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  response.write(chunk(answer));
  response.write(chunk("", "stop"));
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-template-echo",
    object: "chat.completion.chunk",
    choices: [],
    usage: {
      prompt_tokens: body.messages?.length ?? 0,
      completion_tokens: answer.split(/\s+/).length,
      total_tokens:
        (body.messages?.length ?? 0) + answer.split(/\s+/).length,
    },
  })}\n\n`);
  response.end("data: [DONE]\n\n");
  console.log(answer);
});

server.listen(port, host, () => {
  console.log(
    `Template echo provider listening at http://${host}:${port}/v1`,
  );
});
