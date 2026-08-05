import { createServer } from "node:http";

import { stopOnSignal } from "./fixture-shutdown.mjs";

const host = process.env.INFERENCE_LENS_N8N_ECHO_HOST ?? "127.0.0.1";
const port = Number.parseInt(
  process.env.INFERENCE_LENS_N8N_ECHO_PORT ?? "4013",
  10,
);
const maxRequestBytes = 1024 * 1024;

async function readJson(request) {
  const chunks = [];
  let received = 0;
  for await (const chunk of request) {
    received += chunk.byteLength;
    if (received > maxRequestBytes) throw new Error("Request too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function echoText(body) {
  if (!Array.isArray(body.messages)) return "messages=missing";
  return body.messages
    .map((message) => `${message.role}=${JSON.stringify(message.content)}`)
    .join(" | ");
}

function completion(body, content) {
  return {
    id: "chatcmpl-inference-lens-n8n-fixture",
    object: "chat.completion",
    created: 0,
    model: body.model ?? "template-echo-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: body.messages?.length ?? 0,
      completion_tokens: content.split(/\s+/).length,
      total_tokens:
        (body.messages?.length ?? 0) + content.split(/\s+/).length,
    },
  };
}

function streamChunk(content, finishReason = null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-inference-lens-n8n-fixture",
    object: "chat.completion.chunk",
    created: 0,
    model: "template-echo-model",
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
        data: [{ id: "template-echo-model", object: "model", created: 0 }],
      }),
    );
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

  const content = `Fixture received ${echoText(body)}`;
  if (body.stream !== true) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(completion(body, content)));
    return;
  }

  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  response.write(streamChunk(content));
  response.write(streamChunk("", "stop"));
  response.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-inference-lens-n8n-fixture",
      object: "chat.completion.chunk",
      created: 0,
      model: body.model ?? "template-echo-model",
      choices: [],
      usage: completion(body, content).usage,
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
});

stopOnSignal(server);

server.listen(port, host, () => {
  console.log(`n8n fixture echo provider listening on ${host}:${port}`);
});
