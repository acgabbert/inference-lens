import assert from "node:assert/strict";
import test from "node:test";
import { createExternalPromptCandidate } from "../packages/core/src/external-prompt-import.ts";
import { projectExternalPromptTemplate } from "../packages/core/src/external-prompt-project.ts";
import { renderTemplateMessages } from "../packages/core/src/template-engine.ts";
import { copyFilePromptAsN8nText, createFilePromptCandidate, decodePromptFile, importFilePromptCandidates, priorFilePromptImports } from "../packages/core/src/file-prompt-import.ts";
import { createProjectFile, parseProjectFile, parseProjectJson, PROJECT_SCHEMA_VERSION, ProjectValidationError, serializeProjectFile, updatePromptTemplateDraft } from "../packages/core/src/project.ts";

function projectFixture() {
  return createProjectFile({ name: "File fixture", request: {
    provider: "openai-compatible", endpoint: "https://example.test/v1", model: "fixture-model",
    messages: [{ role: "user", content: "Existing request" }],
  }, idSuffix: "file-import" });
}

test("strict UTF-8 removes one initial BOM and retains CRLF and subsequent BOMs", () => {
  const text = "\uFEFFline one\r\n\uFEFFline two\r\n";
  assert.equal(decodePromptFile(new TextEncoder().encode(text).buffer), text.slice(1));
  assert.throws(() => decodePromptFile(new Uint8Array([0xff]).buffer), /encoded data/);
});

test("file expressions project without execution evidence, deduplicate identities and round-trip through receipts", async () => {
  const text = "Answer {{ $json.topic }} / {{ $json['topic'] }} / {{ $json.other.topic }}.";
  const candidate = await createFilePromptCandidate({ filename: "agent.md", text, role: "system", plainText: false });
  assert.equal(candidate.invocation.version, "expression-v1");
  assert.deepEqual(candidate.bindings.map(({ status, valueEvidence }) => [status, valueEvidence]), [["missing", undefined], ["missing", undefined], ["missing", undefined]]);
  const original = projectFixture();
  const imported = await importFilePromptCandidates(original, [candidate]);
  const reloaded = parseProjectJson(serializeProjectFile(imported.project));
  const template = reloaded.promptTemplates[0];
  assert.equal(template.kind, "chat");
  if (template.kind !== "chat") return;
  assert.equal(template.name, "agent");
  assert.deepEqual(template.revisions[0].messages, [{ role: "system", content: "Answer {{topic}} / {{topic}} / {{topic_2}}." }]);
  assert.deepEqual(reloaded.defaults, original.defaults);
  assert.deepEqual(reloaded.conversationRevisions, original.conversationRevisions);
  assert.deepEqual(copyFilePromptAsN8nText(template.revisions[0].messages, reloaded.externalImports), {
    ok: true, text,
  });
});

test("batch import retains drafts and repeated filenames produce independent identities", async () => {
  const candidate = await createFilePromptCandidate({ filename: "same.txt", text: "{{ $json.topic }}", role: "assistant", plainText: false });
  const first = await importFilePromptCandidates(projectFixture(), [candidate]);
  const template = first.project.promptTemplates[0];
  if (template.kind !== "chat") throw new Error("Expected chat template");
  const withDraft = updatePromptTemplateDraft(first.project, { templateId: template.id, sourceRevisionId: template.currentRevisionId, messages: [{ role: "user", content: "Keep this draft" }], variableDefaults: {} });
  const snapshot = serializeProjectFile(withDraft);
  const batch = await importFilePromptCandidates(withDraft, [candidate, candidate]);
  assert.equal(new Set(batch.project.promptTemplates.map(({ id }) => id)).size, 3);
  assert.deepEqual(batch.project.promptTemplates[0], withDraft.promptTemplates[0]);
  assert.equal(serializeProjectFile(withDraft), snapshot);
  await assert.rejects(() => importFilePromptCandidates(withDraft, [candidate, { ...candidate, sourceDigest: "0".repeat(64) }]), /digest/);
  assert.equal(serializeProjectFile(withDraft), snapshot);
});

test("plain text round-trips through project serialization, rendering and n8n copy", async () => {
  for (const text of ["", "abc\r\ndef\n", String.raw`{{x}} \{{x}} \\{{x}} {{{{x}} {{ unfinished`, "=not an n8n prefix"]) {
    const candidate = await createFilePromptCandidate({ filename: "literal.txt", text, role: "user", plainText: true });
    const { project } = await importFilePromptCandidates(projectFixture(), [candidate]);
    const reloaded = parseProjectJson(serializeProjectFile(project));
    const template = reloaded.promptTemplates[0];
    if (template.kind !== "chat") throw new Error("Expected chat template");
    const messages = template.revisions[0].messages;
    assert.equal(renderTemplateMessages(messages, {}).messages[0].content, text);
    assert.deepEqual(copyFilePromptAsN8nText(messages, reloaded.externalImports), { ok: true, text });
    assert.equal(reloaded.externalImports[0].authored[0].text, text);
  }
});

