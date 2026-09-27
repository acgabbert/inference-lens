import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const fixtureRoot = path.resolve(
  import.meta.dirname,
  "fixtures/n8n/tool-workflow-stubs",
);

const scenarios = [
  {
    id: "string-input",
    toolName: "il_echo_string",
    inputNames: ["text"],
    sentinel: "IL_N0_STRING_INPUT",
  },
  {
    id: "primitive-inputs",
    toolName: "il_echo_primitives",
    inputNames: ["text", "count", "enabled"],
    sentinel: "IL_N0_PRIMITIVE_INPUTS",
  },
  {
    id: "multiple-output-items",
    toolName: "il_multiple_items",
    inputNames: ["topic"],
    sentinel: "IL_N0_MULTIPLE_OUTPUT_ITEMS",
  },
  {
    id: "fixed-and-ai-inputs",
    toolName: "il_fixed_and_ai",
    inputNames: ["text", "source"],
    sentinel: "IL_N0_FIXED_AND_AI",
  },
  {
    id: "fixed-only-input",
    toolName: "il_fixed_only",
    inputNames: ["source"],
    sentinel: "IL_N0_FIXED_ONLY",
  },
  {
    id: "empty-output",
    toolName: "il_empty_output",
    inputNames: ["topic"],
    sentinel: "IL_N0_EMPTY_OUTPUT",
  },
  {
    id: "nested-inputs",
    toolName: "il_nested_inputs",
    inputNames: ["payload", "tags"],
    sentinel: "IL_N0_NESTED_INPUTS",
  },
  {
    id: "workflow-error",
    toolName: "il_workflow_error",
    inputNames: ["reason"],
    sentinel: "IL_N0_WORKFLOW_ERROR",
  },
  {
    id: "rejected-arguments",
    toolName: "il_rejected_arguments",
    inputNames: ["count"],
    sentinel: "IL_N0_REJECTED_ARGUMENTS",
  },
];

async function readJson(filename) {
  return JSON.parse(await readFile(path.join(fixtureRoot, filename), "utf8"));
}

function nodesOfType(workflow, type) {
  return workflow.nodes.filter((node) => node.type === type);
}

test("n8n tool reference parents preserve the measured node-version boundary", async () => {
  for (const scenario of scenarios) {
    const workflow = await readJson(`${scenario.id}.parent.json`);
    const agents = nodesOfType(
      workflow,
      "@n8n/n8n-nodes-langchain.agent",
    );
    const models = nodesOfType(
      workflow,
      "@n8n/n8n-nodes-langchain.lmChatOpenAi",
    );
    const tools = nodesOfType(
      workflow,
      "@n8n/n8n-nodes-langchain.toolWorkflow",
    );

    assert.equal(workflow.active, false);
    assert.deepEqual(workflow.tags, []);
    assert.deepEqual(workflow.pinData, {});
    assert.equal(workflow.settings.executionOrder, "v1");
    assert.equal(nodesOfType(workflow, "n8n-nodes-base.manualTrigger").length, 1);
    assert.equal(agents.length, 1);
    assert.equal(agents[0].typeVersion, 3.1);
    assert.equal(models.length, 1);
    assert.equal(models[0].typeVersion, 1.2);
    assert.equal(models[0].parameters.model.value, "template-echo-model");
    assert.equal(tools.length, 1);
    assert.equal(tools[0].typeVersion, 2.2);
    assert.equal(tools[0].name, scenario.toolName);
    assert.equal(tools[0].parameters.source, "database");
    assert.equal(tools[0].parameters.workflowId.value, "");
    assert.deepEqual(
      tools[0].parameters.workflowInputs.schema.map(({ id }) => id),
      scenario.inputNames,
    );
    assert.match(JSON.stringify(workflow), new RegExp(scenario.sentinel));

    const toolConnections =
      workflow.connections[scenario.toolName]?.ai_tool?.[0] ?? [];
    assert.deepEqual(toolConnections, [
      {
        node: agents[0].name,
        type: "ai_tool",
        index: 0,
      },
    ]);

    assert.doesNotMatch(
      JSON.stringify(workflow),
      /"credentials"|"webhookId"|"instanceId"|"projectId"|"versionId"/i,
    );
  }
});

