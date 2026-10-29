import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseProjectJson, PROJECT_SCHEMA_VERSION, ProjectValidationError, createProjectFile, createPromptTemplate, updatePromptTemplateDraft } from "../packages/core/src/project.ts";
import { planSharedProjectMigration } from "../packages/core/src/shared-project-migration.ts";
import { parseSharedProjectFile, parseSharedProjectJson, serializeSharedProjectFile } from "../packages/core/src/shared-project.ts";
import { parseWorkbenchRecord, parseWorkbenchRecordJson, serializeWorkbenchRecord, WorkbenchValidationError } from "../packages/core/src/personal-workbench.ts";
import type { WorkbenchRecordV1 } from "../packages/core/src/personal-workbench.ts";
import { resolveProviderCapabilities } from "../packages/core/src/types.ts";
import { legacyContent } from "./project-kind-helpers.ts";
import type { DecisionInput } from "../packages/core/src/decision.ts";

const example = (name: string) => readFileSync(new URL(`../docs/examples/shared-assets-level-two/${name}`, import.meta.url));

test("migration separates the example's drafts while preserving every saved definition", () => {
  const source = example("project-v15.json");
  const plan = planSharedProjectMigration(source);
  assert.equal(plan.shared.schemaVersion, 17);
  assert.deepEqual(plan.shared, JSON.parse(example("project-v17.proposed.json").toString()));
  assert.equal(plan.sourceVersion, 15);
  assert.deepEqual(Array.from(plan.sourceBytes), Array.from(source));
});

test("migration extracts both prompt kinds with edited values and exact base snapshots", () => {
  const plan = planSharedProjectMigration(example("project-v15.json"));
  assert.equal(plan.drafts.length, 2);
  const expected = (JSON.parse(example("workbench-records.proposed.json").toString()) as { records: Record<string, WorkbenchRecordV1> }).records;
  for (const draft of plan.drafts) {
    const match = Object.values(expected).find(record => "draftId" in record && record.asset.id === draft.asset.id);
    assert.ok(match && "draftId" in match);
    assert.deepEqual({ ...draft, draftId: match.draftId }, match);
  }
  assert.deepEqual(plan.selections, expected["selections.json"]);
});

test("the active application codec stays v15 and preserves legacy drafts", () => {
  assert.equal(PROJECT_SCHEMA_VERSION, 15);
  const legacy = parseProjectJson(example("project-v15.json").toString());
  assert.equal(legacy.promptTemplates.filter(template => template.draft).length, 2);
  assert.throws(() => parseProjectJson(example("project-v17.proposed.json").toString()), /schema v17 is not supported/);
});

test("v17 codec accepts the shared example with deterministic serialization", () => {
  const parsed = parseSharedProjectJson(example("project-v17.proposed.json").toString());
  const serialized = serializeSharedProjectFile(parsed);
  assert.deepEqual(parseSharedProjectJson(serialized), parsed);
  assert.equal(serializeSharedProjectFile(parseSharedProjectJson(serialized)), serialized);
  assert.ok(serialized.endsWith("\n"));
  assert.throws(() => parseSharedProjectJson(example("project-v15.json").toString()), /schemaVersion/);
  assert.throws(() => parseSharedProjectJson("{"), /not valid JSON/);
});

test("v17 rejects personal fields for both prompt kinds, even undefined ones", () => {
  const before = parseProjectJson(example("project-v15.json").toString());
  for (const template of before.promptTemplates) {
    for (const draft of [template.draft, undefined, null]) {
      const value = JSON.parse(example("project-v17.proposed.json").toString());
      value.promptTemplates.find((item: { id: string }) => item.id === template.id).draft = draft;
      assert.throws(() => parseSharedProjectFile(value), /Personal prompt drafts/);
    }
  }
});