test("expression mode supports files without spans and preserves filename, role and interpretation differences", async () => {
  const input = { filename: "one.md", text: "plain\r\ntext", role: "user" as const, plainText: false };
  const one = await createFilePromptCandidate(input);
  for (const change of [{ filename: "two.md" }, { role: "system" as const }, { plainText: true }]) {
    const two = await createFilePromptCandidate({ ...input, ...change });
    assert.notEqual(two.sourceDigest, one.sourceDigest);
    assert.equal(two.authored[0].text, one.authored[0].text);
  }
  assert.equal(projectExternalPromptTemplate(one).messages[0].content, input.text);
});

test("unsafe expressions are rejected with plain text available, and unmapped variables block copy", async () => {
  for (const text of ["{{ missing", "{{ /regex/ }}", String.raw`\{{ $json.topic }}`]) {
    await assert.rejects(() => createFilePromptCandidate({ filename: "bad.md", text, role: "user", plainText: false }));
    const literal = await createFilePromptCandidate({ filename: "bad.md", text, role: "user", plainText: true });
    assert.equal(renderTemplateMessages(projectExternalPromptTemplate(literal).messages, {}).messages[0].content, text);
  }
  assert.deepEqual(copyFilePromptAsN8nText([{ role: "user", content: "{{local}}" }], []), { ok: false, message: "No unambiguous n8n expression is recorded for: local." });
  assert.equal(copyFilePromptAsN8nText([{ role: "user", content: "a" }, { role: "user", content: "b" }], []).ok, false);
});

test("file plain text preserves literal tokens and existing backslashes through rendering", async () => {
  const text = String.raw`Literal {{topic}}, \{{topic}}, \\{{ $json.input }} and {{ unfinished`;
  const candidate = await createExternalPromptCandidate({
    source: { adapter: "file", resource: { kind: "file", id: "literal.md", name: "literal.md" } },
    invocation: { type: "file", id: "content", name: "literal", version: "plain-text-v1" },
    authored: [{ path: "content", role: "user", syntax: "literal", text }],
    bindings: [], fidelity: "authored-only", warnings: [],
  });
  const projected = projectExternalPromptTemplate(candidate);
  const rendered = renderTemplateMessages(projected.messages, { topic: "WRONG" });
  assert.equal(rendered.messages[0].content, text);
  assert.deepEqual(rendered.diagnostics, []);
  assert.deepEqual(rendered.variables, []);
});

test("copy refuses edited expression-mode text that n8n would read as different expressions", async () => {
  const expression = await createFilePromptCandidate({ filename: "agent.md", text: "Hi {{ $json.name }}", role: "user", plainText: false });
  const { project } = await importFilePromptCandidates(projectFixture(), [expression]);
  const literal = String.raw`Hi {{name}} see \{{ $json.secret }}`;
  assert.deepEqual(copyFilePromptAsN8nText([{ role: "user", content: literal }], project.externalImports), {
    ok: false,
    message: "n8n would read this text as different expressions than its variables. Remove literal {{ before copying as n8n text.",
  });
  assert.deepEqual(copyFilePromptAsN8nText([{ role: "user", content: "Hi {{name}}}, again" }], project.externalImports), {
    ok: true, text: "Hi {{ $json.name }}}, again",
  });

  // A plain-text file has no n8n expressions, so its literal braces copy back as written.
  const plain = await createFilePromptCandidate({ filename: "literal.txt", text: "Keep {{x}}", role: "user", plainText: true });
  const plainProject = await importFilePromptCandidates(projectFixture(), [plain]);
  assert.deepEqual(copyFilePromptAsN8nText([{ role: "user", content: String.raw`Keep \{{x}} and more` }], plainProject.project.externalImports), {
    ok: true, text: "Keep {{x}} and more",
  });
});

test("file imports are Project v17: v16 opens as v17, and a v16 file receipt is rejected rather than reinterpreted", async () => {
  assert.equal(PROJECT_SCHEMA_VERSION, 17);
  assert.equal(projectFixture().schemaVersion, 17);
  assert.equal(parseProjectFile({ ...projectFixture(), schemaVersion: 16 }).schemaVersion, 17);

  const candidate = await createFilePromptCandidate({ filename: "literal.txt", text: "Keep {{x}}", role: "user", plainText: true });
  const { project } = await importFilePromptCandidates(projectFixture(), [candidate]);
  assert.throws(() => parseProjectFile({ ...project, schemaVersion: 16 }), (error: unknown) => {
    assert.ok(error instanceof ProjectValidationError);
    assert.deepEqual(error.issues.map(({ path, message }) => ({ path: path.join("."), message })), [{
      path: "externalImports.0.source.adapter",
      message: "File prompt imports require project schema v17; this document declares v16.",
    }]);
    return true;
  });
});

test("prior imports are found by exact filename, once per surviving template", async () => {
  const agent = await createFilePromptCandidate({ filename: "agent.md", text: "First", role: "user", plainText: false });
  const other = await createFilePromptCandidate({ filename: "Agent.md", text: "Other", role: "user", plainText: false });
  const { project } = await importFilePromptCandidates(projectFixture(), [agent, other, agent]);
  assert.deepEqual(priorFilePromptImports(project, "agent.md"), ["agent", "agent"]);
  assert.deepEqual(priorFilePromptImports(project, "Agent.md"), ["Agent"]);
  assert.deepEqual(priorFilePromptImports(project, "new.md"), []);
  // A removed template is not named, even while another import of the file survives.
  assert.deepEqual(priorFilePromptImports({ ...project, promptTemplates: project.promptTemplates.slice(1) }, "agent.md"), ["agent"]);
});
