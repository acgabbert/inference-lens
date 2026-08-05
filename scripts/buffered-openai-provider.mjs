import { createServer } from "node:http";

import { stopOnSignal } from "./fixture-shutdown.mjs";

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
/**
 * Never stops asking for the tool, however many results it is given.
 *
 * A model that eventually answers cannot demonstrate a turn ceiling: the run
 * would end on its own and the bound would never be reached. This one makes the
 * ceiling the only thing that can stop the loop, which is the situation the
 * cost bound exists for.
 */
const loopingToolModel = "looping-tool-model";
/**
 * Answers correctly, but slowly enough that a batch is still running while a
 * spec navigates somewhere else.
 *
 * "The batch finished while you were looking at another mode" is not reachable
 * against a fixture that answers instantly: the run is over before the click
 * lands, and the spec would silently test the already-read path instead. The
 * delay is per call, so a two-case batch takes roughly twice it.
 */
const slowModel = "slow-answer-model";
const slowAnswerDelayMs = Number.parseInt(
  process.env.INFERENCE_LENS_BUFFERED_SLOW_DELAY_MS ?? "700",
  10,
);
/**
 * As slow as `slowModel`, but answers with text the ordinary `contains` check
 * will not match, so a batch can be made to finish *and* fail while a spec is
 * somewhere else. Both dimensions are needed together: a fast failure is over
 * before the navigation lands, and a slow success proves nothing about how a
 * failure is reported.
 */
const slowFailingModel = "slow-failing-answer-model";
/**
 * Slow, and satisfies the check only for a prompt mentioning "migrations".
 *
 * A batch where some cases pass and some fail is the state a single "finished"
 * signal reports most misleadingly, so it needs to be producible on purpose
 * rather than only by accident.
 */
const slowPartialModel = "slow-partial-answer-model";
const partialPassPhrase = "migrations";
const failingAnswer = "This response deliberately mentions nothing expected.";
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
        { id: slowModel, object: "model" },
        { id: slowFailingModel, object: "model" },
        { id: slowPartialModel, object: "model" },
        { id: providerDefaultModel, object: "model" },
        { id: echoTemperatureModel, object: "model" },
        { id: mathModel, object: "model" },
        { id: toolCallingModel, object: "model" },
        { id: loopingToolModel, object: "model" },
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

  if (body.model === toolCallingModel || body.model === loopingToolModel) {
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
    const message = supplied.length === 0 || body.model === loopingToolModel
      ? {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: `call_weather_${supplied.length + 1}`,
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
        finish_reason: message.tool_calls ? "tool_calls" : "stop",
      }],
      usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
    }));
    console.log(
      message.tool_calls
        ? `served a ${toolName} call (${supplied.length} result(s) so far)`
        : `served an answer from ${supplied.length} tool result(s)`,
    );
    return;
  }

  const slowAnswer = body.model === slowModel
    || body.model === slowFailingModel
    || body.model === slowPartialModel;
  if (slowAnswer) {
    await new Promise((resolve) => setTimeout(resolve, slowAnswerDelayMs));
  }

  const answer = body.model === providerDefaultModel
    ? providerDefaultAnswer
    : body.model === echoTemperatureModel
      ? `Provider received temperature ${"temperature" in body ? String(body.temperature) : "absent"}.`
      : body.model === mathModel
        ? mathAnswer
        : body.model === slowFailingModel
          ? failingAnswer
          : body.model === slowPartialModel
            ? (JSON.stringify(body.messages).includes(partialPassPhrase)
                ? ordinaryAnswer
                : failingAnswer)
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
          : body.model === slowModel
            ? `served a deliberately slow answer after ${slowAnswerDelayMs}ms`
            : body.model === slowFailingModel
              ? "served a slow answer that fails an ordinary contains check"
              : body.model === slowPartialModel
                ? `served a slow answer that passes only for "${partialPassPhrase}"`
              : "served buffered response with 4 input, 7 output, 11 total tokens",
  );
});

stopOnSignal(server);

server.listen(port, host, () => {
  console.log(
    `Buffered provider listening at http://${host}:${port}/v1`,
  );
});
