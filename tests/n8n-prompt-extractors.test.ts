import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { parseExternalPromptCandidate } from "../packages/core/src/external-prompt-import.ts";
import {
  projectExternalPromptTemplate,
} from "../packages/core/src/external-prompt-project.ts";
import {
  defaultN8nPromptExtractors,
  extractN8nPromptCandidates,
  parseN8nWorkflowSnapshot,
  scanN8nExpressionRegions,
  type N8nExecutionDetail,
  type N8nPromptExtractor,
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
  const projection = projectExternalPromptTemplate(compound.candidate);
  assert.equal(projection.content.kind, "fragment");
  assert.equal(
    projection.content.kind === "fragment"
      ? projection.content.text
      : undefined,
    "IL_P0_LITERAL\n" +
      "simple={{topic}}\n" +
      "two={{first}}|{{second}}\n" +
      "compound={{expression_1}}\n" +
      "nested={{expression_2}}\n" +
      "repeated={{first}}|{{repeat}}",
  );
  assert.deepEqual(projection.values, {});
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
  assert.deepEqual(
    compound.candidate.bindings.map(({ expression, status }) => ({
      expression,
      status,
    })),
    [
      { expression: "{{ $json.topic }}", status: "missing" },
      { expression: "{{ $json.first }}", status: "missing" },
      { expression: "{{ $json.second }}", status: "missing" },
      {
        expression:
          "{{\n" +
          "  [$json.topic, $json.second]\n" +
          "    .map((value) => `${value}`)\n" +
          '    .join("::")\n' +
          "}}",
        status: "missing",
      },
      {
        expression:
          "{{ `value:${JSON.stringify({ inner: $json.topic })}` }}",
        status: "missing",
      },
      { expression: "{{ $json.first }}", status: "missing" },
      { expression: "{{ $json.repeat }}", status: "missing" },
    ],
  );
  assert.equal(compound.candidate.invocation.runIndex, 0);
  assert.equal(compound.candidate.invocation.itemIndex, 0);
  assert.doesNotThrow(() => parseExternalPromptCandidate(compound.candidate));
});

