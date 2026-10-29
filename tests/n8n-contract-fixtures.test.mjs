import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { validateRedactedCapture } from "../scripts/n8n-contract-lib.mjs";

const fixtureRoot = path.resolve(
  import.meta.dirname,
  "fixtures/n8n/captures/2.32.5",
);
const toolFixtureRoot = path.resolve(
  import.meta.dirname,
  "fixtures/n8n/captures/2.39.10/string-input-tool-workflow",
);
const primitiveToolFixtureRoot = path.resolve(
  import.meta.dirname,
  "fixtures/n8n/captures/2.39.10/primitive-inputs-tool-workflow",
);
const multipleOutputToolFixtureRoot = path.resolve(
  import.meta.dirname,
  "fixtures/n8n/captures/2.39.10/multiple-output-items-tool-workflow",
);
const fixedAndAiToolFixtureRoot = path.resolve(
  import.meta.dirname,
  "fixtures/n8n/captures/2.39.10/fixed-and-ai-inputs-tool-workflow",
);
const laterToolFixtureRoot = (name) => path.resolve(
  import.meta.dirname,
  `fixtures/n8n/captures/2.39.10/${name}-tool-workflow`,
);
const fixedAndAiAgentFixtureRoots = [
  [2.2, "fixed-and-ai-inputs-agent-2.2"],
  [3, "fixed-and-ai-inputs-agent-3"],
].map(([version, directory]) => [
  version,
  path.resolve(import.meta.dirname, "fixtures/n8n/captures/2.39.10", directory),
]);

async function readJson(...segments) {
  return JSON.parse(await readFile(path.join(...segments), "utf8"));
}

test("validates every committed n8n capture and its digests offline", async () => {
  for (const captureName of [
    "ai-agent-2-2",
    "ai-agent-3",
    "ai-agent-3-1",
    "basic-llm-chain-invalid-syntax",
    "basic-llm-chain-success",
    "basic-llm-chain-whole-field",
    "message-a-model-1-2",
    "message-a-model-1-3",
  ]) {
    const manifest = await validateRedactedCapture({
      directory: path.join(fixtureRoot, captureName),
    });
    assert.equal(manifest.n8nVersion, "2.32.5");
    assert.equal(manifest.workflowId, "workflow_fixture");
  }
});

test("proves the 2.39.10 string-input tool exchange from provider and child evidence", async () => {
  const manifest = await validateRedactedCapture({ directory: toolFixtureRoot });
  assert.equal(manifest.n8nVersion, "2.39.10");
  assert.equal(manifest.subworkflowId, "subworkflow_fixture");
  assert.equal(Object.keys(manifest.sourceFiles).length, 8);
  assert.deepEqual(
    manifest.executions.map(({ workflowId, status }) => ({ workflowId, status })),
    [
      { workflowId: "workflow_fixture", status: "success" },
      { workflowId: "subworkflow_fixture", status: "success" },
    ],
  );

  const initial = await readJson(toolFixtureRoot, "provider-request-initial.json");
  assert.deepEqual(initial.messages.map(({ role }) => role), ["system", "user"]);
  assert.equal(initial.tools[0].function.name, "il_echo_string");
  assert.deepEqual(initial.tools[0].function.parameters.required, ["text"]);

  const continuation = await readJson(
    toolFixtureRoot,
    "provider-request-continuation.json",
  );
  assert.deepEqual(
    continuation.messages.map(({ role }) => role),
    ["system", "user", "assistant", "tool"],
  );
  const call = continuation.messages[2].tool_calls[0];
  assert.deepEqual(JSON.parse(call.function.arguments), {
    text: "IL_N0_STRING_VALUE",
    id: call.id,
  });
  const result = continuation.messages[3];
  assert.equal(result.tool_call_id, call.id);
  assert.deepEqual(JSON.parse(result.content), [{
    fixture: "IL_N0_STRING_INPUT",
    echoed: "IL_N0_STRING_VALUE",
    receivedType: "string",
  }]);

  const child = await readJson(toolFixtureRoot, "execution-success-2.json");
  assert.equal(child.workflowId, "subworkflow_fixture");
  assert.deepEqual(
    child.data.resultData.runData["Return string evidence"][0].data.main[0][0].json,
    JSON.parse(result.content)[0],
  );
  const final = await readJson(toolFixtureRoot, "provider-response-final.json");
  assert.equal(final.choices[0].message.content, "IL_N0_CAPTURE_COMPLETE");
});

test("proves primitive input types in the provider request and executed child", async () => {
  const manifest = await validateRedactedCapture({
    directory: primitiveToolFixtureRoot,
  });
  assert.equal(manifest.n8nVersion, "2.39.10");
  assert.deepEqual(
    manifest.executions.map(({ workflowId, status }) => ({ workflowId, status })),
    [
      { workflowId: "workflow_fixture", status: "success" },
      { workflowId: "subworkflow_fixture", status: "success" },
    ],
  );

  const initial = await readJson(
    primitiveToolFixtureRoot,
    "provider-request-initial.json",
  );
  const tool = initial.tools[0].function;
  assert.equal(tool.name, "il_echo_primitives");
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(tool.parameters.properties).map(([name, schema]) => [
        name,
        schema.type,
      ]),
    ),
    { enabled: "boolean", text: "string", count: "number" },
  );
  assert.deepEqual(tool.parameters.required, ["enabled", "text", "count"]);

  const continuation = await readJson(
    primitiveToolFixtureRoot,
    "provider-request-continuation.json",
  );
  const call = continuation.messages[2].tool_calls[0];
  assert.deepEqual(JSON.parse(call.function.arguments), {
    text: "IL_N0_PRIMITIVE_TEXT",
    count: 7,
    enabled: true,
    id: call.id,
  });
  const result = continuation.messages[3];
  assert.equal(result.tool_call_id, call.id);
  const expected = {
    fixture: "IL_N0_PRIMITIVE_INPUTS",
    values: { text: "IL_N0_PRIMITIVE_TEXT", count: 7, enabled: true },
    types: { text: "string", count: "number", enabled: "boolean" },
  };
  assert.deepEqual(JSON.parse(result.content), [expected]);

  const child = await readJson(
    primitiveToolFixtureRoot,
    "execution-success-2.json",
  );
  assert.deepEqual(
    child.data.resultData.runData["Return primitive evidence"][0].data.main[0][0].json,
    expected,
  );
});

