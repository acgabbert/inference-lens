import assert from "node:assert/strict";
import test from "node:test";

import {
  PROJECT_FILE_NAME,
  ProjectValidationError,
  createProjectFile,
  parseProjectFile,
  parseProjectJson,
  projectDraft,
  serializeProjectFile,
  updateProjectDraft,
} from "../packages/core/src/project.ts";
import { resolveProviderCapabilities } from "../packages/core/src/types.ts";

const request = {
  provider: "openai-compatible" as const,
  endpoint: "https://api.example.com/v1",
  model: "example-model",
  messages: [
    { role: "system" as const, content: "Be concise." },
    { role: "user" as const, content: "Hello" },
  ],
  temperature: 0.4,
  capabilities: resolveProviderCapabilities("openai-compatible", {
    tools: true,
  }),
};

test("creates a strict, portable Project v2 document", () => {
  const project = createProjectFile({
    name: "Example",
    request,
    idSuffix: "example",
    createdAt: "2026-07-24T12:00:00.000Z",
  });

  assert.equal(PROJECT_FILE_NAME, "trace-lens.project.json");
  assert.equal(project.schemaVersion, 2);
  assert.equal(project.projectId, "project_example");
  assert.deepEqual(projectDraft(project), {
    connectionRequirement: {
      id: "connection_example-default",
      name: "Default connection",
      provider: "openai-compatible",
      protocol: "openai-compatible-chat-completions",
      endpoint: "https://api.example.com/v1",
      capabilityOverrides: request.capabilities,
    },
    messages: request.messages,
    model: "example-model",
    temperature: 0.4,
    tools: [],
    toolMocks: [],
    enabledToolIds: [],
  });
  assert.equal(JSON.parse(serializeProjectFile(project)).schemaVersion, 2);
});

test("serialization is deterministic and ends with a newline", () => {
  const project = createProjectFile({
    name: "Example",
    request,
    idSuffix: "stable",
    createdAt: "2026-07-24T12:00:00.000Z",
  });
  project.tools.push({
    id: "tool_search",
    name: "search",
    inputSchema: {
      type: "object",
      properties: {
        zeta: { type: "string" },
        alpha: { type: "string" },
      },
    },
  });
  project.defaults.enabledToolIds.push("tool_search");

  const serialized = serializeProjectFile(project);
  assert.equal(serialized, serializeProjectFile(parseProjectJson(serialized)));
  assert.ok(serialized.endsWith("\n"));
  assert.ok(serialized.indexOf('"schemaVersion"') < serialized.indexOf('"projectId"'));
  assert.ok(serialized.indexOf('"alpha"') < serialized.indexOf('"zeta"'));
});

test("updates the active draft without dropping project-owned collections", () => {
  const project = createProjectFile({
    name: "Example",
    request,
    idSuffix: "draft",
    createdAt: "2026-07-24T12:00:00.000Z",
  });
  project.tools.push({
    id: "tool_lookup",
    name: "lookup",
    inputSchema: { type: "object" },
  });

  const updated = updateProjectDraft(
    project,
    {
      messages: [{ role: "user", content: "Updated" }],
      model: "new-model",
      temperature: 0,
      tools: project.tools,
      toolMocks: project.toolMocks,
      enabledToolIds: project.defaults.enabledToolIds,
    },
    "update",
  );

  assert.equal(updated.tools[0]?.id, "tool_lookup");
  assert.equal(updated.defaults.target.model, "new-model");
  assert.equal(updated.defaults.options.temperature, 0);
  assert.deepEqual(projectDraft(updated).messages, [
    { role: "user", content: "Updated" },
  ]);
});

test("rejects unsupported versions, unknown fields, and dangling references", () => {
  const project = createProjectFile({
    name: "Example",
    request,
    idSuffix: "invalid",
    createdAt: "2026-07-24T12:00:00.000Z",
  });

  assert.throws(
    () => parseProjectFile({ ...project, schemaVersion: 1 }),
    ProjectValidationError,
  );
  assert.throws(
    () => parseProjectFile({ ...project, credentialRef: "local-secret" }),
    /Unrecognized key/,
  );
  assert.throws(
    () =>
      parseProjectFile({
        ...project,
        defaults: {
          ...project.defaults,
          enabledToolIds: ["tool_missing"],
        },
      }),
    /does not exist/,
  );
});

test("rejects credentials at portable project boundaries", () => {
  const project = createProjectFile({
    name: "Example",
    request,
    idSuffix: "secrets",
    createdAt: "2026-07-24T12:00:00.000Z",
  });

  project.connectionRequirements[0].endpoint =
    "https://api.example.com/v1?api_key=secret";
  assert.throws(() => parseProjectFile(project), /must not contain credentials/);

  project.connectionRequirements[0].endpoint = "https://api.example.com/v1";
  project.defaults.options.providerOptions = {
    authorization: "Bearer secret",
  };
  assert.throws(() => parseProjectFile(project), /not portable project data/);
});

test("rejects mock and template references outside their owners", () => {
  const project = createProjectFile({
    name: "Example",
    request,
    idSuffix: "references",
    createdAt: "2026-07-24T12:00:00.000Z",
  });
  project.toolMocks.push({
    id: "tool-mock_missing",
    toolId: "tool_missing",
    name: "Missing fixture",
    enabled: true,
    match: { kind: "always" },
    result: { content: [{ type: "text", text: "{}" }] },
  });
  project.promptTemplates.push({
    id: "template_summary",
    name: "Summary",
    currentRevisionId: "template-revision_other",
    revisions: [
      {
        id: "template-revision_summary-1",
        createdAt: "2026-07-24T12:00:00.000Z",
        content: { kind: "fragment", text: "Summarize {{input}}" },
        variableDefaults: {},
      },
    ],
  });

  assert.throws(() => parseProjectFile(project), /unknown tool/);
  project.toolMocks = [];
  assert.throws(
    () => parseProjectFile(project),
    /does not belong to this template/,
  );
});