test("v17 preserves strict nested validation, references and uniqueness rules", () => {
  const shared = () => JSON.parse(example("project-v17.proposed.json").toString());
  const unexpected = shared();
  unexpected.workbench = {};
  assert.throws(() => parseSharedProjectFile(unexpected), /workbench/);
  const nested = shared();
  nested.promptTemplates[0].revisions[0].localEdits = {};
  assert.throws(() => parseSharedProjectFile(nested), /localEdits/);
  const pin = shared();
  pin.defaults.conversationRevisionId = "revision_missing";
  assert.throws(() => parseSharedProjectFile(pin), /Default conversation revision does not exist/);
  const duplicate = shared();
  duplicate.promptTemplates.push(duplicate.promptTemplates[0]);
  assert.throws(() => parseSharedProjectFile(duplicate), /Duplicate identifier/);
  const decisionPin = shared();
  decisionPin.evaluationSuites.find((suite: { input: { kind: string } }) => suite.input.kind === "decision-request-revision").input.decisionRequestRevisionId = "decision-revision_missing";
  assert.throws(() => parseSharedProjectFile(decisionPin), /decisionRequestRevisionId/);
});

test("v17 rejects known secret fields nested in provider-option arrays that v15 still accepts", () => {
  const nestedSecret = { extra: [{ api_key: "sk-example" }] };
  const legacy = JSON.parse(example("project-v15.json").toString());
  legacy.defaults.options.providerOptions = nestedSecret;
  legacy.tools[0].providerOptions = nestedSecret;
  // Opening an existing v15 folder keeps working; only the new format tightens.
  assert.doesNotThrow(() => parseProjectJson(JSON.stringify(legacy)));
  const shared = JSON.parse(example("project-v17.proposed.json").toString());
  shared.defaults.options.providerOptions = nestedSecret;
  shared.tools[0].providerOptions = nestedSecret;
  assert.throws(() => parseSharedProjectFile(shared), (error: unknown) => {
    assert.ok(error instanceof ProjectValidationError);
    assert.deepEqual(error.issues.map(issue => issue.path.join(".")).sort(), [
      "defaults.options.providerOptions.extra.0.api_key",
      "tools.0.providerOptions.extra.0.api_key",
    ]);
    return true;
  });
  // Migration reports the source project's own field, not a workbench record.
  assert.throws(() => planSharedProjectMigration(Buffer.from(JSON.stringify(legacy))), (error: unknown) => {
    assert.ok(error instanceof ProjectValidationError, `expected ProjectValidationError, got ${(error as Error).name}: ${(error as Error).message}`);
    assert.ok(error.issues.some(issue => issue.path.join(".") === "defaults.options.providerOptions.extra.0.api_key"));
    return true;
  });
});

test("workbench codecs round-trip the proposed individual records", () => {
  const records: Record<string, unknown> = JSON.parse(example("workbench-records.proposed.json").toString()).records;
  for (const value of Object.values(records)) {
    const parsed = parseWorkbenchRecord(value, "project_shared-assets-example");
    assert.deepEqual(parsed, value);
    const serialized = serializeWorkbenchRecord(parsed);
    assert.deepEqual(parseWorkbenchRecordJson(serialized), parsed);
    assert.equal(serializeWorkbenchRecord(parseWorkbenchRecordJson(serialized)), serialized);
    // Envelope first, in the same order as the authored examples.
    assert.deepEqual(Object.keys(JSON.parse(serialized)), Object.keys(value as object));
  }
  // Nested saved content serializes in the same key order as project.json.
  const draft = JSON.parse(serializeWorkbenchRecord(records["drafts/draft_template_chat.json"] as WorkbenchRecordV1));
  const shared = JSON.parse(serializeSharedProjectFile(parseSharedProjectJson(example("project-v17.proposed.json").toString())));
  const savedRevision = shared.promptTemplates.find((template: { id: string }) => template.id === "template_chat").revisions[0];
  assert.deepEqual(Object.keys(draft.base.snapshot), Object.keys(savedRevision));
  assert.throws(() => parseWorkbenchRecord({ records }), WorkbenchValidationError);
  assert.throws(() => parseWorkbenchRecordJson("{"), /not valid JSON/);
});

