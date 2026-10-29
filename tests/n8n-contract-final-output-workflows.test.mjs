import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const root = new URL("./fixtures/n8n/final-output-workflows/", import.meta.url);
test("formatter staging workflows pin node versions and contain no instance metadata", async () => {
  const ids = new Set();
  const matrix = [];
  for (const filename of (await readdir(root)).filter((name) => name.endsWith(".json"))) {
    const workflow = JSON.parse(await readFile(new URL(filename, root), "utf8"));
    assert.equal(workflow.active, false);
    assert.doesNotMatch(JSON.stringify(workflow), /"credentials"|"webhookId"|"instanceId"|"projectId"|"versionId"/i);
    for (const node of workflow.nodes) {
      assert.equal(ids.has(node.id), false);
      ids.add(node.id);
    }
    if (filename === "echo-child.json") continue;
    const agent = workflow.nodes.find((node) => node.type.endsWith(".agent"));
    const model = workflow.nodes.find((node) => node.type.endsWith(".lmChatOpenAi"));
    const parser = workflow.nodes.find((node) => node.type.endsWith(".outputParserStructured"));
    assert.equal(agent.parameters.hasOutputParser, true);
    assert.equal(model.typeVersion, 1.2);
    assert.equal(model.parameters.model.value, "template-echo-model");
    assert.equal(parser.typeVersion, 1.3);
    assert.equal(parser.parameters.schemaType, "manual");
    const schema = JSON.parse(parser.parameters.inputSchema);
    assert.deepEqual(schema.required.slice(0, 2), ["answer", "count"]);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(workflow.connections[parser.name].ai_outputParser, [[{ node: agent.name, type: "ai_outputParser", index: 0 }]]);
    if (!filename.startsWith("nested-")) matrix.push(`${agent.typeVersion}:${agent.parameters.options.enableStreaming}`);
  }
  assert.deepEqual(matrix.sort(), ["2.2:false", "2.2:true", "3:false", "3:true", "3.1:false", "3.1:true"].sort());
});