test("proves ordered child items become one provider-visible tool result", async () => {
  const manifest = await validateRedactedCapture({
    directory: multipleOutputToolFixtureRoot,
  });
  assert.equal(manifest.n8nVersion, "2.39.10");
  assert.deepEqual(
    manifest.executions.map(({ workflowId, status }) => ({ workflowId, status })),
    [
      { workflowId: "workflow_fixture", status: "success" },
      { workflowId: "subworkflow_fixture", status: "success" },
    ],
  );

  const initial = await readJson(
    multipleOutputToolFixtureRoot,
    "provider-request-initial.json",
  );
  assert.equal(initial.tools[0].function.name, "il_multiple_items");
  assert.deepEqual(initial.tools[0].function.parameters.required, ["topic"]);

  const continuation = await readJson(
    multipleOutputToolFixtureRoot,
    "provider-request-continuation.json",
  );
  const call = continuation.messages[2].tool_calls[0];
  assert.deepEqual(JSON.parse(call.function.arguments), {
    topic: "IL_N0_MULTI_TOPIC",
    id: call.id,
  });
  const toolResult = continuation.messages[3];
  assert.equal(toolResult.tool_call_id, call.id);
  assert.equal(typeof toolResult.content, "string");
  const items = JSON.parse(toolResult.content);
  assert.deepEqual(items.map(({ ordinal, value }) => ({ ordinal, value })), [
    { ordinal: 1, value: "IL_N0_MULTI_FIRST" },
    { ordinal: 2, value: "IL_N0_MULTI_SECOND" },
  ]);

  const child = await readJson(
    multipleOutputToolFixtureRoot,
    "execution-success-2.json",
  );
  assert.deepEqual(
    child.data.resultData.runData["Return two ordered items"][0].data.main[0]
      .map(({ json }) => json),
    items,
  );
  const final = await readJson(
    multipleOutputToolFixtureRoot,
    "provider-response-final.json",
  );
  assert.equal(final.choices[0].message.content, "IL_N0_CAPTURE_COMPLETE");
});

