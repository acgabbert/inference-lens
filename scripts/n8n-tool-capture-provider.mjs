#!/usr/bin/env node

import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { stopOnSignal } from "./fixture-shutdown.mjs";

const SCENARIOS = {
  "string-input": {
    sentinel: "IL_N0_STRING_INPUT",
    model: "template-echo-model",
    toolName: "il_echo_string",
    toolCallId: "call_inference_lens_n8n_001",
    arguments: '{"text":"IL_N0_STRING_VALUE"}',
    finalAnswer: "IL_N0_CAPTURE_COMPLETE",
    expectedResult: [{ fixture: "IL_N0_STRING_INPUT", echoed: "IL_N0_STRING_VALUE", receivedType: "string" }],
  },
  "primitive-inputs": {
    sentinel: "IL_N0_PRIMITIVE_INPUTS",
    model: "template-echo-model",
    toolName: "il_echo_primitives",
    toolCallId: "call_inference_lens_n8n_001",
    arguments: '{"text":"IL_N0_PRIMITIVE_TEXT","count":7,"enabled":true}',
    finalAnswer: "IL_N0_CAPTURE_COMPLETE",
    expectedResult: [{ fixture: "IL_N0_PRIMITIVE_INPUTS", values: { text: "IL_N0_PRIMITIVE_TEXT", count: 7, enabled: true }, types: { text: "string", count: "number", enabled: "boolean" } }],
  },
  "multiple-output-items": {
    sentinel: "IL_N0_MULTIPLE_OUTPUT_ITEMS",
    model: "template-echo-model",
    toolName: "il_multiple_items",
    toolCallId: "call_inference_lens_n8n_001",
    arguments: '{"topic":"IL_N0_MULTI_TOPIC"}',
    finalAnswer: "IL_N0_CAPTURE_COMPLETE",
    expectedResult: [
      { fixture: "IL_N0_MULTIPLE_OUTPUT_ITEMS", ordinal: 1, topic: "IL_N0_MULTI_TOPIC", value: "IL_N0_MULTI_FIRST" },
      { fixture: "IL_N0_MULTIPLE_OUTPUT_ITEMS", ordinal: 2, topic: "IL_N0_MULTI_TOPIC", value: "IL_N0_MULTI_SECOND" },
    ],
  },
  "fixed-and-ai-inputs": {
    sentinel: "IL_N0_FIXED_AND_AI",
    model: "template-echo-model",
    toolName: "il_fixed_and_ai",
    toolCallId: "call_inference_lens_n8n_001",
    arguments: '{"text":"IL_N0_AI_TEXT"}',
    finalAnswer: "IL_N0_CAPTURE_COMPLETE",
    expectedResult: [{ fixture: "IL_N0_FIXED_AND_AI", text: "IL_N0_AI_TEXT", source: "IL_N0_FIXED_SOURCE" }],
  },
  "empty-output": {
    sentinel: "IL_N0_EMPTY_OUTPUT",
    model: "template-echo-model",
    toolName: "il_empty_output",
    toolCallId: "call_inference_lens_n8n_001",
    arguments: '{"topic":"IL_N0_EMPTY_TOPIC"}',
    finalAnswer: "IL_N0_CAPTURE_COMPLETE",
    expectedResult: [],
  },
  "nested-inputs": {
    sentinel: "IL_N0_NESTED_INPUTS",
    model: "template-echo-model",
    toolName: "il_nested_inputs",
    toolCallId: "call_inference_lens_n8n_001",
    arguments: '{"payload":{"label":"IL_N0_NESTED_LABEL","count":3},"tags":["IL_N0_TAG_A","IL_N0_TAG_B"]}',
    finalAnswer: "IL_N0_CAPTURE_COMPLETE",
    expectedResult: [{ fixture: "IL_N0_NESTED_INPUTS", payload: { label: "IL_N0_NESTED_LABEL", count: 3 }, tags: ["IL_N0_TAG_A", "IL_N0_TAG_B"], types: { payload: "object", tagsIsArray: true } }],
  },
  "workflow-error": {
    sentinel: "IL_N0_WORKFLOW_ERROR",
    model: "template-echo-model",
    toolName: "il_workflow_error",
    toolCallId: "call_inference_lens_n8n_001",
    arguments: '{"reason":"IL_N0_EXPECTED_ERROR"}',
    finalAnswer: "IL_N0_CAPTURE_COMPLETE",
    expectedResult: null,
  },
  "rejected-arguments": {
    sentinel: "IL_N0_REJECTED_ARGUMENTS",
    model: "template-echo-model",
    toolName: "il_rejected_arguments",
    toolCallId: "call_inference_lens_n8n_001",
    arguments: '{"count":"IL_N0_NOT_A_NUMBER"}',
    finalAnswer: "IL_N0_CAPTURE_COMPLETE",
    expectedResult: null,
  },
  "multiple-attached-tools": {
    sentinel: "IL_N0_MULTIPLE_ATTACHED_TOOLS",
    model: "template-echo-model",
    toolName: "il_echo_string",
    expectedToolNames: ["il_echo_string", "il_echo_primitives"],
    toolCallId: "call_inference_lens_n8n_001",
    arguments: '{"text":"IL_N0_STRING_VALUE"}',
    finalAnswer: "IL_N0_CAPTURE_COMPLETE",
    expectedResult: [{ fixture: "IL_N0_STRING_INPUT", echoed: "IL_N0_STRING_VALUE", receivedType: "string" }],
  },
};

