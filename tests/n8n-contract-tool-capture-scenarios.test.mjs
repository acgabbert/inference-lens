import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const cases = [
  {
    id: "primitive-inputs",
    sentinel: "IL_N0_PRIMITIVE_INPUTS",
    name: "il_echo_primitives",
    arguments: { text: "IL_N0_PRIMITIVE_TEXT", count: 7, enabled: true },
    result: [{ fixture: "IL_N0_PRIMITIVE_INPUTS", values: { text: "IL_N0_PRIMITIVE_TEXT", count: 7, enabled: true }, types: { text: "string", count: "number", enabled: "boolean" } }],
  },
  {
    id: "multiple-output-items",
    sentinel: "IL_N0_MULTIPLE_OUTPUT_ITEMS",
    name: "il_multiple_items",
    arguments: { topic: "IL_N0_MULTI_TOPIC" },
    result: [
      { fixture: "IL_N0_MULTIPLE_OUTPUT_ITEMS", ordinal: 1, topic: "IL_N0_MULTI_TOPIC", value: "IL_N0_MULTI_FIRST" },
      { fixture: "IL_N0_MULTIPLE_OUTPUT_ITEMS", ordinal: 2, topic: "IL_N0_MULTI_TOPIC", value: "IL_N0_MULTI_SECOND" },
    ],
  },
  {
    id: "fixed-and-ai-inputs",
    sentinel: "IL_N0_FIXED_AND_AI",
    name: "il_fixed_and_ai",
    arguments: { text: "IL_N0_AI_TEXT" },
    result: [{ fixture: "IL_N0_FIXED_AND_AI", text: "IL_N0_AI_TEXT", source: "IL_N0_FIXED_SOURCE" }],
  },
  {
    id: "empty-output",
    sentinel: "IL_N0_EMPTY_OUTPUT",
    name: "il_empty_output",
    arguments: { topic: "IL_N0_EMPTY_TOPIC" },
    result: [],
  },
  {
    id: "nested-inputs",
    sentinel: "IL_N0_NESTED_INPUTS",
    name: "il_nested_inputs",
    arguments: { payload: { label: "IL_N0_NESTED_LABEL", count: 3 }, tags: ["IL_N0_TAG_A", "IL_N0_TAG_B"] },
    result: [{ fixture: "IL_N0_NESTED_INPUTS", payload: { label: "IL_N0_NESTED_LABEL", count: 3 }, tags: ["IL_N0_TAG_A", "IL_N0_TAG_B"], types: { payload: "object", tagsIsArray: true } }],
  },
  {
    id: "multiple-attached-tools",
    sentinel: "IL_N0_MULTIPLE_ATTACHED_TOOLS",
    name: "il_echo_string",
    otherName: "il_echo_primitives",
    arguments: { text: "IL_N0_STRING_VALUE" },
    result: [{ fixture: "IL_N0_STRING_INPUT", echoed: "IL_N0_STRING_VALUE", receivedType: "string" }],
  },
];

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function start(t, id) {
  const port = await unusedPort();
  const output = await mkdtemp(path.join(os.tmpdir(), "il-n8n-scenario-"));
  const child = spawn(process.execPath, ["scripts/n8n-tool-capture-provider.mjs"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, INFERENCE_LENS_N8N_TOOL_CAPTURE_PORT: String(port), INFERENCE_LENS_N8N_TOOL_CAPTURE_SCENARIO: id, INFERENCE_LENS_N8N_TOOL_CAPTURE_OUTPUT: output },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i += 1) {
    if (child.exitCode !== null) throw new Error(stderr);
    try { if ((await fetch(`${url}/status`)).ok) return url; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Provider did not start: ${stderr}`);
}

function post(url, body) {
  return fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

for (const scenario of cases) {
  test(`captures ${scenario.id} without accepting an unrelated result`, async (t) => {
    const url = await start(t, scenario.id);
    const initial = {
      model: "template-echo-model",
      messages: [{ role: "user", content: scenario.sentinel }],
      tools: [
        { type: "function", function: { name: scenario.name, parameters: { type: "object" } } },
        ...(scenario.otherName ? [{ type: "function", function: { name: scenario.otherName, parameters: { type: "object" } } }] : []),
      ],
    };
    const first = await post(url, initial);
    assert.equal(first.status, 200);
    const call = (await first.json()).choices[0].message.tool_calls[0];
    assert.equal(call.function.name, scenario.name);
    assert.deepEqual(JSON.parse(call.function.arguments), scenario.arguments);
    const continuation = {
      ...initial,
      messages: [
        ...initial.messages,
        { role: "assistant", content: null, tool_calls: [call] },
        { role: "tool", tool_call_id: call.id, content: JSON.stringify([{ wrong: true }]) },
      ],
    };
    const rejected = await post(url, continuation);
    assert.equal(rejected.status, 422);
    continuation.messages.at(-1).content = JSON.stringify(scenario.result);
    const accepted = await post(url, continuation);
    assert.equal(accepted.status, 200);
    assert.equal((await fetch(`${url}/status`).then((r) => r.json())).complete, true);
  });
}

for (const [id, sentinel, name, argumentsValue] of [
  ["workflow-error", "IL_N0_WORKFLOW_ERROR", "il_workflow_error", { reason: "IL_N0_EXPECTED_ERROR" }],
  ["rejected-arguments", "IL_N0_REJECTED_ARGUMENTS", "il_rejected_arguments", { count: "IL_N0_NOT_A_NUMBER" }],
]) {
  test(`${id} records the initial tool call even if n8n never continues`, async (t) => {
    const url = await start(t, id);
    const response = await post(url, {
      model: "template-echo-model",
      messages: [{ role: "user", content: sentinel }],
      tools: [{ type: "function", function: { name, parameters: { type: "object" } } }],
    });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse((await response.json()).choices[0].message.tool_calls[0].function.arguments), argumentsValue);
    const status = await fetch(`${url}/status`).then((r) => r.json());
    assert.equal(status.phase, "awaiting-continuation-request");
    assert.equal(status.requestCount, 1);
  });
}