test("workbench records reject unsupported versions, fields, kinds and mismatched bases", () => {
  const [draft] = planSharedProjectMigration(example("project-v15.json")).drafts;
  assert.ok(draft);
  for (const value of [
    { ...draft, schemaVersion: 2 },
    { ...draft, credentials: {} },
    { ...draft, publishing: {} },
    { ...draft, asset: { ...draft.asset, kind: "suite" } },
    { ...draft, base: { ...draft.base, revisionId: "template-revision_wrong" } },
    { ...draft, edited: { ...draft.edited, unexpected: true } },
    { ...draft, draftId: "draft_../../private" },
    { ...draft, kind: "selections" },
    { ...draft, kind: "suite-draft" },
    Object.fromEntries(Object.entries(draft).filter(([key]) => key !== "kind")),
    { schemaVersion: 1, kind: "draft", projectId: draft.projectId },
    { schemaVersion: 1, projectId: draft.projectId },
  ]) assert.throws(() => parseWorkbenchRecord(value), WorkbenchValidationError);
  assert.throws(() => parseWorkbenchRecord(draft, "project_other"), /different project/);
  // No dependency on a live project: a missing asset remains recoverable.
  assert.deepEqual(parseWorkbenchRecord(draft), draft);
});

test("workbench validates prompt content without resolving variables or leaking known secret fields", () => {
  const plan = planSharedProjectMigration(example("project-v15.json"));
  const chat = plan.drafts.find(draft => draft.asset.kind === "chat-prompt")!;
  const decision = plan.drafts.find(draft => draft.asset.kind === "decision-prompt")!;
  assert.throws(() => parseWorkbenchRecord({ ...chat, edited: { ...chat.edited, messages: [] } }), WorkbenchValidationError);
  assert.throws(() => parseWorkbenchRecord({ ...decision, edited: { ...decision.edited, decision: {} } }), WorkbenchValidationError);
  assert.throws(() => parseWorkbenchRecord({ ...decision, edited: { ...decision.edited, variableDefaults: { unused: "value" } } }), /variable the request does not use/);
  assert.throws(() => parseWorkbenchRecord({ ...chat, edited: { ...chat.edited, variableDefaults: { api_key: "secret" } } }), /Secret values/);
  for (const providerOptions of [{ authorization: "secret" }, { nested: [{ api_key: "secret" }] }]) {
    assert.throws(() => parseWorkbenchRecord({
      schemaVersion: 1, kind: "selections", projectId: plan.shared.projectId,
      chat: { execution: { options: { providerOptions } } },
    }), /Secret-bearing fields/);
  }
});

test("selections preserve absence, null removal, empty arrays and provider option replacement shapes", () => {
  const value = {
    schemaVersion: 1, kind: "selections", projectId: "project_example",
    chat: { execution: { options: { temperature: null, stop: [], providerOptions: { custom: "" } }, enabledToolIds: [] } },
  };
  assert.deepEqual(parseWorkbenchRecord(value), value);
  const empty = { schemaVersion: 1, kind: "selections", projectId: "project_example" };
  assert.deepEqual(parseWorkbenchRecord(empty), empty);
  assert.throws(() => parseWorkbenchRecord({ ...empty, chat: { execution: { target: null } } }), WorkbenchValidationError);
  assert.throws(() => parseWorkbenchRecord({ ...empty, chat: { execution: { enabledToolIds: ["tool_a", "tool_a"] } } }), /Duplicate tool selection/);
});

function legacyChatProject() {
  let project = createProjectFile({
    name: "Legacy", idSuffix: "legacy", createdAt: "2026-10-25T12:00:00.000Z",
    request: { provider: "openai-compatible", endpoint: "https://example.com/v1", model: "example", messages: [{ role: "user", content: "Hello" }], capabilities: resolveProviderCapabilities("openai-compatible") },
  });
  project = createPromptTemplate(project, { name: "Prompt", idSuffix: "legacy", revisionIdSuffix: "legacy", messages: [{ role: "user", content: "{{topic}}" }] });
  project = updatePromptTemplateDraft(project, { templateId: "template_legacy", sourceRevisionId: "template-revision_legacy", messages: [{ role: "user", content: "Explain {{topic}}" }], variableDefaults: { topic: "" } });
  // The editor command trims empty names; the legacy codec accepts a saved
  // empty string. Exercise those source bytes, not the editor normalization.
  project.promptTemplates[0]!.draft!.revisionName = "";
  return project;
}