const CAPTURE_FILES = [
  "provider-request-initial.json",
  "provider-response-tool-call.json",
  "provider-request-continuation.json",
  "provider-response-final.json",
];

function positiveInteger(value, fallback, label) {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

const host = process.env.INFERENCE_LENS_N8N_TOOL_CAPTURE_HOST ?? "127.0.0.1";
const port = positiveInteger(
  process.env.INFERENCE_LENS_N8N_TOOL_CAPTURE_PORT,
  4014,
  "INFERENCE_LENS_N8N_TOOL_CAPTURE_PORT",
);
const scenarioId =
  process.env.INFERENCE_LENS_N8N_TOOL_CAPTURE_SCENARIO ?? "string-input";
const scenario = SCENARIOS[scenarioId];
if (!scenario) {
  throw new Error(
    `Unknown n8n tool capture scenario ${JSON.stringify(scenarioId)}. ` +
      `Choose one of: ${Object.keys(SCENARIOS).join(", ")}.`,
  );
}
const outputDirectory = path.resolve(
  process.env.INFERENCE_LENS_N8N_TOOL_CAPTURE_OUTPUT ??
    `.n8n-contract-staging/tool-provider-${scenarioId}`,
);
const maxRequestBytes = positiveInteger(
  process.env.INFERENCE_LENS_N8N_TOOL_CAPTURE_MAX_REQUEST_BYTES,
  2 * 1024 * 1024,
  "INFERENCE_LENS_N8N_TOOL_CAPTURE_MAX_REQUEST_BYTES",
);

const state = {
  phase: "awaiting-initial-request",
  requestCount: 0,
  problem: null,
  processing: false,
};

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJson(request) {
  const declaredLength = Number.parseInt(
    request.headers["content-length"] ?? "",
    10,
  );
  if (Number.isFinite(declaredLength) && declaredLength > maxRequestBytes) {
    throw new Error(`Request exceeds the ${maxRequestBytes}-byte limit.`);
  }

  const chunks = [];
  let received = 0;
  for await (const chunk of request) {
    received += chunk.byteLength;
    if (received > maxRequestBytes) {
      throw new Error(`Request exceeds the ${maxRequestBytes}-byte limit.`);
    }
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return { value: JSON.parse(text), text };
  } catch (error) {
    throw new Error("Request body must be valid JSON.", { cause: error });
  }
}

async function writeCapture(filename, value) {
  await writeFile(
    path.join(outputDirectory, filename),
    `${JSON.stringify(value, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
}

async function writeRequestCapture(filename, text) {
  await writeFile(path.join(outputDirectory, filename), text, {
    encoding: "utf8",
    flag: "wx",
  });
}

function usage(body, completionTokens = 1) {
  const promptTokens = Array.isArray(body.messages) ? body.messages.length : 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function toolCall() {
  return {
    id: scenario.toolCallId,
    type: "function",
    function: {
      name: scenario.toolName,
      arguments: scenario.arguments,
    },
  };
}

function toolCallCompletion(body) {
  return {
    id: "chatcmpl-inference-lens-n8n-tool-call",
    object: "chat.completion",
    created: 0,
    model: body.model ?? scenario.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [toolCall()],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: usage(body),
  };
}

function finalCompletion(body) {
  return {
    id: "chatcmpl-inference-lens-n8n-final",
    object: "chat.completion",
    created: 0,
    model: body.model ?? scenario.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: scenario.finalAnswer },
        finish_reason: "stop",
      },
    ],
    usage: usage(body),
  };
}

function initialProblem(body) {
  if (!isObject(body)) return "Initial request must be a JSON object.";
  if (body.model !== scenario.model) {
    return `Initial request model must be ${scenario.model}.`;
  }
  if (!Array.isArray(body.messages)) {
    return "Initial request messages must be an array.";
  }
  if (!JSON.stringify(body.messages).includes(scenario.sentinel)) {
    return `Initial request does not contain scenario sentinel ${scenario.sentinel}.`;
  }
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const names = tools.map((tool) => tool?.function?.name).filter(Boolean);
  if (!names.includes(scenario.toolName)) {
    return `Initial request does not expose tool ${scenario.toolName}.`;
  }
  if (scenario.expectedToolNames &&
      !isDeepStrictEqual(names, scenario.expectedToolNames)) {
    return `Initial request tool order must be ${scenario.expectedToolNames.join(", ")}.`;
  }
  return null;
}

function parseArguments(value) {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function continuationProblem(body) {
  if (!isObject(body) || !Array.isArray(body.messages)) {
    return "Continuation request messages must be an array.";
  }
  const assistantCalls = body.messages
    .filter((message) => message?.role === "assistant")
    .flatMap((message) =>
      Array.isArray(message.tool_calls) ? message.tool_calls : [],
    );
  const call = assistantCalls.find((candidate) => candidate?.id === scenario.toolCallId);
  if (!call) {
    return `Continuation request does not contain assistant call ${scenario.toolCallId}.`;
  }
  if (call.type !== "function" || call.function?.name !== scenario.toolName) {
    return `Assistant call ${scenario.toolCallId} does not target ${scenario.toolName}.`;
  }
  const expectedArguments = parseArguments(scenario.arguments);
  const actualArguments = parseArguments(call.function?.arguments);
  const n8nLinkedArguments = { ...expectedArguments, id: scenario.toolCallId };
  if (
    !isDeepStrictEqual(actualArguments, expectedArguments) &&
    !isDeepStrictEqual(actualArguments, n8nLinkedArguments)
  ) {
    return `Assistant call ${scenario.toolCallId} does not preserve the scripted arguments.`;
  }
  const result = body.messages.find(
    (message) =>
      message?.role === "tool" && message.tool_call_id === scenario.toolCallId,
  );
  if (!result) {
    return `Continuation request does not contain a tool result linked to ${scenario.toolCallId}.`;
  }
  if (typeof result.content !== "string") {
    return "Continuation tool result content must be a string.";
  }
  if (scenario.expectedResult !== null &&
      !isDeepStrictEqual(parseArguments(result.content), scenario.expectedResult)) {
    return `Continuation does not contain the expected ${scenarioId} sub-workflow result.`;
  }
  return null;
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function sendProblem(response, status, message) {
  state.problem = message;
  sendJson(response, status, {
    error: { message, type: "invalid_request_error" },
  });
}

function sse(response, chunks, usageValue) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  for (const chunk of chunks) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  response.write(
    `data: ${JSON.stringify({
      id: chunks[0].id,
      object: "chat.completion.chunk",
      created: 0,
      model: chunks[0].model,
      choices: [],
      usage: usageValue,
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}

function streamToolCall(response, completion) {
  const common = {
    id: completion.id,
    object: "chat.completion.chunk",
    created: 0,
    model: completion.model,
  };
  sse(
    response,
    [
      {
        ...common,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [{ index: 0, ...toolCall() }],
            },
            finish_reason: null,
          },
        ],
      },
      {
        ...common,
        choices: [
          { index: 0, delta: {}, finish_reason: "tool_calls" },
        ],
      },
    ],
    completion.usage,
  );
}

function streamFinal(response, completion) {
  const common = {
    id: completion.id,
    object: "chat.completion.chunk",
    created: 0,
    model: completion.model,
  };
  sse(
    response,
    [
      {
        ...common,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: scenario.finalAnswer },
            finish_reason: null,
          },
        ],
      },
      {
        ...common,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ],
    completion.usage,
  );
}