test("scans fixture-backed n8n expression regions without evaluating JavaScript", async () => {
  const fixture = JSON.parse(
    await readFile(
      path.resolve(
        import.meta.dirname,
        "fixtures/n8n/parser-cases/expression-regions.json",
      ),
      "utf8",
    ),
  ) as {
    cases: Array<{
      authored: string;
      expressions: string[];
      invalid?: boolean;
    }>;
  };
  for (const parserCase of fixture.cases) {
    const scan = scanN8nExpressionRegions({
      path: "parameters.text",
      role: "user",
      syntax: "external-expression",
      text: parserCase.authored,
    });
    assert.equal(scan.invalid, parserCase.invalid ?? false);
    assert.deepEqual(
      scan.bindings.map(({ expression }) => expression),
      parserCase.expressions,
    );
  }
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

test("a sibling extractor supporting a newer node version is not shadowed", async () => {
  const execution = clone(
    await executionFixture(
      "basic-llm-chain-success",
      "execution-success.json",
    ),
  );
  const workflowData = dataRecord(execution).workflowData as Record<
    string,
    unknown
  >;
  for (const node of workflowData.nodes as Array<Record<string, unknown>>) {
    if (node.type === "@n8n/n8n-nodes-langchain.chainLlm") {
      node.typeVersion = 1.11;
    }
  }

  // Extractors are registered one per supported node version. Registering a
  // newer one alongside the fixture-verified extractor must reach it.
  const nextVersionExtractor: N8nPromptExtractor = {
    id: "basic-llm-chain-1-11",
    recognizes: (node) => node.type === "@n8n/n8n-nodes-langchain.chainLlm",
    supports: (node) => node.typeVersion === 1.11,
    extract: async (_context, node) => [
      {
        status: "unsupported",
        invocation: { id: node.id, name: node.name, type: node.type },
        code: "unsupported-node-configuration",
        message: "handled by the 1.11 extractor",
      },
    ],
  };

  const results = await extractN8nPromptCandidates(execution, undefined, [
    ...defaultN8nPromptExtractors,
    nextVersionExtractor,
  ]);
  assert.ok(
    results.length > 0 &&
      results.every(
        (result) =>
          result.status === "unsupported" &&
          result.message === "handled by the 1.11 extractor",
      ),
    "every recognized node should reach the extractor supporting its version",
  );

  // Without a sibling that supports the version, the unsupported result stands.
  const withoutSibling = await extractN8nPromptCandidates(execution, undefined, [
    ...defaultN8nPromptExtractors,
  ]);
  assert.ok(
    withoutSibling.every(
      (result) =>
        result.status === "unsupported" &&
        result.code === "unsupported-node-version",
    ),
  );
});

test("an unreadable node is skipped instead of failing the whole workflow", async () => {
  const execution = clone(
    await executionFixture(
      "basic-llm-chain-success",
      "execution-success.json",
    ),
  );
  const runData = runDataRecord(execution);
  const parentRuns = runData["Compound prompt cases"] as Array<{
    data: { main: unknown[][] };
  }>;
  parentRuns[0]!.data.main[0] = parentRuns[0]!.data.main[0]!.slice(0, 1);
  runData["Fixture OpenAI Chat Model"] = (
    runData["Fixture OpenAI Chat Model"] as unknown[]
  ).slice(0, 1);

  const workflowData = dataRecord(execution).workflowData as Record<
    string,
    unknown
  >;
  const nodes = workflowData.nodes as Array<Record<string, unknown>>;
  // An unrelated node this importer cannot read must not block the import, and
  // must not be reported: no extractor would have inspected it.
  nodes.push({ id: "node_opaque", name: "Opaque node", type: "unknown.node" });
  // A recognized node that cannot be read is reported instead of vanishing.
  nodes.push({
    id: "node_broken",
    name: "Broken chain",
    type: "@n8n/n8n-nodes-langchain.chainLlm",
  });

  const results = await extractN8nPromptCandidates(execution);
  const compound = results.find(
    (result) =>
      result.status === "candidate" &&
      result.candidate.invocation.name === "Compound prompt cases",
  );
  assert.ok(compound?.status === "candidate");
  assert.equal(compound.candidate.fidelity, "execution-reconstructed");

  assert.deepEqual(
    results.find(
      (result) =>
        result.status === "unsupported" && result.invocation.id === "node_broken",
    ),
    {
      status: "unsupported",
      invocation: {
        id: "node_broken",
        name: "Broken chain",
        type: "@n8n/n8n-nodes-langchain.chainLlm",
      },
      code: "incompatible-node-snapshot",
      message:
        "@n8n/n8n-nodes-langchain.chainLlm could not be read from the saved workflow snapshot, so its prompt cannot be reviewed.",
    },
  );
  assert.equal(
    results.some(
      (result) =>
        result.status === "unsupported" && result.invocation.id === "node_opaque",
    ),
    false,
  );
});

test("an unreadable workflow envelope is still rejected", () => {
  for (const envelope of [
    undefined,
    null,
    "workflow",
    [],
    { name: "no id", nodes: [], connections: {} },
    { id: "w", nodes: [], connections: {} },
    { id: "w", name: "no nodes", connections: {} },
    { id: "w", name: "bad nodes", nodes: "changed shape", connections: {} },
    { id: "w", name: "no connections", nodes: [] },
  ]) {
    assert.equal(
      parseN8nWorkflowSnapshot(envelope),
      undefined,
      `expected ${JSON.stringify(envelope)} to be unreadable`,
    );
  }

  assert.deepEqual(
    parseN8nWorkflowSnapshot({
      id: "w",
      name: "Readable",
      nodes: [{}],
      connections: {},
    }),
    { id: "w", name: "Readable", nodes: [], unparsedNodes: [], connections: {} },
  );
});
