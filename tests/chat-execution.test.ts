import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseProjectFile } from "../packages/core/src/project.ts";
import type { ProjectFile } from "../packages/core/src/project.ts";
import { planSharedProjectMigration } from "../packages/core/src/shared-project-migration.ts";
import type { ConversationRevisionId, EnvironmentId, ToolId } from "../packages/core/src/run-kernel/types.ts";
import {
  chatLaunchDifferences,
  chatExecutionAfterLaunchSave,
  effectiveChatExecution,
  patchChatExecution,
} from "../app/request/chat-execution.ts";

const plan = planSharedProjectMigration(readFileSync(new URL("../docs/examples/shared-assets-level-two/project-v15.json", import.meta.url)));
const base: ProjectFile = plan.shared;
const environment = (id: string, name: string) => ({ id: id as EnvironmentId, name, entries: [] });
const shared: ProjectFile = parseProjectFile({
  ...base,
  environments: [environment("environment_staging", "Staging"), environment("environment_live", "Live")],
  defaults: { ...base.defaults, environmentId: "environment_staging" },
});
const older = shared.conversationRevisions.find(({ id }) => id !== shared.defaults.conversationRevisionId)!.id;
const lookup = "tool_lookup" as ToolId;

test("no overrides run the launch defaults", () => {
  const execution = effectiveChatExecution(shared, undefined);
  assert.deepEqual(execution.target, shared.defaults.target);
  assert.deepEqual(execution.options, { temperature: 0.4 });
  assert.deepEqual(execution.enabledToolIds, [lookup]);
  assert.equal(execution.environmentId, "environment_staging");
  assert.deepEqual(chatLaunchDifferences(shared, { kind: "saved", revisionId: shared.defaults.conversationRevisionId }, execution), []);
});

test("an override replaces its field; null clears an option or chooses no environment", () => {
  const execution = effectiveChatExecution(shared, {
    target: { model: "other-model" },
    options: { temperature: null },
    enabledToolIds: [],
    environmentId: null,
  });
  assert.equal(execution.target.model, "other-model");
  assert.equal(execution.target.protocol, shared.defaults.target.protocol);
  assert.deepEqual(execution.options, {});
  assert.deepEqual(execution.enabledToolIds, []);
  assert.equal(execution.environmentId, undefined);
});

test("an override naming a removed tool or environment is ignored", () => {
  const execution = effectiveChatExecution(shared, {
    enabledToolIds: ["tool_gone" as ToolId, lookup],
    environmentId: "environment_gone" as EnvironmentId,
  });
  assert.deepEqual(execution.enabledToolIds, [lookup]);
  assert.equal(execution.environmentId, "environment_staging");
});

test("T2: setting a field back to its launch default clears the override", () => {
  let overrides = patchChatExecution(shared, undefined, { field: "model", value: "other-model" });
  assert.deepEqual(overrides, { target: { model: "other-model" } });
  overrides = patchChatExecution(shared, overrides, { field: "temperature", value: undefined });
  assert.deepEqual(overrides, { target: { model: "other-model" }, options: { temperature: null } });
  overrides = patchChatExecution(shared, overrides, { field: "model", value: shared.defaults.target.model });
  assert.deepEqual(overrides, { options: { temperature: null } });
  overrides = patchChatExecution(shared, overrides, { field: "temperature", value: 0.4 });
  assert.equal(overrides, undefined);
});

test("T2: tools compare as a set, environments by ID", () => {
  assert.deepEqual(patchChatExecution(shared, undefined, { field: "enabledToolIds", value: [] }), { enabledToolIds: [] });
  assert.equal(patchChatExecution(shared, { enabledToolIds: [] }, { field: "enabledToolIds", value: [lookup] }), undefined);
  assert.deepEqual(
    patchChatExecution(shared, undefined, { field: "environmentId", value: "environment_live" as EnvironmentId }),
    { environmentId: "environment_live" },
  );
  assert.deepEqual(patchChatExecution(shared, undefined, { field: "environmentId", value: undefined }), { environmentId: null });
  assert.equal(
    patchChatExecution(shared, { environmentId: null }, { field: "environmentId", value: "environment_staging" as EnvironmentId }),
    undefined,
  );
});

test("T4: the status names each field that differs, and never environment", () => {
  const execution = effectiveChatExecution(shared, {
    target: { model: "other-model" },
    options: { temperature: 0.9 },
    enabledToolIds: [],
    environmentId: "environment_live" as EnvironmentId,
  });
  const differences = chatLaunchDifferences(shared, { kind: "saved", revisionId: older as ConversationRevisionId }, execution);
  assert.deepEqual(differences.map(({ field }) => field), ["request", "model", "temperature", "tools"]);
  assert.deepEqual(differences[0], { field: "request", label: "Request", from: "Explain, revision 2", to: "Explain, revision 1" });
  assert.deepEqual(differences[3], { field: "tools", label: "Tools", from: "lookup", to: "none" });
});

test("T4: values are compared, so an override equal to a changed default is no difference", () => {
  const changed = parseProjectFile({ ...shared, defaults: { ...shared.defaults, target: { ...shared.defaults.target, model: "other-model" } } });
  const execution = effectiveChatExecution(changed, { target: { model: "other-model" } });
  assert.deepEqual(chatLaunchDifferences(changed, { kind: "saved", revisionId: changed.defaults.conversationRevisionId }, execution), []);
});

test("T3: a local selection always differs, naming the revision it changes", () => {
  const differences = chatLaunchDifferences(
    shared,
    { kind: "local", baseRevisionId: shared.defaults.conversationRevisionId },
    effectiveChatExecution(shared, undefined),
  );
  assert.deepEqual(differences, [{ field: "request", label: "Request", from: "Explain, revision 2", to: "unsaved changes to Explain, revision 2" }]);
});


test("launch save clears published fields while preserving newer edits and environment", () => {
  const captured = { target: { model: "published-model" }, options: { temperature: 0.9 }, enabledToolIds: [] };
  const published = parseProjectFile({ ...shared, defaults: {
    ...shared.defaults, target: { ...shared.defaults.target, model: "published-model" },
    options: { temperature: 0.9 }, enabledToolIds: [],
  } });
  assert.equal(chatExecutionAfterLaunchSave(shared, published, captured, captured), undefined);
  assert.deepEqual(chatExecutionAfterLaunchSave(shared, published, captured, {
    ...captured, target: { model: "new-model" }, environmentId: null,
  }), { target: { model: "new-model" }, environmentId: null });
  // Resetting a field to the old default removes its sparse override while
  // saving; after publication that old default must become an explicit value.
  assert.deepEqual(chatExecutionAfterLaunchSave(shared, published, captured, undefined), {
    target: { model: shared.defaults.target.model }, options: { temperature: 0.4 }, enabledToolIds: [lookup],
  });
});

test("launch save distinguishes clearing an option from inheriting its old default", () => {
  const published = parseProjectFile({ ...shared, defaults: { ...shared.defaults, options: {} } });
  assert.deepEqual(chatExecutionAfterLaunchSave(shared, published,
    { options: { temperature: null } }, undefined), { options: { temperature: 0.4 } });
  assert.deepEqual(chatExecutionAfterLaunchSave(shared, shared,
    undefined, { options: { temperature: null } }), { options: { temperature: null } });
});