async function handleCompletion(request, response) {
  if (state.processing) {
    sendProblem(response, 409, "Another capture request is already being processed.");
    return;
  }
  state.processing = true;
  try {
    let body;
    let rawBody;
    try {
      const parsed = await readJson(request);
      body = parsed.value;
      rawBody = parsed.text;
    } catch (error) {
      sendProblem(response, 400, error.message);
      return;
    }

    if (state.phase === "awaiting-initial-request") {
      const problem = initialProblem(body);
      if (problem) {
        sendProblem(response, 422, problem);
        return;
      }
      const completion = toolCallCompletion(body);
      await writeRequestCapture("provider-request-initial.json", rawBody);
      await writeCapture("provider-response-tool-call.json", completion);
      state.phase = "awaiting-continuation-request";
      state.requestCount = 1;
      state.problem = null;
      if (body.stream === true) streamToolCall(response, completion);
      else sendJson(response, 200, completion);
      return;
    }

    if (state.phase === "awaiting-continuation-request") {
      const problem = continuationProblem(body);
      if (problem) {
        try {
          await writeRequestCapture("provider-request-rejected.json", rawBody);
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
        sendProblem(response, 422, problem);
        return;
      }
      const completion = finalCompletion(body);
      await writeRequestCapture(
        "provider-request-continuation.json",
        rawBody,
      );
      await writeCapture("provider-response-final.json", completion);
      state.phase = "complete";
      state.requestCount = 2;
      state.problem = null;
      if (body.stream === true) streamFinal(response, completion);
      else sendJson(response, 200, completion);
      return;
    }

    sendProblem(response, 409, "This capture is already complete.");
  } catch (error) {
    state.problem = "Capture artifact write failed; inspect the provider stderr.";
    console.error(error);
    sendJson(response, 500, {
      error: {
        message: state.problem,
        type: "server_error",
      },
    });
  } finally {
    state.processing = false;
  }
}

await mkdir(outputDirectory, { recursive: true });

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);

  if (request.method === "GET" && url.pathname === "/v1/models") {
    sendJson(response, 200, {
      object: "list",
      data: [{ id: scenario.model, object: "model", created: 0 }],
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/status") {
    sendJson(response, 200, {
      scenario: scenarioId,
      phase: state.phase,
      requestCount: state.requestCount,
      complete: state.phase === "complete",
      problem: state.problem,
      files: CAPTURE_FILES.slice(0, state.requestCount * 2),
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
    await handleCompletion(request, response);
    return;
  }

  sendJson(response, 404, {
    error: { message: "Not found.", type: "invalid_request_error" },
  });
});

stopOnSignal(server);

server.listen(port, host, () => {
  console.log(
    `n8n tool capture provider listening on ${host}:${port}; ` +
      `scenario=${scenarioId}; output=${outputDirectory}`,
  );
});