test("proves only the AI input appears in the tool schema while the child receives the fixed input", async () => {
  const manifest = await validateRedactedCapture({
    directory: fixedAndAiToolFixtureRoot,
  });
  assert.equal(manifest.n8nVersion, "2.39.10");
  assert.deepEqual(
    manifest.executions.map(({ workflowId, status }) => ({ workflowId, status })),
    [
      { workflowId: "workflow_fixture", status: "success" },
      { workflowId: "subworkflow_fixture", status: "success" },
    ],
  );

  const workflow = await readJson(fixedAndAiToolFixtureRoot, "workflow.json");
  const mapping = workflow.nodes.find(({ name }) => name === "il_fixed_and_ai")
    .parameters.workflowInputs.value;
  assert.match(mapping.text, /\$fromAI\('text'/);
  assert.equal(mapping.source, "IL_N0_FIXED_SOURCE");

  const initial = await readJson(fixedAndAiToolFixtureRoot, "provider-request-initial.json");
  const tool = initial.tools[0].function;
  assert.equal(tool.name, "il_fixed_and_ai");
  assert.deepEqual(tool.parameters.properties, {
    text: { type: "string", description: "A diagnostic string" },
  });
  assert.deepEqual(tool.parameters.required, ["text"]);
  assert.equal(tool.parameters.additionalProperties, false);

  const continuation = await readJson(
    fixedAndAiToolFixtureRoot,
    "provider-request-continuation.json",
  );
  const call = continuation.messages[2].tool_calls[0];
  assert.deepEqual(JSON.parse(call.function.arguments), {
    text: "IL_N0_AI_TEXT",
    id: call.id,
  });
  const expected = {
    fixture: "IL_N0_FIXED_AND_AI",
    text: "IL_N0_AI_TEXT",
    source: "IL_N0_FIXED_SOURCE",
  };
  const result = continuation.messages[3];
  assert.equal(result.tool_call_id, call.id);
  assert.deepEqual(JSON.parse(result.content), [expected]);

  const child = await readJson(fixedAndAiToolFixtureRoot, "execution-success-2.json");
  assert.deepEqual(
    child.data.resultData.runData["When Executed by Another Workflow"][0]
      .data.main[0][0].json,
    { text: "IL_N0_AI_TEXT", source: "IL_N0_FIXED_SOURCE" },
  );
  assert.deepEqual(
    child.data.resultData.runData["Return fixed and ai inputs evidence"][0]
      .data.main[0][0].json,
    expected,
  );

  const final = await readJson(fixedAndAiToolFixtureRoot, "provider-response-final.json");
  assert.equal(final.choices[0].message.content, "IL_N0_CAPTURE_COMPLETE");
});

test("compares fixed and AI tool exchanges across Agent 2.2, 3, and 3.1", async () => {
  const baselineInitial = await readJson(
    fixedAndAiToolFixtureRoot,
    "provider-request-initial.json",
  );
  const baselineContinuation = await readJson(
    fixedAndAiToolFixtureRoot,
    "provider-request-continuation.json",
  );
  const baselineCall = baselineContinuation.messages[2].tool_calls[0];
  const baselineResult = baselineContinuation.messages[3];
  const expectedChildInput = {
    text: "IL_N0_AI_TEXT",
    source: "IL_N0_FIXED_SOURCE",
  };
  const expectedResult = [{ fixture: "IL_N0_FIXED_AND_AI", ...expectedChildInput }];

  for (const [agentVersion, root] of fixedAndAiAgentFixtureRoots) {
    const manifest = await validateRedactedCapture({ directory: root });
    assert.equal(manifest.n8nVersion, "2.39.10");
    assert.deepEqual(
      manifest.executions.map(({ workflowId, status }) => ({ workflowId, status })),
      [
        { workflowId: "workflow_fixture", status: "success" },
        { workflowId: "subworkflow_fixture", status: "success" },
      ],
    );

    const workflow = await readJson(root, "workflow.json");
    assert.equal(
      workflow.nodes.find(({ type }) => type === "@n8n/n8n-nodes-langchain.agent")
        .typeVersion,
      agentVersion,
    );
    const mapping = workflow.nodes.find(({ name }) => name === "il_fixed_and_ai")
      .parameters.workflowInputs.value;
    assert.match(mapping.text, /\$fromAI\('text'/);
    assert.equal(mapping.source, "IL_N0_FIXED_SOURCE");

    const initial = await readJson(root, "provider-request-initial.json");
    assert.deepEqual(initial.tools[0].function, baselineInitial.tools[0].function);
    assert.deepEqual(Object.keys(initial.tools[0].function.parameters.properties), ["text"]);

    const continuation = await readJson(root, "provider-request-continuation.json");
    const call = continuation.messages[2].tool_calls[0];
    const result = continuation.messages[3];
    assert.equal(result.tool_call_id, call.id);
    assert.deepEqual(JSON.parse(result.content), expectedResult);
    if (agentVersion === 2.2) {
      assert.deepEqual(JSON.parse(call.function.arguments), { text: "IL_N0_AI_TEXT" });
      assert.match(result.content, /\n/);
    } else {
      assert.equal(call.function.arguments, baselineCall.function.arguments);
      assert.equal(result.content, baselineResult.content);
    }

    const child = await readJson(root, "execution-success-2.json");
    assert.deepEqual(
      child.data.resultData.runData["When Executed by Another Workflow"][0]
        .data.main[0][0].json,
      expectedChildInput,
    );
    const parent = await readJson(root, "execution-success.json");
    assert.deepEqual(
      parent.data.resultData.runData["Fixed and AI inputs agent"][0]
        .data.main[0][0].json,
      { output: "IL_N0_CAPTURE_COMPLETE" },
    );
  }
});

test("captures a fixed-only workflow with n8n's optional synthetic input schema", async () => {
  const root = laterToolFixtureRoot("fixed-only-input");
  const manifest = await validateRedactedCapture({ directory: root });
  assert.deepEqual(manifest.executions.map(({ status }) => status), ["success", "success"]);

  const initial = await readJson(root, "provider-request-initial.json");
  assert.deepEqual(initial.tools[0].function.parameters.properties, {
    input: { type: "string" },
  });
  assert.equal(initial.tools[0].function.parameters.required, undefined);

  const continuation = await readJson(root, "provider-request-continuation.json");
  const call = continuation.messages[2].tool_calls[0];
  assert.deepEqual(JSON.parse(call.function.arguments), { id: call.id });
  assert.deepEqual(JSON.parse(continuation.messages[3].content), [
    { fixture: "IL_N0_FIXED_ONLY", source: "IL_N0_FIXED_SOURCE" },
  ]);
  const child = await readJson(root, "execution-success-2.json");
  assert.deepEqual(child.data.resultData.runData["When Executed by Another Workflow"][0]
    .data.main[0][0].json, { source: "IL_N0_FIXED_SOURCE" });
});

test("captures nested inputs as untyped model properties and typed child values", async () => {
  const root = laterToolFixtureRoot("nested-inputs");
  const manifest = await validateRedactedCapture({ directory: root });
  assert.deepEqual(manifest.executions.map(({ status }) => status), ["success", "success"]);
  const initial = await readJson(root, "provider-request-initial.json");
  assert.deepEqual(initial.tools[0].function.parameters.properties, {
    payload: { description: "An object with label and count" },
    tags: { description: "An array of strings" },
  });
  const continuation = await readJson(root, "provider-request-continuation.json");
  assert.deepEqual(JSON.parse(continuation.messages[3].content)[0].types, {
    payload: "object",
    tagsIsArray: true,
  });
});

test("captures workflow error as a model-visible result after child failure", async () => {
  const root = laterToolFixtureRoot("workflow-error");
  const manifest = await validateRedactedCapture({ directory: root });
  assert.deepEqual(manifest.executions.map(({ status }) => status), ["success", "error"]);
  const continuation = await readJson(root, "provider-request-continuation.json");
  assert.deepEqual(JSON.parse(continuation.messages[3].content), [{
    error: "IL_N0_EXPECTED_WORKFLOW_ERROR:IL_N0_EXPECTED_ERROR [line 2]",
  }]);
});

test("captures rejected arguments before a child execution starts", async () => {
  const root = laterToolFixtureRoot("rejected-arguments");
  const manifest = await validateRedactedCapture({ directory: root });
  assert.deepEqual(manifest.executions.map(({ status }) => status), ["success"]);
  assert.equal(manifest.subworkflowId, undefined);
  const continuation = await readJson(root, "provider-request-continuation.json");
  const result = JSON.parse(continuation.messages[3].content);
  assert.equal(result.length, 1);
  assert.match(result[0].error, /Expected number, received string/);
});

test("captures n8n's reversed order for two attached tools and the selected child", async () => {
  const root = laterToolFixtureRoot("multiple-attached-tools");
  const manifest = await validateRedactedCapture({ directory: root });
  assert.deepEqual(manifest.executions.map(({ status }) => status), ["success", "success"]);
  const initial = await readJson(root, "provider-request-initial.json");
  assert.deepEqual(initial.tools.map(({ function: tool }) => tool.name), [
    "il_echo_primitives",
    "il_echo_string",
  ]);
  assert.deepEqual(initial.tools[0].function.parameters.required, [
    "text", "count", "enabled",
  ]);
  assert.deepEqual(initial.tools[1].function.parameters.required, ["text"]);
  const continuation = await readJson(root, "provider-request-continuation.json");
  const call = continuation.messages[2].tool_calls[0];
  assert.equal(call.function.name, "il_echo_string");
  assert.deepEqual(JSON.parse(call.function.arguments), {
    text: "IL_N0_STRING_VALUE",
    id: call.id,
  });
  assert.deepEqual(JSON.parse(continuation.messages[3].content), [
    { fixture: "IL_N0_STRING_INPUT", echoed: "IL_N0_STRING_VALUE", receivedType: "string" },
  ]);
  const child = await readJson(root, "execution-success-2.json");
  assert.deepEqual(child.data.resultData.runData["When Executed by Another Workflow"][0]
    .data.main[0][0].json, { text: "IL_N0_STRING_VALUE" });
});

test("proves the successful compound execution from saved model messages", async () => {
  const execution = await readJson(
    fixtureRoot,
    "basic-llm-chain-success",
    "execution-success.json",
  );
  const runData = execution.data.resultData.runData;
  const modelRuns = runData["Fixture OpenAI Chat Model"];
  const parentItems = runData["Compound prompt cases"][0].data.main[0];

  assert.equal(execution.status, "success");
  assert.equal(modelRuns.length, 2);
  assert.deepEqual(
    modelRuns.map(
      (run) => run.inputOverride.ai_languageModel[0][0].json.messages[0],
    ),
    [
      'Human: IL_P0_LITERAL\nsimple=IL_P0_TOPIC_ALPHA\ntwo=IL_P0_REPEAT|IL_P0_SECOND_ALPHA\ncompound=IL_P0_TOPIC_ALPHA::IL_P0_SECOND_ALPHA\nnested=value:{"inner":"IL_P0_TOPIC_ALPHA"}\nrepeated=IL_P0_REPEAT|IL_P0_REPEAT',
      'Human: IL_P0_LITERAL\nsimple=IL_P0_TOPIC_BETA\ntwo=IL_P0_REPEAT|IL_P0_SECOND_BETA\ncompound=IL_P0_TOPIC_BETA::IL_P0_SECOND_BETA\nnested=value:{"inner":"IL_P0_TOPIC_BETA"}\nrepeated=IL_P0_REPEAT|IL_P0_REPEAT',
    ],
  );
  assert.deepEqual(
    modelRuns.map(
      (run) =>
        run.inputOverride.ai_languageModel[0][0].json.options.temperature,
    ),
    [0, 0],
  );
  assert.deepEqual(
    parentItems.map((item) => item.json.text),
    modelRuns.map(
      (run) =>
        run.data.ai_languageModel[0][0].json.response.generations[0][0].text,
    ),
  );
});

test("fails closed when model sub-run order cannot identify parent items", async () => {
  const execution = await readJson(
    fixtureRoot,
    "basic-llm-chain-whole-field",
    "execution-success.json",
  );
  const runData = execution.data.resultData.runData;
  const modelMessages = runData["Fixture OpenAI Chat Model"].map(
    (run) => run.inputOverride.ai_languageModel[0][0].json.messages[0],
  );
  const parentOutputs = runData["Whole-field prompt case"][0].data.main[0].map(
    (item) => item.json.text,
  );

  assert.deepEqual(modelMessages, [
    "Human: IL_P0_WHOLE_BETA",
    "Human: IL_P0_WHOLE_ALPHA",
  ]);
  assert.deepEqual(parentOutputs, [
    'Fixture received user="IL_P0_WHOLE_ALPHA"',
    'Fixture received user="IL_P0_WHOLE_BETA"',
  ]);
  assert.notEqual(modelMessages[0].slice("Human: ".length), "IL_P0_WHOLE_ALPHA");
});

test("retains authored text but no effective model message after syntax failure", async () => {
  const execution = await readJson(
    fixtureRoot,
    "basic-llm-chain-invalid-syntax",
    "execution-error.json",
  );
  const runData = execution.data.resultData.runData;
  const authoredText = execution.data.workflowData.nodes.find(
    (node) => node.name === "Compound prompt cases",
  ).parameters.text;

  assert.equal(execution.status, "error");
  assert.match(authoredText, /delimiter=\{\{ "literal \}\} text" \}\}/);
  assert.equal(runData["Fixture OpenAI Chat Model"], undefined);
});

test("keeps parser cases as UTF-16 source fixtures without evaluating them", async () => {
  const fixture = await readJson(
    path.resolve(import.meta.dirname, "fixtures/n8n/parser-cases"),
    "expression-regions.json",
  );

  assert.equal(fixture.offsetEncoding, "UTF-16");
  assert.ok(
    fixture.cases.some((entry) => entry.name === "nested braces and template literal"),
  );
  assert.ok(
    fixture.cases.some(
      (entry) => entry.name === "closing delimiter text inside string",
    ),
  );
  assert.ok(
    fixture.cases.some(
      (entry) =>
        entry.error?.reason ===
        "Expression is missing its closing }} delimiter.",
    ),
  );
});

test("AI Agent captures retain attributable resolved model input", async () => {
  for (const captureName of ["ai-agent-2-2", "ai-agent-3", "ai-agent-3-1"]) {
    const execution = await readJson(
      fixtureRoot,
      captureName,
      "execution-success.json",
    );
    const runData = execution.data.resultData.runData;
    const modelName = Object.keys(runData).find((name) =>
      name.endsWith("OpenAI Chat Model"),
    );
    assert.ok(modelName);
    const modelRuns = runData[modelName];
    assert.equal(modelRuns.length, 1);
    assert.equal(modelRuns[0].source.length, 1);
    assert.match(modelRuns[0].source[0].previousNode, /AI Agent/);
    assert.equal(modelRuns[0].source[0].previousNodeRun, 0);

    const savedInput =
      modelRuns[0].inputOverride.ai_languageModel[0][0].json;
    assert.equal(savedInput.messages.length, 1);
    assert.match(savedInput.messages[0], /^System: IL_AGENT_/);
    assert.match(savedInput.messages[0], /\nHuman: IL_AGENT_/);
    assert.equal(savedInput.options.model, "template-echo-model");
    assert.equal(savedInput.options.temperature, 0);
  }
});

test("Message a Model captures retain output but no effective request", async () => {
  for (const captureName of [
    "message-a-model-1-2",
    "message-a-model-1-3",
  ]) {
    const execution = await readJson(
      fixtureRoot,
      captureName,
      "execution-success.json",
    );
    const runData = execution.data.resultData.runData;
    const targetName = Object.keys(runData).find((name) =>
      name.startsWith("Message a Model"),
    );
    assert.ok(targetName);
    const targetRuns = runData[targetName];
    assert.equal(targetRuns.length, 1);
    assert.equal(targetRuns[0].inputOverride, undefined);
    assert.match(
      targetRuns[0].data.main[0][0].json.message.content,
      /^Fixture received /,
    );
  }
});

test("F0 Agent 3.1 buffered formatter completes after one provider turn", async () => {
  const root = path.resolve(import.meta.dirname, "fixtures/n8n/captures/2.39.10/f0-agent-3-1-buffered");
  const manifest = await validateRedactedCapture({ directory: root });
  assert.equal(manifest.n8nVersion, "2.39.10");
  assert.deepEqual(manifest.providerFiles, ["provider-request-initial.json", "provider-response-final.json"]);
  const request = await readJson(root, "provider-request-initial.json");
  const response = await readJson(root, "provider-response-final.json");
  const execution = await readJson(root, "execution-success.json");
  assert.equal(request.stream, false);
  assert.equal(execution.status, "success");
  assert.equal(execution.finished, true);
  const snapshot = execution.data.workflowData;
  for (const [suffix, version] of [[".agent", 3.1], [".lmChatOpenAi", 1.2], [".outputParserStructured", 1.3]]) {
    assert.equal(snapshot.nodes.find((node) => node.type.endsWith(suffix)).typeVersion, version);
  }
  const parser = snapshot.nodes.find((node) => node.type.endsWith(".outputParserStructured"));
  assert.equal(parser.parameters.autoFix, false);
  const authored = JSON.parse(parser.parameters.inputSchema);
  const formatter = request.tools.find((tool) => tool.function.name === "format_final_json_response").function;
  assert.deepEqual(formatter.parameters.properties.output, authored);
  assert.deepEqual(formatter.parameters.required, ["output"]);
  assert.equal(formatter.parameters.additionalProperties, false);
  assert.match(request.messages.find((message) => message.role === "system").content, /MUST use the `format_final_json_response` tool/);
  assert.equal(request.messages.some((message) => message.role === "tool"), false);
  const calls = response.choices[0].message.tool_calls;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, "format_final_json_response");
  const argumentsValue = JSON.parse(calls[0].function.arguments);
  assert.deepEqual(argumentsValue, { output: { answer: "IL_F0_ANSWER", count: 7 } });
  const runs = execution.data.resultData.runData;
  assert.equal(runs["Fixture OpenAI Chat Model"].length, 1);
  assert.equal(runs["Structured Output Parser"].length, 1);
  assert.equal(runs["il_echo_string"], undefined);
  const parsed = runs["Structured Output Parser"][0];
  assert.equal(parsed.inputOverride.ai_outputParser[0][0].json.text, calls[0].function.arguments);
  assert.deepEqual(parsed.data.ai_outputParser[0][0].json.response, argumentsValue);
  assert.deepEqual(runs["Final output agent"][0].data.main[0][0].json, argumentsValue);
  assert.equal(Object.hasOwn(argumentsValue.output, "note"), false);
});

test("F0 Agent 3.1 executes an ordinary tool then terminates on the formatter", async () => {
  const root = path.resolve(import.meta.dirname, "fixtures/n8n/captures/2.39.10/f0-agent-3-1-after-tool");
  const manifest = await validateRedactedCapture({ directory: root });
  assert.equal(manifest.n8nVersion, "2.39.10");
  assert.equal(manifest.providerFiles.length, 4);
  const initial = await readJson(root, "provider-request-initial.json");
  const ordinary = (await readJson(root, "provider-response-tool-call.json")).choices[0].message.tool_calls[0];
  const continuation = await readJson(root, "provider-request-continuation.json");
  const terminal = (await readJson(root, "provider-response-final.json")).choices[0].message.tool_calls[0];
  const parent = await readJson(root, "execution-success.json");
  const child = await readJson(root, "execution-success-2.json");
  assert.equal(initial.stream, false);
  assert.equal(continuation.stream, false);
  assert.deepEqual(continuation.tools, initial.tools);
  assert.deepEqual(continuation.messages.slice(0, initial.messages.length), initial.messages);
  assert.equal(ordinary.function.name, "il_echo_string");
  const linked = continuation.messages.find((message) => message.role === "assistant").tool_calls[0];
  assert.equal(linked.id, ordinary.id);
  assert.deepEqual(JSON.parse(linked.function.arguments), { ...JSON.parse(ordinary.function.arguments), id: ordinary.id });
  const results = continuation.messages.filter((message) => message.role === "tool");
  assert.equal(results.length, 1);
  assert.equal(results[0].tool_call_id, ordinary.id);
  const childOutput = child.data.resultData.runData["Return string evidence"][0].data.main[0].map((item) => item.json);
  assert.deepEqual(JSON.parse(results[0].content), childOutput);
  assert.deepEqual(childOutput, [{ fixture: "IL_N0_STRING_INPUT", echoed: "IL_N0_STRING_VALUE", receivedType: "string" }]);
  assert.equal(parent.status, "success");
  assert.equal(child.status, "success");
  const runs = parent.data.resultData.runData;
  assert.equal(runs["Fixture OpenAI Chat Model"].length, 2);
  assert.equal(runs.il_echo_string.length, 1);
  assert.deepEqual(runs.il_echo_string[0].metadata.subExecution, { executionId: child.id, workflowId: child.workflowId });
  assert.equal(child.data.executionData.runtimeData.parentExecutionId, parent.id);
  assert.equal(terminal.function.name, "format_final_json_response");
  assert.equal(runs["Structured Output Parser"].length, 1);
  assert.equal(runs["Structured Output Parser"][0].inputOverride.ai_outputParser[0][0].json.text, terminal.function.arguments);
  assert.deepEqual(runs["Final output agent"][0].data.main[0][0].json, JSON.parse(terminal.function.arguments));
});

test("F0 Agent 3.1 parses wrapped final-text JSON without a formatter call", async () => {
  const root = path.resolve(import.meta.dirname, "fixtures/n8n/captures/2.39.10/f0-agent-3-1-text-valid");
  const manifest = await validateRedactedCapture({ directory: root });
  assert.equal(manifest.n8nVersion, "2.39.10");
  assert.deepEqual(manifest.providerFiles, ["provider-request-initial.json", "provider-response-final.json"]);
  const request = await readJson(root, "provider-request-initial.json");
  const response = await readJson(root, "provider-response-final.json");
  const execution = await readJson(root, "execution-success.json");
  assert.equal(request.stream, false);
  assert.ok(request.tools.some((tool) => tool.function.name === "format_final_json_response"));
  assert.equal(response.choices[0].finish_reason, "stop");
  const message = response.choices[0].message;
  assert.equal(message.tool_calls, undefined);
  const output = JSON.parse(message.content);
  assert.deepEqual(output, { output: { answer: "IL_F0_ANSWER", count: 7 } });
  assert.equal(execution.status, "success");
  const runs = execution.data.resultData.runData;
  assert.equal(runs["Fixture OpenAI Chat Model"].length, 1);
  const generation = runs["Fixture OpenAI Chat Model"][0].data.ai_languageModel[0][0].json.response.generations[0][0];
  assert.equal(generation.text, message.content);
  assert.equal(generation.generationInfo.finish_reason, "stop");
  assert.equal(runs.il_echo_string, undefined);
  assert.equal(runs["Structured Output Parser"].length, 1);
  const parser = runs["Structured Output Parser"][0];
  assert.equal(parser.inputOverride.ai_outputParser[0][0].json.text, message.content);
  assert.deepEqual(parser.data.ai_outputParser[0][0].json.response, output);
  assert.deepEqual(runs["Final output agent"][0].data.main[0][0].json, output);
});

test("F0 Agent 3.1 rejects invalid final-text JSON without a repair request", async () => {
  const root = path.resolve(import.meta.dirname, "fixtures/n8n/captures/2.39.10/f0-agent-3-1-text-invalid");
  const manifest = await validateRedactedCapture({ directory: root });
  assert.equal(manifest.n8nVersion, "2.39.10");
  assert.deepEqual(manifest.providerFiles, ["provider-request-initial.json", "provider-response-final.json"]);
  const request = await readJson(root, "provider-request-initial.json");
  const response = await readJson(root, "provider-response-final.json");
  const execution = await readJson(root, "execution-error.json");
  assert.equal(request.stream, false);
  assert.equal(response.choices[0].finish_reason, "stop");
  assert.equal(response.choices[0].message.content, "IL_F0_NOT_JSON");
  assert.equal(response.choices[0].message.tool_calls, undefined);
  assert.equal(execution.status, "error");
  const failure = execution.data.resultData.error;
  assert.equal(failure.message, "Model output doesn't fit required format");
  assert.equal(failure.context.outputParserFailReason, "Invalid JSON in model output");
  const runs = execution.data.resultData.runData;
  assert.equal(runs["Fixture OpenAI Chat Model"].length, 1);
  assert.equal(runs.il_echo_string, undefined);
  assert.equal(runs["Structured Output Parser"].length, 1);
  const parser = runs["Structured Output Parser"][0];
  assert.equal(parser.executionStatus, "error");
  assert.equal(parser.inputOverride.ai_outputParser[0][0].json.text, response.choices[0].message.content);
  assert.equal(parser.error.context.outputParserFailReason, "Invalid JSON in model output");
  assert.equal(parser.data.ai_outputParser[0][0].json.response, undefined);
  assert.equal(runs["Final output agent"][0].executionStatus, "error");
  assert.equal(runs["Final output agent"][0].data, undefined);
  const snapshotParser = execution.data.workflowData.nodes.find((node) => node.type.endsWith(".outputParserStructured"));
  assert.equal(snapshotParser.typeVersion, 1.3);
  assert.equal(snapshotParser.parameters.autoFix, false);
});

test("F0 Agent 3.1 rejects schema-invalid formatter arguments without repair", async () => {
  const root = path.resolve(import.meta.dirname, "fixtures/n8n/captures/2.39.10/f0-agent-3-1-schema-invalid");
  const manifest = await validateRedactedCapture({ directory: root });
  assert.equal(manifest.n8nVersion, "2.39.10");
  assert.deepEqual(manifest.providerFiles, ["provider-request-initial.json", "provider-response-final.json"]);
  const request = await readJson(root, "provider-request-initial.json");
  const response = await readJson(root, "provider-response-final.json");
  const execution = await readJson(root, "execution-error.json");
  assert.equal(request.stream, false);
  assert.equal(response.choices[0].finish_reason, "tool_calls");
  const call = response.choices[0].message.tool_calls[0];
  assert.equal(call.function.name, "format_final_json_response");
  assert.deepEqual(JSON.parse(call.function.arguments), { output: { answer: "IL_F0_ANSWER", count: "IL_F0_WRONG_TYPE" } });
  assert.equal(execution.status, "error");
  assert.equal(execution.data.resultData.error.context.outputParserFailReason, "Model output does not match the expected schema");
  const runs = execution.data.resultData.runData;
  assert.equal(runs["Fixture OpenAI Chat Model"].length, 1);
  assert.equal(runs.il_echo_string, undefined);
  assert.equal(runs["Structured Output Parser"].length, 1);
  const parser = runs["Structured Output Parser"][0];
  assert.equal(parser.executionStatus, "error");
  assert.equal(parser.inputOverride.ai_outputParser[0][0].json.text, call.function.arguments);
  assert.equal(parser.error.context.outputParserFailReason, "Model output does not match the expected schema");
  assert.equal(parser.data.ai_outputParser[0][0].json.response, undefined);
  assert.equal(runs["Final output agent"][0].executionStatus, "error");
  assert.equal(runs["Final output agent"][0].data, undefined);
});

test("F0 Agent 3.1 rejects an extra formatter payload property in a closed schema", async () => {
  const root = path.resolve(import.meta.dirname, "fixtures/n8n/captures/2.39.10/f0-agent-3-1-extra-properties");
  const manifest = await validateRedactedCapture({ directory: root });
  assert.equal(manifest.n8nVersion, "2.39.10");
  assert.deepEqual(manifest.providerFiles, ["provider-request-initial.json", "provider-response-final.json"]);
  const request = await readJson(root, "provider-request-initial.json");
  const response = await readJson(root, "provider-response-final.json");
  const execution = await readJson(root, "execution-error.json");
  const schema = request.tools.find((tool) => tool.function.name === "format_final_json_response").function.parameters.properties.output;
  assert.equal(request.stream, false);
  assert.equal(schema.additionalProperties, false);
  assert.equal(Object.hasOwn(schema.properties, "extra"), false);
  const call = response.choices[0].message.tool_calls[0];
  assert.equal(call.function.name, "format_final_json_response");
  assert.deepEqual(JSON.parse(call.function.arguments), { output: { answer: "IL_F0_ANSWER", count: 7, extra: "IL_F0_EXTRA" } });
  assert.equal(execution.status, "error");
  assert.equal(execution.data.resultData.error.context.outputParserFailReason, "Model output does not match the expected schema");
  const runs = execution.data.resultData.runData;
  assert.equal(runs["Fixture OpenAI Chat Model"].length, 1);
  assert.equal(runs.il_echo_string, undefined);
  assert.equal(runs["Structured Output Parser"].length, 1);
  const parser = runs["Structured Output Parser"][0];
  assert.equal(parser.executionStatus, "error");
  assert.equal(parser.inputOverride.ai_outputParser[0][0].json.text, call.function.arguments);
  assert.equal(parser.data.ai_outputParser[0][0].json.response, undefined);
  assert.equal(runs["Final output agent"][0].executionStatus, "error");
  assert.equal(runs["Final output agent"][0].data, undefined);
});

test("F0 Agent 3.1 rejects a formatter payload missing required count", async () => {
  const root = path.resolve(import.meta.dirname, "fixtures/n8n/captures/2.39.10/f0-agent-3-1-required-missing");
  const manifest = await validateRedactedCapture({ directory: root });
  assert.equal(manifest.n8nVersion, "2.39.10");
  assert.deepEqual(manifest.providerFiles, ["provider-request-initial.json", "provider-response-final.json"]);
  const request = await readJson(root, "provider-request-initial.json");
  const response = await readJson(root, "provider-response-final.json");
  const execution = await readJson(root, "execution-error.json");
  const schema = request.tools.find((tool) => tool.function.name === "format_final_json_response").function.parameters.properties.output;
  assert.equal(request.stream, false);
  assert.deepEqual(schema.required, ["answer", "count"]);
  const call = response.choices[0].message.tool_calls[0];
  assert.equal(call.function.name, "format_final_json_response");
  assert.deepEqual(JSON.parse(call.function.arguments), { output: { answer: "IL_F0_ANSWER" } });
  assert.equal(execution.status, "error");
  assert.equal(execution.data.resultData.error.context.outputParserFailReason, "Model output does not match the expected schema");
  const runs = execution.data.resultData.runData;
  assert.equal(runs["Fixture OpenAI Chat Model"].length, 1);
  assert.equal(runs.il_echo_string, undefined);
  assert.equal(runs["Structured Output Parser"].length, 1);
  const parser = runs["Structured Output Parser"][0];
  assert.equal(parser.executionStatus, "error");
  assert.equal(parser.inputOverride.ai_outputParser[0][0].json.text, call.function.arguments);
  assert.equal(parser.data.ai_outputParser[0][0].json.response, undefined);
  assert.equal(runs["Final output agent"][0].executionStatus, "error");
  assert.equal(runs["Final output agent"][0].data, undefined);
});

test("F0 Agent 3.1 finalizes a formatter-first mixed response without ordinary dispatch", async () => {
  const root = path.resolve(import.meta.dirname, "fixtures/n8n/captures/2.39.10/f0-agent-3-1-mixed");
  const manifest = await validateRedactedCapture({ directory: root });
  assert.equal(manifest.n8nVersion, "2.39.10");
  assert.deepEqual(manifest.providerFiles, ["provider-request-initial.json", "provider-response-final.json"]);
  const request = await readJson(root, "provider-request-initial.json");
  const response = await readJson(root, "provider-response-final.json");
  const execution = await readJson(root, "execution-success.json");
  assert.equal(request.stream, false);
  assert.equal(response.choices[0].finish_reason, "tool_calls");
  const calls = response.choices[0].message.tool_calls;
  assert.deepEqual(calls.map((call) => call.function.name), ["format_final_json_response", "il_echo_string"]);
  assert.notEqual(calls[0].id, calls[1].id);
  assert.deepEqual(JSON.parse(calls[1].function.arguments), { text: "IL_N0_STRING_VALUE" });
  assert.equal(execution.status, "success");
  assert.equal(execution.finished, true);
  const runs = execution.data.resultData.runData;
  assert.equal(runs["Fixture OpenAI Chat Model"].length, 1);
  assert.equal(runs.il_echo_string, undefined);
  assert.equal(runs["Structured Output Parser"].length, 1);
  const parser = runs["Structured Output Parser"][0];
  assert.equal(parser.inputOverride.ai_outputParser[0][0].json.text, calls[0].function.arguments);
  const payload = { output: { answer: "IL_F0_ANSWER", count: 7 } };
  assert.deepEqual(parser.data.ai_outputParser[0][0].json.response, payload);
  assert.deepEqual(runs["Final output agent"][0].data.main[0][0].json, payload);
  assert.equal(runs["Final output agent"][0].metadata.tracing["ai.agent.tool_calls.completed"], 0);
});

test("F0 Agent 3.1 selects the first of two distinct formatter payloads", async () => {
  const root = path.resolve(import.meta.dirname, "fixtures/n8n/captures/2.39.10/f0-agent-3-1-duplicate");
  const manifest = await validateRedactedCapture({ directory: root });
  assert.equal(manifest.n8nVersion, "2.39.10");
  assert.deepEqual(manifest.providerFiles, ["provider-request-initial.json", "provider-response-final.json"]);
  const request = await readJson(root, "provider-request-initial.json");
  const response = await readJson(root, "provider-response-final.json");
  const execution = await readJson(root, "execution-success.json");
  assert.equal(request.stream, false);
  const calls = response.choices[0].message.tool_calls;
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.function.name === "format_final_json_response"));
  assert.notEqual(calls[0].id, calls[1].id);
  const first = JSON.parse(calls[0].function.arguments);
  const second = JSON.parse(calls[1].function.arguments);
  assert.deepEqual(first, { output: { answer: "IL_F0_ANSWER", count: 7 } });
  assert.deepEqual(second, { output: { answer: "IL_F0_SECOND_ANSWER", count: 8 } });
  assert.equal(execution.status, "success");
  const runs = execution.data.resultData.runData;
  assert.equal(runs["Fixture OpenAI Chat Model"].length, 1);
  assert.equal(runs.il_echo_string, undefined);
  assert.equal(runs["Structured Output Parser"].length, 1);
  const parser = runs["Structured Output Parser"][0];
  assert.equal(parser.inputOverride.ai_outputParser[0][0].json.text, calls[0].function.arguments);
  assert.deepEqual(parser.data.ai_outputParser[0][0].json.response, first);
  assert.deepEqual(runs["Final output agent"][0].data.main[0][0].json, first);
});

