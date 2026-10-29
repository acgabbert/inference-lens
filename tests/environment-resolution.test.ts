import assert from "node:assert/strict";
import test from "node:test";

import { resolveEnvironment } from "../packages/core/src/environment.ts";
import type { ProjectEnvironment } from "../packages/core/src/environment.ts";
import {
  createProjectFile,
  createPromptTemplate,
  insertPromptTemplateUse,
  parseProjectFile,
  prepareProjectRevisionRun,
  resolveProjectRevision,
  updatePromptTemplateUseValues,
} from "../packages/core/src/project.ts";
import type { ProjectFile } from "../packages/core/src/project.ts";
import { resolveProviderCapabilities } from "../packages/core/src/types.ts";
import { resolveProjectDefaultsRun } from "../packages/runner/src/repeated-start.ts";

const environment: ProjectEnvironment = {
  id: "environment_staging",
  name: "Staging",
  entries: [
    { name: "fromEnvironment", value: "env-1" },
    { name: "shadowedByDefault", value: "env-2" },
    { name: "shadowedByUse", value: "env-3" },
    { name: "shadowedByEmpty", value: "env-4" },
    { name: "shadowedByRun", value: "env-5" },
    { name: "derived", value: "<{{fromEnvironment}}>" },
    { name: "unused", value: "never sent" },
  ],
};

const content = [
  "{{onlyDefault}}",
  "{{fromEnvironment}}",
  "{{shadowedByDefault}}",
  "{{shadowedByUse}}",
  "{{shadowedByEmpty}}",
  "{{shadowedByRun}}",
  "{{derived}}",
].join("|");

function project(): ProjectFile {
  let value = createProjectFile({
    name: "Environment precedence",
    request: {
      provider: "openai-compatible",
      endpoint: "https://api.example.com/v1",
      model: "example-model",
      messages: [],
      capabilities: resolveProviderCapabilities("openai-compatible", {}),
    },
    idSuffix: "precedence",
    createdAt: "2026-10-29T12:00:00.000Z",
  });
  value = createPromptTemplate(value, {
    name: "Precedence",
    messages: [{ role: "user", content }],
    variableDefaults: { onlyDefault: "default-0", shadowedByDefault: "default-2", shadowedByUse: "default-3" },
    idSuffix: "precedence",
    revisionIdSuffix: "precedence-1",
    createdAt: "2026-10-29T12:00:01.000Z",
  });
  value = insertPromptTemplateUse(value, {
    conversationRevisionId: value.defaults.conversationRevisionId,
    templateId: "template_precedence",
    idSuffix: "precedence",
    outputMessageIdSuffixes: ["precedence"],
  });
  return updatePromptTemplateUseValues(value, {
    conversationRevisionId: value.defaults.conversationRevisionId,
    templateUseId: "template-use_precedence",
    values: { shadowedByUse: "use-3", shadowedByEmpty: "" },
  });
}

function revision(source: ProjectFile) {
  return source.conversationRevisions.find(({ id }) => id === source.defaults.conversationRevisionId)!;
}

test("an environment sits between template defaults and use values, and every value records its source", () => {
  const source = project();
  const resolved = resolveProjectRevision(
    source,
    revision(source),
    { "template-use_precedence": { shadowedByRun: "run-5" } },
    { environment: resolveEnvironment(environment) },
  );

  const [use] = resolved.templateResolutions;
  assert.equal(
    resolved.messages[0]!.content[0]!.type === "text" && resolved.messages[0]!.content[0]!.text,
    "default-0|env-1|env-2|use-3||run-5|<env-1>",
  );
  assert.deepEqual(use!.valueSources, {
    onlyDefault: "template-default",
    fromEnvironment: "environment",
    shadowedByDefault: "environment",
    shadowedByUse: "authored-use",
    shadowedByEmpty: "authored-use",
    shadowedByRun: "run-override",
    derived: "environment",
  });
  assert.deepEqual(Object.keys(use!.values).sort(), Object.keys(use!.valueSources!).sort());
  assert.deepEqual(resolved.environment, {
    environmentId: "environment_staging",
    name: "Staging",
    consumed: { fromEnvironment: "env-1", shadowedByDefault: "env-2", derived: "<env-1>" },
  });
  assert.deepEqual(resolved.diagnostics, []);
});

test("case values are labelled as the case layer, not as run overrides", () => {
  const source = project();
  const resolved = resolveProjectRevision(
    source,
    revision(source),
    { "template-use_precedence": { shadowedByRun: "case-5" } },
    { environment: resolveEnvironment(environment), overrideSource: "case" },
  );

  assert.equal(resolved.templateResolutions[0]!.valueSources!.shadowedByRun, "case");
});

