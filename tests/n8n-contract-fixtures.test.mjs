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
    "basic-llm-chain-invalid-syntax",
    "basic-llm-chain-success",
    "basic-llm-chain-whole-field",
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
