import assert from "node:assert/strict";
import test from "node:test";
import { createFilePromptCandidate, importFilePromptCandidates, type FilePromptInput } from "../packages/core/src/file-prompt-import.ts";
import { applyFilePromptUpdate, planFilePromptUpdate } from "../packages/core/src/file-prompt-update.ts";
import {
  appendPromptTemplateRevision,
  createProjectFile,
  parseProjectFile,
  parseProjectJson,
  PROJECT_SCHEMA_VERSION,
  serializeProjectFile,
  type ChatPromptTemplate,
  type ProjectFile,
} from "../packages/core/src/project.ts";
import {
  parseSourceRootCatalog,
  SourceRootCatalogError,
  sourceFilePathProblem,
  sourceRootNameProblem,
} from "../packages/core/src/source-root-rules.ts";
import {
  filePromptDrift,
  filePromptLink,
  linkFilePrompt,
  unlinkFilePrompt,
} from "../packages/core/src/source-roots.ts";
import type { PromptTemplateId } from "../packages/core/src/run-kernel/types.ts";

function projectFixture(): ProjectFile {
  return createProjectFile({ name: "Source root fixture", request: {
    provider: "openai-compatible", endpoint: "https://example.test/v1", model: "fixture-model",
    messages: [{ role: "user", content: "Existing request" }],
  }, idSuffix: "source-roots" });
}

function file(text: string, patch: Partial<FilePromptInput> = {}): FilePromptInput {
  return { filename: "agent.md", text, role: "system", plainText: false, ...patch };
}

async function imported(...texts: string[]): Promise<{ project: ProjectFile; templateIds: PromptTemplateId[] }> {
  const candidates = await Promise.all(texts.map((text) => createFilePromptCandidate(file(text))));
  return importFilePromptCandidates(projectFixture(), candidates);
}

/** The same document as an older version wrote it, before `sourceRoots` existed. */
function withoutSourceRoots(project: ProjectFile, schemaVersion: number): Record<string, unknown> {
  const older: Record<string, unknown> = { ...project, schemaVersion };
  delete older.sourceRoots;
  return older;
}

function chat(project: ProjectFile, templateId: PromptTemplateId): ChatPromptTemplate {
  const template = project.promptTemplates.find(({ id }) => id === templateId);
  if (template?.kind !== "chat") throw new Error("Expected chat template");
  return template;
}

test("linked sources are Project v18: v17 opens with no roots, and a v17 document declaring a root or link is rejected", async () => {
  assert.equal(PROJECT_SCHEMA_VERSION, 18);
  const fixture = projectFixture();
  assert.equal(fixture.schemaVersion, 18);
  assert.deepEqual(fixture.sourceRoots, []);
  const v17 = withoutSourceRoots(fixture, 17);
  assert.deepEqual(parseProjectFile(v17), fixture);

  assert.throws(
    () => parseProjectFile({ ...v17, sourceRoots: [{ id: "source-root_a", name: "prompts" }] }),
    { message: /sourceRoots: Linked prompt sources require project schema v18; this document declares v17/ },
  );
  const { project, templateIds } = await imported("Hi");
  const linked = linkFilePrompt(project, templateIds[0]!, { rootName: "prompts", path: "agent.md" });
  const linkedV17 = withoutSourceRoots(linked, 17);
  assert.throws(
    () => parseProjectFile(linkedV17),
    { message: /promptTemplates\.0\.fileSource: Linked prompt sources require project schema v18/ },
  );
});

test("root names and relative paths are portable and confined", () => {
  for (const name of ["n8n-workflows", "a", "0prompts", "x".repeat(63)]) assert.equal(sourceRootNameProblem(name), undefined, name);
  for (const name of ["", "-lead", "Upper", "under_score", "x".repeat(64), "has space"]) assert.ok(sourceRootNameProblem(name), name);

  for (const path of ["agent.md", "flows/support/system.MD", "notes.txt", "a b/c.md"]) {
    assert.equal(sourceFilePathProblem(path), undefined, path);
  }
  for (const path of [
    "", "/abs.md", "a//b.md", "./a.md", "a/../b.md", "../a.md", ".hidden.md", "dir/.git/x.md",
    "a\\b.md", "a\u0000.md", "a\n.md", "agent.json", "agent", "dir/", `${"a/".repeat(512)}x.md`,
  ]) {
    assert.ok(sourceFilePathProblem(path), JSON.stringify(path));
  }
});

