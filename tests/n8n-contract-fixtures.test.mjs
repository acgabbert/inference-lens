import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { validateRedactedCapture } from "../scripts/n8n-contract-lib.mjs";

const fixtureRoot = path.resolve(
  import.meta.dirname,
  "fixtures/n8n/captures/2.32.5",
);

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
  assert.ok(fixture.cases.some((entry) => entry.invalid === true));
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
