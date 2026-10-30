import assert from "node:assert/strict";
import test from "node:test";
import { copyFilePromptAsN8nText, createFilePromptCandidate, importFilePromptCandidates, type FilePromptInput } from "../packages/core/src/file-prompt-import.ts";
import { applyFilePromptUpdate, planFilePromptUpdate } from "../packages/core/src/file-prompt-update.ts";
import {
  appendPromptTemplateRevision,
  createProjectFile,
  insertPromptTemplateUse,
  parseProjectJson,
  removePromptTemplateRevision,
  serializeProjectFile,
  updatePromptTemplateDraft,
  type ChatPromptTemplate,
  type ProjectFile,
} from "../packages/core/src/project.ts";
import type { PromptTemplateId } from "../packages/core/src/run-kernel/types.ts";

function projectFixture(): ProjectFile {
  return createProjectFile({ name: "File update fixture", request: {
    provider: "openai-compatible", endpoint: "https://example.test/v1", model: "fixture-model",
    messages: [{ role: "user", content: "Existing request" }],
  }, idSuffix: "file-update" });
}

function file(text: string, patch: Partial<FilePromptInput> = {}): FilePromptInput {
  return { filename: "agent.md", text, role: "system", plainText: false, ...patch };
}

async function imported(text: string): Promise<{ project: ProjectFile; templateId: PromptTemplateId }> {
  const candidate = await createFilePromptCandidate(file(text));
  const { project, templateIds } = await importFilePromptCandidates(projectFixture(), [candidate]);
  return { project, templateId: templateIds[0]! };
}

function chat(project: ProjectFile, templateId: PromptTemplateId): ChatPromptTemplate {
  const template = project.promptTemplates.find(({ id }) => id === templateId);
  if (template?.kind !== "chat") throw new Error("Expected chat template");
  return template;
}

async function pull(project: ProjectFile, templateId: PromptTemplateId, input: FilePromptInput, importedAt?: string) {
  return applyFilePromptUpdate(project, templateId, await createFilePromptCandidate(input), importedAt ? { importedAt } : {});
}

async function plan(project: ProjectFile, templateId: PromptTemplateId, input: FilePromptInput) {
  return planFilePromptUpdate(project, templateId, await createFilePromptCandidate(input));
}

function local(project: ProjectFile, templateId: PromptTemplateId, content: string, variableDefaults: Record<string, string> = {}): ProjectFile {
  return appendPromptTemplateRevision(project, { templateId, messages: [{ role: "system", content }], variableDefaults });
}