for (const sourceVersion of [10, 11, 12, 13, 14, 15] as const) {
  test(`migration follows the strict legacy chain from v${sourceVersion}`, () => {
    const current = legacyChatProject();
    const legacy: Record<string, unknown> = { ...(sourceVersion < 15 ? legacyContent(current) : current), schemaVersion: sourceVersion };
    if (sourceVersion < 13) {
      delete legacy.decisionRequests;
      delete legacy.decisionRequestRevisions;
    }
    if (sourceVersion === 10) {
      const target: Record<string, unknown> = { ...current.defaults.target };
      delete target.protocol;
      legacy.defaults = { ...current.defaults, target };
      legacy.connectionRequirements = current.connectionRequirements.map(requirement => ({ ...requirement, protocol: "openai-compatible-chat-completions" }));
    }
    const source = Buffer.from(` \r\n${JSON.stringify(legacy, null, 2)}\r\n`);
    const plan = planSharedProjectMigration(source);
    assert.equal(plan.sourceVersion, sourceVersion);
    assert.deepEqual(plan.sourceBytes, new Uint8Array(source));
    const saved = { ...current.promptTemplates[0]! };
    delete saved.draft;
    assert.deepEqual(plan.shared, { ...current, schemaVersion: 17, promptTemplates: [saved] });
    assert.deepEqual(plan.drafts[0]!.edited.variableDefaults, { topic: "" });
    assert.equal(plan.drafts[0]!.edited.revisionName, "");
    assert.equal("decision" in plan.selections, false);
  });
}

test("migration preserves raw UTF-8 bytes including a BOM, CRLF and Unicode", () => {
  const value = JSON.parse(example("project-v15.json").toString());
  value.name = "Workbench 雪 🧪";
  const text = JSON.stringify(value, null, 2);
  const source = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(` \r\n${text.replaceAll("\n", "\r\n")}\r\n`)]);
  const plan = planSharedProjectMigration(source);
  assert.deepEqual(plan.sourceBytes, new Uint8Array(source));
  assert.equal(plan.shared.name, value.name);
  source.fill(0);
  assert.notEqual(plan.sourceBytes[0], 0);
  const before = example("project-v15.json");
  const another = planSharedProjectMigration(before);
  another.sourceBytes.fill(0);
  assert.equal(before[0], "{".charCodeAt(0));
  assert.throws(() => planSharedProjectMigration(new Uint8Array([0xff])), /not valid UTF-8/);
});

test("migration draft IDs are stable per asset and safe even for unusual legacy IDs", () => {
  const source = legacyChatProject();
  const first = source.promptTemplates[0]!;
  first.id = "template_../a/雪";
  const second = structuredClone(first);
  second.id = "template_../a/\ud800";
  second.revisions[0]!.id = "template-revision_other";
  second.currentRevisionId = second.revisions[0]!.id;
  second.draft!.sourceRevisionId = second.currentRevisionId;
  source.promptTemplates.push(second);
  const forward = planSharedProjectMigration(Buffer.from(JSON.stringify(source)));
  source.promptTemplates.reverse();
  const reversed = planSharedProjectMigration(Buffer.from(JSON.stringify(source)));
  assert.equal(new Set(forward.drafts.map(draft => draft.draftId)).size, 2);
  for (const draft of forward.drafts) {
    assert.match(draft.draftId, /^draft_[A-Za-z0-9_-]+$/);
    assert.equal(reversed.drafts.find(other => other.asset.id === draft.asset.id)!.draftId, draft.draftId);
  }
});

test("migration does not drop invalid legacy drafts or accept future/unsupported input", () => {
  const value = JSON.parse(example("project-v15.json").toString());
  value.promptTemplates[0].draft.sourceRevisionId = "template-revision_missing";
  assert.throws(() => planSharedProjectMigration(Buffer.from(JSON.stringify(value))), /source revision/);
  for (const schemaVersion of [9, 16, 17]) {
    value.schemaVersion = schemaVersion;
    assert.throws(() => planSharedProjectMigration(Buffer.from(JSON.stringify(value))), /not supported/);
  }
  assert.throws(() => planSharedProjectMigration(Buffer.from("{")), /not valid JSON/);
});