test("F0 Agent 3.1 selects formatter after an ordinary call in a mixed response", async () => {
  const root = path.resolve(import.meta.dirname, "fixtures/n8n/captures/2.39.10/f0-agent-3-1-mixed-ordinary-first");
  const manifest = await validateRedactedCapture({ directory: root });
  assert.equal(manifest.n8nVersion, "2.39.10");
  assert.deepEqual(manifest.providerFiles, ["provider-request-initial.json", "provider-response-final.json"]);
  const request = await readJson(root, "provider-request-initial.json");
  const response = await readJson(root, "provider-response-final.json");
  const execution = await readJson(root, "execution-success.json");
  assert.equal(request.stream, false);
  const calls = response.choices[0].message.tool_calls;
  assert.deepEqual(calls.map((call) => call.function.name), ["il_echo_string", "format_final_json_response"]);
  assert.equal(execution.status, "success");
  const runs = execution.data.resultData.runData;
  assert.equal(runs["Fixture OpenAI Chat Model"].length, 1);
  assert.equal(runs.il_echo_string, undefined);
  assert.equal(runs["Structured Output Parser"].length, 1);
  assert.equal(runs["Structured Output Parser"][0].inputOverride.ai_outputParser[0][0].json.text, calls[1].function.arguments);
  assert.deepEqual(runs["Final output agent"][0].data.main[0][0].json, { output: { answer: "IL_F0_ANSWER", count: 7 } });
  assert.equal(runs["Final output agent"][0].metadata.tracing["ai.agent.tool_calls.completed"], 0);
});

