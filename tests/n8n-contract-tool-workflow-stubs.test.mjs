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