test("a pull reuses mapped names, allocates around local names, becomes current and leaves drafts, pins and defaults intact", async () => {
  const start = await imported("Hi {{ $json.topic }}");
  const importedRevisionId = chat(start.project, start.templateId).currentRevisionId;
  let project = insertPromptTemplateUse(start.project, {
    conversationRevisionId: start.project.defaults.conversationRevisionId,
    templateId: start.templateId,
    values: { topic: "dogs" },
    itemIndex: 0,
  });
  project = local(project, start.templateId, "Hi {{topic}} in {{style}}", { topic: "cats", style: "brief" });
  const localRevisionId = chat(project, start.templateId).currentRevisionId;
  project = updatePromptTemplateDraft(project, {
    templateId: start.templateId,
    sourceRevisionId: importedRevisionId,
    messages: [{ role: "system", content: "Draft {{topic}}" }],
    variableDefaults: {},
  });
  const before = serializeProjectFile(project);

  const input = file("Hello {{ $json.topic }} {{ $json.style }} {{ $json.extra }}");
  const preview = await plan(project, start.templateId, input);
  assert.equal(preview.blocked, undefined);
  assert.deepEqual(preview.messages, [{ role: "system", content: "Hello {{topic}} {{style_2}} {{extra}}" }]);
  assert.deepEqual(preview.variables.map(({ variableName, reused }) => [variableName, reused]), [["topic", true], ["style_2", false], ["extra", false]]);
  assert.deepEqual(preview.variableDefaults, { topic: "cats" });
  assert.equal(preview.lastPulled.revision.id, importedRevisionId);
  assert.equal(preview.current.id, localRevisionId);
  assert.deepEqual(preview.localRevisionIds, [localRevisionId]);
  assert.deepEqual(
    { text: preview.textChanged, role: preview.roleChanged, plainText: preview.interpretationChanged, filename: preview.filenameChanged, change: preview.wouldChange },
    { text: true, role: false, plainText: false, filename: false, change: true },
  );

  const applied = await pull(project, start.templateId, input);
  assert.equal(serializeProjectFile(project), before, "apply is immutable");
  const reloaded = parseProjectJson(serializeProjectFile(applied.project));
  const template = chat(reloaded, start.templateId);
  assert.equal(template.currentRevisionId, applied.revisionId);
  assert.deepEqual(template.revisions.map(({ id }) => id).slice(0, 2), [importedRevisionId, localRevisionId]);
  const pulled = template.revisions.at(-1)!;
  assert.deepEqual(pulled.messages, preview.messages);
  assert.deepEqual(pulled.variableDefaults, { topic: "cats" });
  assert.deepEqual(template.draft, chat(project, start.templateId).draft);
  assert.deepEqual(reloaded.conversationRevisions, project.conversationRevisions);
  assert.deepEqual(copyFilePromptAsN8nText(pulled.messages, reloaded.externalImports.filter((receipt) =>
    receipt.projection.kind === "prompt-template" && receipt.projection.templateId === start.templateId)), {
    ok: true, text: input.text,
  });
});

test("a removed expression keeps its name reserved and gets it back when reintroduced", async () => {
  const start = await imported("{{ $json.a }} {{ $json.b }}");
  let { project } = await pull(start.project, start.templateId, file("{{ $json.a }} only"));
  ({ project } = await pull(project, start.templateId, file("{{ $json.b }} and {{ $json.c.b }}")));
  assert.deepEqual(chat(project, start.templateId).revisions.at(-1)!.messages, [{ role: "system", content: "{{b}} and {{b_2}}" }]);
});

test("keeping a mapped variable locally is continuity, but reintroducing a dropped name locally blocks a pull that would reuse it", async () => {
  const kept = await imported("{{ $json.a }}");
  const keptProject = local(kept.project, kept.templateId, "{{a}}!");
  assert.equal((await plan(keptProject, kept.templateId, file("{{ $json.a }}?"))).blocked, undefined);

  const start = await imported("{{ $json.a }} {{ $json.b }}");
  let { project } = await pull(start.project, start.templateId, file("{{ $json.a }} only"));
  project = local(project, start.templateId, "{{a}} with my own {{b}}");
  const blocked = await plan(project, start.templateId, file("{{ $json.b }} again"));
  assert.match(blocked.blocked ?? "", /\{\{b\}\}/);
  await assert.rejects(() => pull(project, start.templateId, file("{{ $json.b }} again")), /\{\{b\}\}/);
  // A pull that does not reuse the name is safe; the name stays reserved.
  const other = await plan(project, start.templateId, file("{{ $json.a }} and {{ $json.x.b }}"));
  assert.equal(other.blocked, undefined);
  assert.deepEqual(other.messages, [{ role: "system", content: "{{a}} and {{b_2}}" }]);
});