test("the operator catalog resolves names, rejects duplicates and unknown fields", () => {
  assert.deepEqual(
    parseSourceRootCatalog({ schemaVersion: 1, roots: [{ name: "prompts", path: "./prompts", label: "Agent prompts" }, { name: "other", path: "/srv/other" }] }),
    { schemaVersion: 1, roots: [{ name: "prompts", path: "./prompts", label: "Agent prompts" }, { name: "other", path: "/srv/other" }] },
  );
  for (const bad of [
    { schemaVersion: 2, roots: [] },
    { schemaVersion: 1, roots: [{ name: "Bad", path: "/x" }] },
    { schemaVersion: 1, roots: [{ name: "a", path: "" }] },
    { schemaVersion: 1, roots: [{ name: "a", path: "/x" }, { name: "a", path: "/y" }] },
    { schemaVersion: 1, roots: [{ name: "a", path: "/x", extra: true }] },
    [],
  ]) {
    assert.throws(() => parseSourceRootCatalog(bad), SourceRootCatalogError, JSON.stringify(bad));
  }
});

test("linking adds the root once, round-trips, and unlinking drops a root no other prompt uses", async () => {
  const { project, templateIds } = await imported("One {{ $json.a }}", "Two");
  const [first, second] = templateIds as [PromptTemplateId, PromptTemplateId];
  const before = chat(project, first);

  let linked = linkFilePrompt(project, first, { rootName: "n8n-workflows", path: "flows/one.md" });
  linked = linkFilePrompt(linked, second, { rootName: "n8n-workflows", path: "flows/two.md" });
  assert.equal(linked.sourceRoots.length, 1);
  assert.equal(linked.sourceRoots[0]!.name, "n8n-workflows");
  assert.deepEqual(filePromptLink(linked, first), { root: linked.sourceRoots[0], path: "flows/one.md" });
  // Linking is not a revision.
  assert.deepEqual(chat(linked, first).revisions, before.revisions);
  assert.equal(chat(linked, first).currentRevisionId, before.currentRevisionId);
  assert.equal(serializeProjectFile(parseProjectJson(serializeProjectFile(linked))), serializeProjectFile(linked));
  assert.match(serializeProjectFile(linked), /"fileSource": \{\n\s+"sourceRootId": "source-root_[^"]+",\n\s+"path": "flows\/one\.md"/);

  const once = unlinkFilePrompt(linked, first);
  assert.equal(filePromptLink(once, first), undefined);
  assert.equal(once.sourceRoots.length, 1, "the other prompt still uses the root");
  const none = unlinkFilePrompt(once, second);
  assert.deepEqual(none.sourceRoots, []);
});

test("validation requires a known root, a valid path, a file-tracked chat prompt, and one prompt per file", async () => {
  const { project, templateIds } = await imported("One", "Two");
  const [first, second] = templateIds as [PromptTemplateId, PromptTemplateId];
  const linked = linkFilePrompt(project, first, { rootName: "prompts", path: "one.md" });

  assert.throws(
    () => linkFilePrompt(linked, second, { rootName: "prompts", path: "one.md" }),
    /already linked to prompts\/one\.md/,
  );
  assert.throws(
    () => parseProjectFile({
      ...linked,
      promptTemplates: linked.promptTemplates.map((template) =>
        template.id === second ? { ...template, fileSource: chat(linked, first).fileSource } : template),
    }),
    /Another prompt is already linked to this file/,
  );
  assert.throws(
    () => linkFilePrompt(linked, second, { rootName: "prompts", path: "../escape.md" }),
    /\.\./,
  );
  assert.throws(
    () => parseProjectFile({
      ...linked,
      promptTemplates: linked.promptTemplates.map((template) =>
        template.id === first ? { ...template, fileSource: { sourceRootId: "source-root_missing", path: "one.md" } } : template),
    }),
    /unknown source root/,
  );
});

test("a prompt that was never imported from a file cannot be linked", () => {
  const project = projectFixture();
  const withTemplate = parseProjectFile({
    ...project,
    promptTemplates: [{
      id: "template_plain", kind: "chat", name: "Plain", currentRevisionId: "template-revision_plain",
      revisions: [{ id: "template-revision_plain", createdAt: "2026-10-30T00:00:00.000Z", messages: [{ role: "user", content: "x" }], variableDefaults: {} }],
    }],
  });
  assert.throws(
    () => linkFilePrompt(withTemplate, "template_plain", { rootName: "prompts", path: "x.md" }),
    /Only a prompt imported from a file can be linked/,
  );
  assert.throws(
    () => parseProjectFile({
      ...withTemplate,
      sourceRoots: [{ id: "source-root_p", name: "prompts" }],
      promptTemplates: withTemplate.promptTemplates.map((template) => ({ ...template, fileSource: { sourceRootId: "source-root_p", path: "x.md" } })),
    }),
    /Only a prompt imported from a file can be linked/,
  );
});

test("drift separates file text changes from local revisions, treating CRLF as LF", async () => {
  const { project: start, templateIds } = await imported("Line one\nLine two {{ $json.a }}");
  const id = templateIds[0]!;
  const project = linkFilePrompt(start, id, { rootName: "prompts", path: "agent.md" });
  assert.deepEqual(filePromptDrift(project, id, "Line one\r\nLine two {{ $json.a }}"), { fileChanged: false, localRevisions: false });
  assert.deepEqual(filePromptDrift(project, id, "Line one\nLine 2 {{ $json.a }}"), { fileChanged: true, localRevisions: false });

  const edited = appendPromptTemplateRevision(project, { templateId: id, messages: [{ role: "system", content: "Local {{a}}" }], variableDefaults: {} });
  assert.deepEqual(filePromptDrift(edited, id, "Line one\nLine two {{ $json.a }}"), { fileChanged: false, localRevisions: true });
  assert.deepEqual(filePromptDrift(edited, id, "Changed"), { fileChanged: true, localRevisions: true });
});

test("a linked pull records the relative path and does not warn about a bare-filename import with the same basename", async () => {
  const { project: start, templateIds } = await imported("Hi {{ $json.a }}");
  const id = templateIds[0]!;
  const project = linkFilePrompt(start, id, { rootName: "prompts", path: "flows/agent.md" });
  const candidate = await createFilePromptCandidate({ ...file("Hello {{ $json.a }}"), filename: "agent.md", path: "flows/agent.md" });
  assert.deepEqual(candidate.source.resource, { kind: "file", id: "flows/agent.md", name: "flows/agent.md" });
  assert.equal(candidate.invocation.name, "agent");

  const preview = planFilePromptUpdate(project, id, candidate);
  assert.equal(preview.filenameChanged, false);
  assert.equal(preview.textChanged, true);
  const { project: pulled } = await applyFilePromptUpdate(project, id, candidate);
  assert.equal(pulled.externalImports.at(-1)!.source.resource.id, "flows/agent.md");
  assert.deepEqual(chat(pulled, id).fileSource, chat(project, id).fileSource);
  assert.deepEqual(filePromptDrift(pulled, id, "Hello {{ $json.a }}"), { fileChanged: false, localRevisions: false });

  const renamed = await createFilePromptCandidate({ ...file("Hey {{ $json.a }}"), filename: "other.md", path: "flows/other.md" });
  assert.equal(planFilePromptUpdate(pulled, id, renamed).filenameChanged, true);
  await assert.rejects(
    () => createFilePromptCandidate({ ...file("x"), filename: "agent.md", path: "flows/other.md" }),
    /must end with its filename/,
  );
  await assert.rejects(
    () => createFilePromptCandidate({ ...file("x"), filename: "agent.md", path: "../agent.md" }),
    /\.\./,
  );
});
