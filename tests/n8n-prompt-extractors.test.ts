import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { parseExternalPromptCandidate } from "../packages/core/src/external-prompt-import.ts";
import {
  extractN8nPromptCandidates,
  type N8nExecutionDetail,
  type N8nWorkflowDetail,
} from "../services/api/src/index.ts";

const fixtureRoot = path.resolve(
  import.meta.dirname,
  "fixtures/n8n/captures/2.32.5",
);

async function executionFixture(
  directory: string,
  filename: string,
): Promise<N8nExecutionDetail> {
  return JSON.parse(
    await readFile(path.join(fixtureRoot, directory, filename), "utf8"),
  ) as N8nExecutionDetail;
}

async function workflowFixture(
  directory: string,
): Promise<N8nWorkflowDetail> {
  return JSON.parse(
    await readFile(path.join(fixtureRoot, directory, "workflow.json"), "utf8"),
  ) as N8nWorkflowDetail;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function dataRecord(execution: N8nExecutionDetail): Record<string, unknown> {
  assert.ok(execution.data && typeof execution.data === "object");
  return execution.data as Record<string, unknown>;
}

function runDataRecord(execution: N8nExecutionDetail): Record<string, unknown> {
  const resultData = dataRecord(execution).resultData as Record<string, unknown>;
  return resultData.runData as Record<string, unknown>;
}

test("the fixture-proven multi-item Basic LLM Chain fails closed with authored provenance", async () => {
  const execution = await executionFixture(
    "basic-llm-chain-success",
    "execution-success.json",
  );
  const results = await extractN8nPromptCandidates(execution);
  const compound = results.find(
    (result) =>
      result.status === "candidate" &&
      result.candidate.invocation.name === "Compound prompt cases",
  );
  assert.ok(compound?.status === "candidate");
  assert.equal(compound.candidate.fidelity, "authored-only");
  assert.equal(compound.candidate.resolved, undefined);
  assert.equal(compound.candidate.bindings[0]?.status, "missing");
  assert.equal(
    compound.candidate.warnings[0]?.code,
    "multiple-input-items",
  );
  assert.doesNotThrow(() => parseExternalPromptCandidate(compound.candidate));
});

test("a single-item Basic LLM Chain produces a validated reconstructed user message", async () => {
  const captured = await executionFixture(
    "basic-llm-chain-success",
    "execution-success.json",
  );
  const execution = clone(captured);
  const runData = runDataRecord(execution);
  const parentRuns = runData["Compound prompt cases"] as Array<{
    data: { main: unknown[][] };
  }>;
  parentRuns[0]!.data.main[0] = parentRuns[0]!.data.main[0]!.slice(0, 1);
  const modelRuns = runData["Fixture OpenAI Chat Model"] as unknown[];
  runData["Fixture OpenAI Chat Model"] = modelRuns.slice(0, 1);

  const results = await extractN8nPromptCandidates(execution);
  const compound = results.find(
    (result) =>
      result.status === "candidate" &&
      result.candidate.invocation.name === "Compound prompt cases",
  );
  assert.ok(compound?.status === "candidate");
  assert.equal(compound.candidate.fidelity, "execution-reconstructed");
  assert.deepEqual(compound.candidate.resolved, {
    messages: [
      {
        role: "user",
        content:
          "IL_P0_LITERAL\n" +
          "simple=IL_P0_TOPIC_ALPHA\n" +
          "two=IL_P0_REPEAT|IL_P0_SECOND_ALPHA\n" +
          "compound=IL_P0_TOPIC_ALPHA::IL_P0_SECOND_ALPHA\n" +
          'nested=value:{"inner":"IL_P0_TOPIC_ALPHA"}\n' +
          "repeated=IL_P0_REPEAT|IL_P0_REPEAT",
      },
    ],
    model: "template-echo-model",
    options: { temperature: 0 },
  });
  assert.deepEqual(compound.candidate.bindings, [
    {
      authoredPath: "parameters.text",
      expression: compound.candidate.authored[0]!.text,
      source: { kind: "whole-field" },
      resolvedValue: compound.candidate.resolved?.messages[0]?.content,
      status: "resolved",
      valueEvidence: {
        kind: "saved-parameter-value",
        path:
          'data.resultData.runData["Fixture OpenAI Chat Model"]' +
          "[0].inputOverride.ai_languageModel[0][0].json.messages[0]",
      },
    },
  ]);
  assert.equal(compound.candidate.invocation.runIndex, 0);
  assert.equal(compound.candidate.invocation.itemIndex, 0);
  assert.doesNotThrow(() => parseExternalPromptCandidate(compound.candidate));
});

test("missing model evidence degrades to authored-only instead of inferring from parent output", async () => {
  const execution = await executionFixture(
    "basic-llm-chain-invalid-syntax",
    "execution-error.json",
  );
  const results = await extractN8nPromptCandidates(execution);
  assert.equal(results.length, 2);
  const compound = results.find(
    (result) =>
      result.status === "candidate" &&
      result.candidate.invocation.name === "Compound prompt cases",
  );
  assert.ok(compound?.status === "candidate");
  assert.equal(compound.candidate.fidelity, "authored-only");
  assert.equal(
    compound.candidate.warnings[0]?.code,
    "execution-detail-unavailable",
  );
});

test("missing retained execution data falls back to current authored text with an explicit compatibility warning", async () => {
  const workflow = await workflowFixture("basic-llm-chain-success");
  const execution: N8nExecutionDetail = {
    id: "execution_without_data",
    workflowId: "workflow_fixture",
    status: "success",
    startedAt: "2026-07-28T12:00:00.000Z",
    data: null,
  };
  const results = await extractN8nPromptCandidates(execution, workflow);
  const compound = results.find(
    (result) =>
      result.status === "candidate" &&
      result.candidate.invocation.name === "Compound prompt cases",
  );
  assert.ok(compound?.status === "candidate");
  assert.equal(compound.candidate.fidelity, "authored-only");
  assert.deepEqual(
    compound.candidate.warnings.map(({ code }) => code),
    ["execution-detail-unavailable", "current-workflow-snapshot"],
  );
  assert.equal(compound.candidate.source.resource.id, "workflow_fixture");
  assert.equal(
    compound.candidate.source.execution?.id,
    "execution_without_data",
  );
});

test("recognized future Basic LLM Chain versions are explicit unsupported results", async () => {
  const execution = await executionFixture(
    "basic-llm-chain-success",
    "execution-success.json",
  );
  const workflowData = dataRecord(execution).workflowData as {
    nodes: Array<{ name: string; typeVersion: number }>;
  };
  workflowData.nodes.find(
    (node) => node.name === "Compound prompt cases",
  )!.typeVersion = 2;

  const results = await extractN8nPromptCandidates(execution);
  const unsupported = results.find(
    (result) =>
      result.status === "unsupported" &&
      result.invocation.name === "Compound prompt cases",
  );
  assert.deepEqual(unsupported, {
    status: "unsupported",
    invocation: {
      id: "node_fixture_003",
      name: "Compound prompt cases",
      type: "@n8n/n8n-nodes-langchain.chainLlm",
      version: "2",
    },
    code: "unsupported-node-version",
    message:
      "@n8n/n8n-nodes-langchain.chainLlm@2 is recognized, but this importer supports only a fixture-verified node version.",
  });
});
