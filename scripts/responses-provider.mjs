import { createServer } from "node:http";

import { stopOnSignal } from "./fixture-shutdown.mjs";

/**
 * Speaks just enough of the OpenAI Responses API to drive Inference Lens
 * through it, and refuses anything shaped like chat completions.
 *
 * The refusals are the point. A run that silently fell back to
 * `/chat/completions`, sent `messages` instead of `input`, or let the provider
 * keep the conversation (`store` not false) would otherwise pass against a
 * fixture that answers anything. Here each of those is a 400 or a 404 the UI
 * has to show.
 */

const host = "127.0.0.1";
const port = Number.parseInt(process.env.INFERENCE_LENS_RESPONSES_PORT ?? "4026", 10);

/** Streams a reasoning summary, then an answer, then usage with cached and reasoning tokens. */
const textModel = "responses-text-model";
const textAnswer = "Responses fixture answer: 2 + 2 = 4.";
const reasoningSummary = "Adding two and two.";
const textUsage = {
  input_tokens: 9,
  input_tokens_details: { cached_tokens: 3 },
  output_tokens: 14,
  output_tokens_details: { reasoning_tokens: 5 },
  total_tokens: 23,
};

/**
 * Calls `get_weather` once, then answers with the tool output it was sent.
 * The second turn is refused unless it carries the call and its output under
 * the same `call_id`, which is what a stateless Responses turn must do.
 */
const toolModel = "responses-tool-model";
const toolName = "get_weather";
const toolCallId = "call_weather_1";
const toolArguments = '{"city":"Chicago"}';

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function refuse(response, message) {
  response.writeHead(400, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { type: "invalid_request_error", message } }));
  console.log(`refused: ${message}`);
}

/** Problems with the request shape every model requires. */
function shapeProblem(body) {
  if ("messages" in body) return "Expected `input`, not chat-completions `messages`.";
  if (!Array.isArray(body.input)) return "Expected `input` to be an array of items.";
  if (body.store !== false) return "Expected `store: false`; this fixture keeps nothing.";
  if ("stream_options" in body) return "`stream_options` is a chat-completions field.";
  if (typeof body.stream !== "boolean") return "Expected a boolean `stream`.";
  return undefined;
}

function responseObject(output, usage) {
  return {
    id: "resp_fixture",
    object: "response",
    status: "completed",
    output,
    ...(usage ? { usage } : {}),
  };
}

function writeEvents(response, events) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
  });
  for (const event of events) {
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  response.end();
}

function textReply(response, stream) {
  const reasoning = {
    type: "reasoning",
    id: "rs_fixture",
    summary: [{ type: "summary_text", text: reasoningSummary }],
  };
  const message = {
    type: "message",
    id: "msg_fixture",
    role: "assistant",
    content: [{ type: "output_text", text: textAnswer }],
  };
  if (!stream) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(responseObject([reasoning, message], textUsage)));
    return;
  }
  const half = Math.ceil(textAnswer.length / 2);
  writeEvents(response, [
    { type: "response.created", response: { id: "resp_fixture", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { ...reasoning, summary: [] } },
    { type: "response.reasoning_summary_text.delta", item_id: "rs_fixture", output_index: 0, summary_index: 0, delta: "Adding two " },
    { type: "response.reasoning_summary_text.delta", item_id: "rs_fixture", output_index: 0, summary_index: 0, delta: "and two." },
    { type: "response.output_item.done", output_index: 0, item: reasoning },
    { type: "response.output_item.added", output_index: 1, item: { ...message, content: [] } },
    { type: "response.output_text.delta", item_id: "msg_fixture", output_index: 1, content_index: 0, delta: textAnswer.slice(0, half) },
    { type: "response.output_text.delta", item_id: "msg_fixture", output_index: 1, content_index: 0, delta: textAnswer.slice(half) },
    { type: "response.output_item.done", output_index: 1, item: message },
    { type: "response.completed", response: responseObject([reasoning, message], textUsage) },
  ]);
}

function toolReply(response, body) {
  const exposed = (body.tools ?? []).filter((tool) => tool?.type === "function");
  const weather = exposed.find((tool) => tool.name === toolName);
  if (!weather) {
    refuse(response, `Expected a top-level function tool named ${toolName}; received ${JSON.stringify(exposed.map((tool) => tool.name))}.`);
    return;
  }
  if (weather.strict !== false) {
    refuse(response, "Expected `strict: false` on a schema that is not strict-compatible.");
    return;
  }
  const outputs = body.input.filter((item) => item?.type === "function_call_output");
  if (outputs.length === 0) {
    const call = { type: "function_call", id: "fc_fixture", call_id: toolCallId, name: toolName, arguments: toolArguments };
    if (!body.stream) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(responseObject([call], { input_tokens: 6, output_tokens: 4, total_tokens: 10 })));
      return;
    }
    writeEvents(response, [
      { type: "response.created", response: { id: "resp_fixture", status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_fixture", output_index: 0, delta: toolArguments.slice(0, 9) },
      { type: "response.function_call_arguments.delta", item_id: "fc_fixture", output_index: 0, delta: toolArguments.slice(9) },
      { type: "response.output_item.done", output_index: 0, item: call },
      { type: "response.completed", response: responseObject([call], { input_tokens: 6, output_tokens: 4, total_tokens: 10 }) },
    ]);
    return;
  }
  const call = body.input.find((item) => item?.type === "function_call" && item.call_id === toolCallId);
  const output = outputs.find((item) => item.call_id === toolCallId);
  if (!call || !output) {
    refuse(response, `Expected the function_call and its function_call_output under call_id ${toolCallId}.`);
    return;
  }
  const answer = `Chicago report: ${output.output}`;
  const message = { type: "message", id: "msg_tool", role: "assistant", content: [{ type: "output_text", text: answer }] };
  if (!body.stream) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(responseObject([message])));
    return;
  }
  writeEvents(response, [
    { type: "response.output_item.added", output_index: 0, item: { ...message, content: [] } },
    { type: "response.output_text.delta", item_id: "msg_tool", output_index: 0, content_index: 0, delta: answer },
    { type: "response.completed", response: responseObject([message]) },
  ]);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);

  if (request.method === "GET" && url.pathname === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      object: "list",
      data: [{ id: textModel, object: "model" }, { id: toolModel, object: "model" }],
    }));
    return;
  }

  if (request.method !== "POST" || url.pathname !== "/v1/responses") {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end(`Not found: this fixture serves only /v1/responses, not ${url.pathname}.`);
    return;
  }

  let body;
  try {
    body = await readJson(request);
  } catch {
    refuse(response, "Invalid JSON.");
    return;
  }
  const problem = shapeProblem(body);
  if (problem) {
    refuse(response, problem);
    return;
  }
  if (body.model === toolModel) {
    toolReply(response, body);
  } else {
    textReply(response, body.stream);
  }
  console.log(`served ${body.model} (${body.stream ? "streaming" : "buffered"})`);
});

stopOnSignal(server);

server.listen(port, host, () => {
  console.log(`Responses provider listening at http://${host}:${port}/v1`);
});
