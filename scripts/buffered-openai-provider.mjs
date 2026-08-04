import { createServer } from "node:http";

const host = "127.0.0.1";
const port = Number.parseInt(
  process.env.INFERENCE_LENS_BUFFERED_PORT ?? "4014",
  10,
);
const ordinaryAnswer = "Buffered fixture response: 2 + 2 = 4.";
const providerDefaultModel = "provider-default-temperature-model";
const providerDefaultAnswer = "Provider received no temperature override.";
// Answers with the temperature it was actually sent, so a UI control that sets
// one can be checked against the wire rather than against its own readout.
const echoTemperatureModel = "echo-temperature-model";
/**
 * Answers with LaTeX in both delimiter forms. The subscripts and the `\\` line
 * break are the payload: the inline escape and emphasis rules destroy exactly
 * those characters, so a rendering that shows them back proves the math was
 * captured verbatim rather than run through the ordinary inline parser.
 */
const mathModel = "math-output-model";
/**
 * Emits one tool call, then answers using whatever result came back.
 *
 * Two things make this checkable rather than merely plausible. It refuses a
 * request that does not actually carry `get_weather` in `tools`, so a run where
 * the tool never reached the wire fails here instead of passing against an
 * empty manifest. And the second turn echoes the tool message verbatim, so the
 * final answer states exactly which executor produced the result — a mocked run
 * and a hand-typed one are distinguishable in the output itself.
 */
const toolCallingModel = "tool-calling-model";
const toolName = "get_weather";
const toolArguments = '{"city":"Chicago"}';
const mathAnswer = [
  String.raw`Given \( x_1 + y_2 \), we get:`,
  "",
  String.raw`\[`,
  String.raw`\begin{align}`,
  String.raw`a_1 &= b_1 \\`,
  String.raw`a_2 &= b_2`,
  String.raw`\end{align}`,
  String.raw`\]`,
].join("\n");

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
      data: [
        { id: "buffered-test-model", object: "model" },
        { id: providerDefaultModel, object: "model" },
        { id: echoTemperatureModel, object: "model" },
        { id: mathModel, object: "model" },
        { id: toolCallingModel, object: "model" },
      ],
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
  if (body.model === providerDefaultModel && "temperature" in body) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({
      error: "Expected the temperature field to be omitted.",
    }));
    return;
  }

  if (body.model === toolCallingModel) {
    const exposed = (body.tools ?? []).map((tool) => tool?.function?.name);
    if (!exposed.includes(toolName)) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: `Expected ${toolName} in tools; received ${JSON.stringify(exposed)}.`,
      }));
      console.log(`refused a tool-calling request without ${toolName}`);
      return;
    }
    const supplied = body.messages.filter(({ role }) => role === "tool");
    const message = supplied.length === 0
      ? {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_weather_1",
            type: "function",
            function: { name: toolName, arguments: toolArguments },
          }],
        }
      : {
          role: "assistant",
          content: `Chicago report: ${supplied.map(({ content }) => content).join(" ")}`,
        };
    response.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify({
      id: "chatcmpl-tool-calling-fixture",
      object: "chat.completion",
      choices: [{
        index: 0,
        message,
        finish_reason: supplied.length === 0 ? "tool_calls" : "stop",
      }],
      usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
    }));
    console.log(
      supplied.length === 0
        ? `served a ${toolName} call`
        : `served an answer from ${supplied.length} tool result(s)`,
    );
    return;
  }

  const answer = body.model === providerDefaultModel
    ? providerDefaultAnswer
    : body.model === echoTemperatureModel
      ? `Provider received temperature ${"temperature" in body ? String(body.temperature) : "absent"}.`
      : body.model === mathModel
        ? mathAnswer
        : ordinaryAnswer;

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
  console.log(
    body.model === providerDefaultModel
      ? "served provider-default response with no temperature override"
      : body.model === echoTemperatureModel
        ? `served echoed temperature ${"temperature" in body ? String(body.temperature) : "absent"}`
        : body.model === mathModel
          ? "served LaTeX answer in both delimiter forms"
          : "served buffered response with 4 input, 7 output, 11 total tokens",
  );
});

server.listen(port, host, () => {
  console.log(
    `Buffered provider listening at http://${host}:${port}/v1`,
  );
});