test("migration is deterministic and does not alias shared content, drafts, selections or source", () => {
  const source = example("project-v15.json");
  const first = planSharedProjectMigration(source);
  const second = planSharedProjectMigration(source);
  assert.deepEqual(first, second);
  first.selections.chat!.execution!.target!.model = "local-model";
  assert.notEqual(first.shared.defaults.target.model, "local-model");
  const decisionDraft = first.drafts.find(draft => draft.asset.kind === "decision-prompt")!;
  assert.ok("decision" in decisionDraft.base.snapshot && "decision" in decisionDraft.edited);
  decisionDraft.base.snapshot.decision.state = "Changed base";
  decisionDraft.edited.decision.state = "Changed draft";
  assert.deepEqual(first.shared, second.shared);
  assert.deepEqual(planSharedProjectMigration(source), second);
  assert.equal(first.preview.promptDraftCount, 2);
  assert.equal(first.preview.messages[0], "Move 2 prompt drafts into this folder's personal workbench.");
  assert.match(first.preview.messages.join(" "), /does not make previously saved content private/);
  assert.match(first.preview.messages.join(" "), /Existing personal records require reconciliation/);
});

test("migration without explicit drafts retains every saved revision and produces no drafts", () => {
  const source = JSON.parse(example("project-v15.json").toString());
  for (const template of source.promptTemplates) delete template.draft;
  const plan = planSharedProjectMigration(Buffer.from(JSON.stringify(source)));
  assert.deepEqual(plan.drafts, []);
  assert.equal(plan.preview.promptDraftCount, 0);
  assert.equal(plan.preview.messages.some(message => /prompt draft/.test(message)), false);
  const single = JSON.parse(example("project-v15.json").toString());
  single.promptTemplates.slice(1).forEach((template: { draft?: unknown }) => delete template.draft);
  assert.equal(planSharedProjectMigration(Buffer.from(JSON.stringify(single))).preview.messages[0], "Move 1 prompt draft into this folder's personal workbench.");
  assert.deepEqual(plan.shared, { ...source, schemaVersion: 17 });
});

test("shared and personal codecs preserve authored decision/question/choice and tool-schema ordering", () => {
  const source = parseProjectJson(example("project-v15.json").toString());
  const decision: DecisionInput = {
    state: { zeta: "{{ticket}}", alpha: "{{region}}" },
    questions: {
      zeta: { type: "choice", instructions: "Pick", criteria: { zebra: "Z", alpha: "A" } },
      alpha: { type: "score", instructions: "Rate", criteria: ["later", "earlier"] },
    },
  };
  const template = source.promptTemplates.find(template => template.kind === "decision")!;
  assert.equal(template.kind, "decision");
  template.revisions[0]!.decision = structuredClone(decision);
  template.draft!.decision = structuredClone(decision);
  // Existing suite checks refer to the original question, so remove only the
  // authored checks in this order-focused fixture.
  for (const suite of source.evaluationSuites) if (suite.input.kind === "decision-request-revision") for (const item of suite.cases) item.checks = [];
  source.tools[0]!.inputSchema = { type: "object", properties: { zeta: { type: "string" }, alpha: { type: "string" } } };
  const plan = planSharedProjectMigration(Buffer.from(JSON.stringify(source)));
  const shared = parseSharedProjectJson(serializeSharedProjectFile(plan.shared));
  const saved = shared.promptTemplates.find(template => template.kind === "decision")!;
  assert.equal(saved.kind, "decision");
  assert.equal(JSON.stringify(saved.revisions[0]!.decision), JSON.stringify(decision));
  assert.equal(JSON.stringify(shared.tools[0]!.inputSchema), JSON.stringify(source.tools[0]!.inputSchema));
  const draft = plan.drafts.find(draft => draft.asset.kind === "decision-prompt")!;
  const restored = parseWorkbenchRecordJson(serializeWorkbenchRecord(draft));
  assert.ok("draftId" in restored && "decision" in restored.edited && "decision" in restored.base.snapshot);
  assert.equal(JSON.stringify(restored.edited.decision), JSON.stringify(decision));
  assert.equal(JSON.stringify(restored.base.snapshot.decision), JSON.stringify(decision));
});