test("ambiguous history from merged pulls blocks a pull that would use the ambiguous name", async () => {
  const start = await imported("{{ $json.a }}");
  const left = await pull(start.project, start.templateId, file("{{ $json.a }} {{ $json.x }}"), "2026-10-30T10:00:00.000Z");
  const right = await pull(start.project, start.templateId, file("{{ $json.a }} {{ $json.y.x }}"), "2026-10-30T10:00:01.000Z");
  const rightTemplate = chat(right.project, start.templateId);
  const rightReceipt = right.project.externalImports.at(-1)!;
  const merged = parseProjectJson(serializeProjectFile({
    ...left.project,
    promptTemplates: left.project.promptTemplates.map((template) => template.id === start.templateId && template.kind === "chat"
      ? { ...template, revisions: [...template.revisions, rightTemplate.revisions.at(-1)!] }
      : template),
    externalImports: [...left.project.externalImports, rightReceipt],
  }));
  const blocked = await plan(merged, start.templateId, file("{{ $json.x }}"));
  assert.match(blocked.blocked ?? "", /\{\{x\}\}/);
  assert.equal((await plan(merged, start.templateId, file("{{ $json.a }} alone"))).blocked, undefined);
});

test("comparison separates text, role, interpretation and filename, and refuses a pull that changes nothing", async () => {
  const start = await imported("line one\nline two {{ $json.a }}");
  const same = await plan(start.project, start.templateId, file("line one\r\nline two {{ $json.a }}"));
  assert.deepEqual({ text: same.textChanged, change: same.wouldChange }, { text: false, change: false });
  await assert.rejects(() => pull(start.project, start.templateId, file("line one\nline two {{ $json.a }}")), /already matches/);

  const role = await plan(start.project, start.templateId, file("line one\nline two {{ $json.a }}", { role: "user" }));
  assert.deepEqual({ text: role.textChanged, role: role.roleChanged, change: role.wouldChange }, { text: false, role: true, change: true });
  const plain = await plan(start.project, start.templateId, file("line one\nline two {{ $json.a }}", { plainText: true }));
  assert.deepEqual({ text: plain.textChanged, plainText: plain.interpretationChanged, change: plain.wouldChange }, { text: false, plainText: true, change: true });
  const renamed = await plan(start.project, start.templateId, file("line one\nline two {{ $json.a }}", { filename: "renamed.md" }));
  assert.deepEqual({ filename: renamed.filenameChanged, change: renamed.wouldChange }, { filename: true, change: false });

  // An unchanged file can still restore its text over a local edit.
  const edited = local(start.project, start.templateId, "my edit {{a}}");
  const restore = await plan(edited, start.templateId, file("line one\nline two {{ $json.a }}"));
  assert.deepEqual({ text: restore.textChanged, change: restore.wouldChange }, { text: false, change: true });
  const restored = await pull(edited, start.templateId, file("line one\nline two {{ $json.a }}"));
  assert.equal(chat(restored.project, start.templateId).revisions.length, 3);
});

test("only file-tracked chat prompts can be updated and tampered candidates are refused", async () => {
  const start = await imported("{{ $json.a }}");
  const candidate = await createFilePromptCandidate(file("{{ $json.a }} changed"));
  await assert.rejects(() => applyFilePromptUpdate(start.project, start.templateId, { ...candidate, sourceDigest: "0".repeat(64) }), /digest/);
  const untracked = appendPromptTemplateRevision(start.project, { templateId: start.templateId, messages: [{ role: "user", content: "x" }] });
  assert.throws(() => planFilePromptUpdate({ ...untracked, externalImports: [] }, start.templateId, candidate), /not tracked from a file/);
});

test("names in retained revisions stay reserved after the receipt that mapped them is removed", async () => {
  const start = await imported("{{ $json.a }}");
  const importedRevisionId = chat(start.project, start.templateId).currentRevisionId;
  let project = local(start.project, start.templateId, "{{a}} kept");
  ({ project } = await pull(project, start.templateId, file("{{ $json.z }}")));
  project = removePromptTemplateRevision(project, start.templateId, importedRevisionId);
  assert.equal(project.externalImports.some(({ projection }) => projection.kind === "prompt-template" && projection.templateRevisionId === importedRevisionId), false);
  const preview = await plan(project, start.templateId, file("{{ $json.q.a }}"));
  assert.deepEqual(preview.messages, [{ role: "system", content: "{{a_2}}" }]);
});