test("n8n tool reference sub-workflows expose matching declared inputs", async () => {
  for (const scenario of scenarios) {
    const workflow = await readJson(`${scenario.id}.subworkflow.json`);
    const triggers = nodesOfType(
      workflow,
      "n8n-nodes-base.executeWorkflowTrigger",
    );

    assert.equal(workflow.active, false);
    assert.deepEqual(workflow.tags, []);
    assert.deepEqual(workflow.pinData, {});
    assert.equal(workflow.settings.executionOrder, "v1");
    assert.equal(triggers.length, 1);
    assert.equal(triggers[0].typeVersion, 1.1);
    assert.deepEqual(
      triggers[0].parameters.workflowInputs.values.map(({ name }) => name),
      scenario.inputNames,
    );
    assert.match(JSON.stringify(workflow), new RegExp(scenario.sentinel));
    assert.doesNotMatch(
      JSON.stringify(workflow),
      /"credentials"|"webhookId"|"instanceId"|"projectId"|"versionId"/i,
    );
  }
});

test("n8n tool reference fixtures use import-safe unique node IDs", async () => {
  const ids = new Set();

  for (const scenario of scenarios) {
    for (const suffix of ["parent", "subworkflow"]) {
      const workflow = await readJson(`${scenario.id}.${suffix}.json`);
      for (const node of workflow.nodes) {
        assert.match(
          node.id,
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
        assert.equal(ids.has(node.id), false, `${node.id} must be unique`);
        ids.add(node.id);
      }
    }
  }
});

test("multiple-attached-tools parent exposes both tools in declared order", async () => {
  const workflow = await readJson("multiple-attached-tools.parent.json");
  const tools = nodesOfType(workflow, "@n8n/n8n-nodes-langchain.toolWorkflow");
  assert.deepEqual(tools.map(({ name }) => name), [
    "il_echo_string",
    "il_echo_primitives",
  ]);
  assert.match(JSON.stringify(workflow), /IL_N0_MULTIPLE_ATTACHED_TOOLS/);
  for (const tool of tools) {
    assert.equal(tool.parameters.workflowId.value, "");
    assert.equal(workflow.connections[tool.name].ai_tool[0][0].node, "Multiple attached tools agent");
  }
  assert.equal(new Set(workflow.nodes.map(({ id }) => id)).size, workflow.nodes.length);
});

test("fixed-only tool maps its sole input without an AI expression", async () => {
  const workflow = await readJson("fixed-only-input.parent.json");
  const tool = nodesOfType(workflow, "@n8n/n8n-nodes-langchain.toolWorkflow")[0];
  assert.deepEqual(tool.parameters.workflowInputs.value, {
    source: "IL_N0_FIXED_SOURCE",
  });
});

test("fixed and AI input parents isolate AI Agent versions 2.2, 3, and 3.1", async () => {
  const baseline = await readJson("fixed-and-ai-inputs.parent.json");
  const variants = [
    ["2.2", 2.2],
    ["3", 3],
  ];
  const allIds = new Set(baseline.nodes.map(({ id }) => id));

  for (const [label, version] of variants) {
    const workflow = await readJson(`fixed-and-ai-inputs-agent-${label}.parent.json`);
    const agent = nodesOfType(workflow, "@n8n/n8n-nodes-langchain.agent")[0];
    assert.equal(agent.typeVersion, version);
    assert.equal(workflow.name, `[Inference Lens N0] Fixed and AI inputs — Agent ${label}`);
    assert.equal(workflow.active, false);
    assert.deepEqual(workflow.tags, []);
    assert.deepEqual(workflow.pinData, {});
    assert.doesNotMatch(
      JSON.stringify(workflow),
      /"credentials"|"webhookId"|"instanceId"|"projectId"|"versionId"/i,
    );

    for (const node of workflow.nodes) {
      assert.equal(allIds.has(node.id), false, `${node.id} must be unique`);
      allIds.add(node.id);
    }

    const normalized = structuredClone(workflow);
    normalized.name = baseline.name;
    normalized.nodes.forEach((node, index) => {
      node.id = baseline.nodes[index].id;
      if (node.type === "@n8n/n8n-nodes-langchain.agent") {
        node.typeVersion = 3.1;
      }
    });
    assert.deepEqual(normalized, baseline);
  }
});