test("without an environment, rendering is unchanged and sources are still recorded", () => {
  const source = project();
  const resolved = resolveProjectRevision(source, revision(source));

  assert.equal(resolved.environment, undefined);
  assert.deepEqual(resolved.templateResolutions[0]!.valueSources, {
    onlyDefault: "template-default",
    shadowedByDefault: "template-default",
    shadowedByUse: "authored-use",
    shadowedByEmpty: "authored-use",
  });
  assert.deepEqual(
    resolved.diagnostics.map(({ diagnostic }) => diagnostic.code === "missing-template-variable" && diagnostic.name),
    ["fromEnvironment", "shadowedByRun", "derived"],
  );
});

test("a run is refused for a broken entry it consumes, not for one it does not", () => {
  const source = project();
  const broken: ProjectEnvironment = {
    ...environment,
    entries: environment.entries.map((entry) =>
      entry.name === "unused" ? { ...entry, value: "{{nowhere}}" } : entry,
    ),
  };
  const runOverrides = { "template-use_precedence": { shadowedByRun: "run-5" } };

  const fine = prepareProjectRevisionRun(source, revision(source), runOverrides, { environment: broken });
  assert.equal(fine.ok, true);
  assert.deepEqual(fine.ok && fine.environment?.consumed.derived, "<env-1>");

  const consumedBroken: ProjectEnvironment = {
    ...broken,
    entries: broken.entries.map((entry) =>
      entry.name === "fromEnvironment" ? { ...entry, value: "{{nowhere}}" } : entry,
    ),
  };
  const refused = prepareProjectRevisionRun(source, revision(source), runOverrides, { environment: consumedBroken });
  assert.equal(refused.ok, false);
  assert.deepEqual(
    !refused.ok && refused.environmentDiagnostics?.map(({ code, entryName }) => ({ code, entryName })),
    [{ code: "missing-environment-reference", entryName: "fromEnvironment" }],
  );
});

test("the snapshot does not follow later edits to the environment", () => {
  const source = project();
  const authored = structuredClone(environment);
  const prepared = prepareProjectRevisionRun(
    source,
    revision(source),
    { "template-use_precedence": { shadowedByRun: "run-5" } },
    { environment: authored },
  );
  authored.entries[0]!.value = "edited";

  assert.ok(prepared.ok);
  assert.equal(prepared.environment?.consumed.fromEnvironment, "env-1");
  assert.equal(prepared.templateResolutions[0]!.values.fromEnvironment, "env-1");
});

test("a run of the project's saved defaults renders against the default environment", () => {
  const source = parseProjectFile({
    ...project(),
    environments: [environment],
    defaults: { ...project().defaults, environmentId: environment.id },
  });
  const withRunValue = updatePromptTemplateUseValues(source, {
    conversationRevisionId: source.defaults.conversationRevisionId,
    templateUseId: "template-use_precedence",
    values: { shadowedByUse: "use-3", shadowedByEmpty: "", shadowedByRun: "use-5" },
  });

  const resolved = resolveProjectDefaultsRun({
    project: withRunValue,
    connection: {
      requirementId: withRunValue.defaults.target.connectionRequirementId,
      requirementName: "Default connection",
      endpoint: "https://api.example.com/v1",
      capabilities: resolveProviderCapabilities("openai-compatible", {}),
    },
    responseMode: "buffered",
    bindingForTool: () => undefined,
  });

  assert.ok(resolved.ok);
  assert.equal(resolved.input.environment?.environmentId, "environment_staging");
  const part = resolved.input.messages.at(-1)!.content[0]!;
  assert.equal(part.type === "text" && part.text, "default-0|env-1|env-2|use-3||use-5|<env-1>");
});

test("prototype-like variables survive environment rendering and provenance", () => {
  let source = createProjectFile({
    name: "Prototype names",
    request: { provider: "openai-compatible", endpoint: "https://api.example.com/v1", model: "model", messages: [] },
  });
  source = createPromptTemplate(source, {
    name: "Customer", messages: [{ role: "user", content: "{{__proto__}}" }],
    idSuffix: "prototype", revisionIdSuffix: "prototype",
  });
  source = insertPromptTemplateUse(source, {
    conversationRevisionId: source.defaults.conversationRevisionId,
    templateId: "template_prototype", idSuffix: "prototype", outputMessageIdSuffixes: ["prototype"],
  });
  const prepared = prepareProjectRevisionRun(source, revision(source), {}, {
    environment: { id: "environment_prototype", name: "Prototype", entries: [{ name: "__proto__", value: "Acme" }] },
  });
  assert.ok(prepared.ok, JSON.stringify(prepared));
  assert.deepEqual(prepared.messages[0]!.content, [{ type: "text", text: "Acme" }]);
  assert.deepEqual(prepared.templateResolutions[0]!.values, { ["__proto__"]: "Acme" });
  assert.deepEqual(prepared.templateResolutions[0]!.valueSources, { ["__proto__"]: "environment" });
  assert.deepEqual(prepared.environment!.consumed, { ["__proto__"]: "Acme" });
});