test("F0 Agent 3.1 preserves authored output inside the formatter output wrapper", async () => {
  const root = path.resolve(import.meta.dirname, "fixtures/n8n/captures/2.39.10/f0-agent-3-1-nested-output");
  const manifest = await validateRedactedCapture({ directory: root });
  assert.equal(manifest.n8nVersion, "2.39.10");
  assert.deepEqual(manifest.providerFiles, ["provider-request-initial.json", "provider-response-final.json"]);
  const request = await readJson(root, "provider-request-initial.json");
  const response = await readJson(root, "provider-response-final.json");
  const execution = await readJson(root, "execution-success.json");
  assert.equal(request.stream, false);
  const snapshot = execution.data.workflowData;
  const parserNode = snapshot.nodes.find((node) => node.type.endsWith(".outputParserStructured"));
  assert.equal(parserNode.typeVersion, 1.3);
  assert.equal(parserNode.parameters.autoFix, false);
  const authored = JSON.parse(parserNode.parameters.inputSchema);
  assert.ok(authored.required.includes("output"));
  assert.deepEqual(authored.properties.output, { type: "object", properties: { label: { type: "string" } }, required: ["label"] });
  const wire = request.tools.find((tool) => tool.function.name === "format_final_json_response").function.parameters;
  assert.equal(Object.hasOwn(authored.properties.output, "additionalProperties"), false);
  assert.deepEqual(wire.properties.output, {
    ...authored,
    properties: {
      ...authored.properties,
      output: { ...authored.properties.output, additionalProperties: false },
    },
  });
  assert.deepEqual(wire.required, ["output"]);
  const call = response.choices[0].message.tool_calls[0];
  assert.equal(call.function.name, "format_final_json_response");
  const expected = { output: { answer: "IL_F0_ANSWER", count: 7, output: { label: "IL_F0_NESTED" } } };
  assert.deepEqual(JSON.parse(call.function.arguments), expected);
  assert.equal(execution.status, "success");
  const runs = execution.data.resultData.runData;
  assert.equal(runs["Fixture OpenAI Chat Model"].length, 1);
  assert.equal(runs.il_echo_string, undefined);
  assert.equal(runs["Structured Output Parser"].length, 1);
  const parsed = runs["Structured Output Parser"][0];
  assert.equal(parsed.inputOverride.ai_outputParser[0][0].json.text, call.function.arguments);
  assert.deepEqual(parsed.data.ai_outputParser[0][0].json.response, expected);
  assert.deepEqual(runs["Final output agent"][0].data.main[0][0].json, expected);
});

