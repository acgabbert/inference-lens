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
