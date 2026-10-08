import { createServer } from "node:http";

import { stopOnSignal } from "./fixture-shutdown.mjs";

/**
 * Speaks just enough of the native Anthropic Messages API to drive Inference
 * Lens through it, and refuses what an OpenAI-shaped client would send.
 *
 * Every request must carry `x-api-key: fixture-anthropic-key` and
 * `anthropic-version`, and must not carry `Authorization`, so a run that sent
 * its key the OpenAI way fails visibly. Bodies must have `max_tokens`, no
 * `role: "tool"` messages, and no `stream_options`. Only `/v1/messages`,
 * `/v1/models` (which also needs the key), and a `/health` probe exist.
 */

const host = "127.0.0.1";
const port = Number.parseInt(process.env.INFERENCE_LENS_ANTHROPIC_PORT ?? "4027", 10);
const fixtureKey = "fixture-anthropic-key";

/** Thinks, answers, and reports cache usage. */
const textModel = "claude-fixture-text";
const textAnswer = "Anthropic fixture answer: 2 + 2 = 4.";
const thinking = "Adding two and two.";
/** Calls get_weather once, then answers from the tool_result it was sent. */
const toolModel = "claude-fixture-tool";
const toolUseId = "toolu_fixture_1";

function refuse(response, status, message) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }));
  console.log(`refused: ${message}`);
}

function credentialProblem(request) {
  if (request.headers.authorization) return "Send the key as x-api-key, not Authorization.";
  if (request.headers["x-api-key"] !== fixtureKey) return "Missing or wrong x-api-key.";
  if (!request.headers["anthropic-version"]) return "Missing anthropic-version header.";
  return undefined;
}

function shapeProblem(body) {
  if (!Array.isArray(body.messages)) return "Expected a messages array.";
  if (typeof body.max_tokens !== "number") return "max_tokens is required.";
  if ("stream_options" in body) return "stream_options is not a Messages field.";
  if (body.messages.some((message) => message.role === "tool")) return "Tool results belong in a user message.";
  if (body.messages[0]?.role === "system") return "Leading system text belongs in `system`.";
  return undefined;
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function reply(response, stream, content, stopReason, usage) {
  const message = {
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    model: "fixture",
    content,
    stop_reason: stopReason,
    usage,
  };
  if (!stream) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(message));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  const send = (event) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  send({
    type: "message_start",
    message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 1 } },
  });
  content.forEach((block, index) => {
    if (block.type === "text") {
      send({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      const half = Math.ceil(block.text.length / 2);
      send({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text.slice(0, half) } });
      send({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text.slice(half) } });
    } else if (block.type === "thinking") {
      send({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } });
      send({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } });
      send({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } });
    } else if (block.type === "tool_use") {
      send({ type: "content_block_start", index, content_block: { ...block, input: {} } });
      const json = JSON.stringify(block.input);
      send({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(0, 5) } });
      send({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(5) } });
    }
    send({ type: "content_block_stop", index });
    send({ type: "ping" });
  });
  send({ type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: usage.output_tokens } });
  send({ type: "message_stop" });
  response.end();
}

function toolReply(response, body) {
  if (!(body.tools ?? []).some((tool) => tool.name === "get_weather" && tool.input_schema)) {
    refuse(response, 400, "Expected a get_weather tool with input_schema.");
    return;
  }
  const results = body.messages.flatMap((message) =>
    Array.isArray(message.content) ? message.content.filter((block) => block.type === "tool_result") : []);
  if (results.length === 0) {
    reply(response, body.stream, [
      { type: "tool_use", id: toolUseId, name: "get_weather", input: { city: "Chicago" } },
    ], "tool_use", { input_tokens: 6, output_tokens: 4 });
    return;
  }
  const call = body.messages.some((message) => message.role === "assistant" &&
    Array.isArray(message.content) &&
    message.content.some((block) => block.type === "tool_use" && block.id === toolUseId));
  const result = results.find((block) => block.tool_use_id === toolUseId);
  if (!call || !result) {
    refuse(response, 400, `Expected the tool_use and its tool_result under ${toolUseId}.`);
    return;
  }
  reply(response, body.stream, [{ type: "text", text: `Chicago report: ${result.content}` }], "end_turn", { input_tokens: 9, output_tokens: 5 });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  // Readiness probes poll this rather than the listing, which needs a key.
  if (request.method === "GET" && url.pathname === "/health") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/models") {
    const problem = credentialProblem(request);
    if (problem) {
      refuse(response, 401, problem);
      return;
    }
    if (url.searchParams.get("limit") !== "1000") {
      refuse(response, 400, "Expected limit=1000 so one page holds the catalogue.");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      data: [
        { id: textModel, type: "model", display_name: "Fixture text" },
        { id: toolModel, type: "model", display_name: "Fixture tool" },
      ],
      has_more: false,
    }));
    return;
  }
  if (request.method !== "POST" || url.pathname !== "/v1/messages") {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end(`Not found: this fixture serves only /v1/messages, not ${url.pathname}.`);
    return;
  }
  const credential = credentialProblem(request);
  if (credential) {
    refuse(response, 401, credential);
    return;
  }
  let body;
  try {
    body = await readJson(request);
  } catch {
    refuse(response, 400, "Invalid JSON.");
    return;
  }
  const problem = shapeProblem(body);
  if (problem) {
    refuse(response, 400, problem);
    return;
  }
  if (body.model === toolModel) {
    toolReply(response, body);
  } else {
    reply(response, body.stream, [
      { type: "thinking", thinking, signature: "fixture-signature" },
      { type: "text", text: textAnswer },
    ], "end_turn", { input_tokens: 4, cache_read_input_tokens: 6, cache_creation_input_tokens: 0, output_tokens: 11 });
  }
  console.log(`served ${body.model} (${body.stream ? "streaming" : "buffered"})`);
});

stopOnSignal(server);

server.listen(port, host, () => {
  console.log(`Anthropic provider listening at http://${host}:${port}/v1`);
});