test("F0 Manual Trigger with streaming enabled remains buffered on the wire", async () => {
  const root = path.resolve(import.meta.dirname, "fixtures/n8n/captures/2.39.10/f0-agent-3-1-streaming-enabled-buffered");
  const manifest = await validateRedactedCapture({ directory: root });
  assert.equal(manifest.n8nVersion, "2.39.10");
  const request = await readJson(root, "provider-request-initial.json");
  const execution = await readJson(root, "execution-success.json");
  assert.equal(execution.data.workflowData.nodes.find((node) => node.type.endsWith(".agent")).parameters.options.enableStreaming, true);
  assert.equal(request.stream, false);
  assert.equal(execution.status, "success");
  const runs = execution.data.resultData.runData;
  assert.equal(runs["Fixture OpenAI Chat Model"].length, 1);
  assert.equal(runs["Final output agent"][0].metadata.tracing["ai.agent.streaming.enabled"], true);
  assert.deepEqual(runs["Final output agent"][0].data.main[0][0].json, { output: { answer: "IL_F0_ANSWER", count: 7 } });
});

test("F0 Agent 3.1 wraps unwrapped final-text JSON before parser invocation", async () => {
  const root = path.resolve(import.meta.dirname, "fixtures/n8n/captures/2.39.10/f0-agent-3-1-text-unwrapped");
  const manifest = await validateRedactedCapture({ directory: root });
  assert.equal(manifest.n8nVersion, "2.39.10");
  assert.deepEqual(manifest.providerFiles, ["provider-request-initial.json", "provider-response-final.json"]);
  const request = await readJson(root, "provider-request-initial.json");
  const response = await readJson(root, "provider-response-final.json");
  const execution = await readJson(root, "execution-success.json");
  assert.equal(request.stream, false);
  assert.equal(response.choices[0].finish_reason, "stop");
  const message = response.choices[0].message;
  assert.equal(message.tool_calls, undefined);
  const payload = JSON.parse(message.content);
  assert.deepEqual(payload, { answer: "IL_F0_ANSWER", count: 7 });
  assert.equal(Object.hasOwn(payload, "output"), false);
  assert.equal(execution.status, "success");
  const runs = execution.data.resultData.runData;
  assert.equal(runs["Fixture OpenAI Chat Model"].length, 1);
  assert.equal(runs["Fixture OpenAI Chat Model"][0].data.ai_languageModel[0][0].json.response.generations[0][0].text, message.content);
  assert.equal(runs.il_echo_string, undefined);
  assert.equal(runs["Structured Output Parser"].length, 1);
  const parser = runs["Structured Output Parser"][0];
  const wrapped = { output: payload };
  assert.notEqual(parser.inputOverride.ai_outputParser[0][0].json.text, message.content);
  assert.equal(parser.inputOverride.ai_outputParser[0][0].json.text, JSON.stringify(wrapped));
  assert.deepEqual(parser.data.ai_outputParser[0][0].json.response, wrapped);
  assert.deepEqual(runs["Final output agent"][0].data.main[0][0].json, wrapped);
});

