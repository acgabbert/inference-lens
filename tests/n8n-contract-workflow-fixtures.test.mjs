import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const workflowRoot = path.resolve(
  import.meta.dirname,
  "fixtures/n8n/workflows",
);

const fixtureSpecifications = [
  {
    filename: "ai-agent-2.2.contract.json",
    type: "@n8n/n8n-nodes-langchain.agent",
    version: 2.2,
    sentinel: "IL_AGENT_2_2",
    family: "agent",
  },
  {
    filename: "ai-agent-3.contract.json",
    type: "@n8n/n8n-nodes-langchain.agent",
    version: 3,
    sentinel: "IL_AGENT_3",
    family: "agent",
  },
  {
    filename: "ai-agent-3.1.contract.json",
    type: "@n8n/n8n-nodes-langchain.agent",
    version: 3.1,
    sentinel: "IL_AGENT_3_1",
    family: "agent",
  },
  {
    filename: "message-a-model-1.2.contract.json",
    type: "@n8n/n8n-nodes-langchain.openAi",
    version: 1.2,
    sentinel: "IL_MESSAGE_1_2",
    family: "message",
  },
  {
    filename: "message-a-model-1.3.contract.json",
    type: "@n8n/n8n-nodes-langchain.openAi",
    version: 1.3,
    sentinel: "IL_MESSAGE_1_3",
    family: "message",
  },
];

async function readWorkflow(filename) {
  return JSON.parse(
    await readFile(path.join(workflowRoot, filename), "utf8"),
  );
}

function targetNode(workflow, specification) {
  return workflow.nodes.find(
    (node) =>
      node.type === specification.type &&
      node.typeVersion === specification.version,
  );
}

test("contract workflows isolate every requested node version", async () => {
  for (const specification of fixtureSpecifications) {
    const workflow = await readWorkflow(specification.filename);
    const target = targetNode(workflow, specification);

    assert.ok(target, `${specification.filename} must retain its target version`);
    assert.equal(workflow.active, false);
    assert.deepEqual(workflow.tags, []);
    assert.deepEqual(workflow.pinData, {});
    assert.equal(workflow.settings.executionOrder, "v1");
    assert.equal(
      workflow.nodes.filter(
        (node) => node.type === "n8n-nodes-base.manualTrigger",
      ).length,
      1,
    );
    assert.equal(
      workflow.nodes.filter((node) => node.type === "n8n-nodes-base.code")
        .length,
      1,
    );
    assert.ok(
      workflow.nodes.every((node) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          node.id,
        ),
      ),
      `${specification.filename} must use import-safe UUID node IDs`,
    );

    const serialized = JSON.stringify(workflow);
    assert.match(serialized, new RegExp(specification.sentinel));
    assert.doesNotMatch(
      serialized,
      /"credentials"|"webhookId"|"instanceId"|"homeProject"/i,
    );
  }
});

test("AI Agent contracts use one fixture-verified model and no optional topology", async () => {
  for (const specification of fixtureSpecifications.filter(
    ({ family }) => family === "agent",
  )) {
    const workflow = await readWorkflow(specification.filename);
    const target = targetNode(workflow, specification);
    const models = workflow.nodes.filter(
      (node) => node.type === "@n8n/n8n-nodes-langchain.lmChatOpenAi",
    );

    assert.equal(models.length, 1);
    assert.equal(models[0].typeVersion, 1.2);
    assert.equal(models[0].parameters.model.value, "template-echo-model");
    assert.equal(models[0].parameters.options.temperature, 0);
    assert.equal(target.parameters.promptType, "define");
    assert.equal(target.parameters.hasOutputParser, false);
    assert.equal(target.parameters.options.enableStreaming, false);
    assert.match(target.parameters.options.systemMessage, /_SYSTEM/);

    const modelConnections =
      workflow.connections[models[0].name]?.ai_languageModel?.[0] ?? [];
    assert.deepEqual(modelConnections, [
      {
        node: target.name,
        type: "ai_languageModel",
        index: 0,
      },
    ]);
    assert.equal(JSON.stringify(workflow.connections).includes("ai_tool"), false);
    assert.equal(JSON.stringify(workflow.connections).includes("ai_memory"), false);
    assert.equal(
      JSON.stringify(workflow.connections).includes("ai_outputParser"),
      false,
    );
  }
});

test("Message a Model contracts preserve ordered authored roles", async () => {
  for (const specification of fixtureSpecifications.filter(
    ({ family }) => family === "message",
  )) {
    const workflow = await readWorkflow(specification.filename);
    const target = targetNode(workflow, specification);
    const messages = target.parameters.messages.values;

    assert.equal(target.parameters.resource, "text");
    assert.equal(target.parameters.operation, "message");
    assert.equal(target.parameters.modelId.value, "template-echo-model");
    assert.deepEqual(
      messages.map(({ role }) => role),
      ["system", "assistant", "user"],
    );
    assert.ok(messages.every(({ content }) => content.startsWith("=")));
    assert.equal(target.parameters.options.temperature, 0);
    assert.equal(target.parameters.options.maxTokens, 64);
    assert.equal(
      workflow.nodes.some(
        (node) => node.type === "@n8n/n8n-nodes-langchain.lmChatOpenAi",
      ),
      false,
    );
  }
});