test("F0 Agent 3.1 strips extra nested data when authored additionalProperties is omitted", async () => {
  const root = path.resolve(import.meta.dirname, "fixtures/n8n/captures/2.39.10/f0-agent-3-1-nested-output-extra");
  const manifest = await validateRedactedCapture({ directory: root });
  assert.equal(manifest.n8nVersion, "2.39.10");
  assert.deepEqual(manifest.providerFiles, ["provider-request-initial.json", "provider-response-final.json"]);
  const request = await readJson(root, "provider-request-initial.json");
  const response = await readJson(root, "provider-response-final.json");
  const execution = await readJson(root, "execution-success.json");
  assert.equal(request.stream, false);
  const parserNode = execution.data.workflowData.nodes.find((node) => node.type.endsWith(".outputParserStructured"));
  assert.equal(parserNode.parameters.autoFix, false);
  const authored = JSON.parse(parserNode.parameters.inputSchema);
  assert.equal(Object.hasOwn(authored.properties.output, "additionalProperties"), false);
  const wire = request.tools.find((tool) => tool.function.name === "format_final_json_response").function.parameters;
  assert.equal(wire.properties.output.properties.output.additionalProperties, false);
  const call = response.choices[0].message.tool_calls[0];
  const rawValue = JSON.parse(call.function.arguments);
  assert.equal(rawValue.output.output.extra, "IL_F0_NESTED_EXTRA");
  assert.equal(execution.status, "success");
  const runs = execution.data.resultData.runData;
  assert.equal(runs["Fixture OpenAI Chat Model"].length, 1);
  assert.equal(runs.il_echo_string, undefined);
  assert.equal(runs["Structured Output Parser"].length, 1);
  const parser = runs["Structured Output Parser"][0];
  assert.equal(parser.inputOverride.ai_outputParser[0][0].json.text, call.function.arguments);
  const expected = { output: { answer: "IL_F0_ANSWER", count: 7, output: { label: "IL_F0_NESTED" } } };
  assert.deepEqual(parser.data.ai_outputParser[0][0].json.response, expected);
  assert.deepEqual(runs["Final output agent"][0].data.main[0][0].json, expected);
  assert.equal(Object.hasOwn(expected.output.output, "extra"), false);
});
