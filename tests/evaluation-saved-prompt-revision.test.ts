import assert from "node:assert/strict";
import test from "node:test";

import {
  addEvaluationCase,
  addEvaluationInput,
  createEvaluationSuite,
  createRevisionFromSavedPrompt,
  evaluationBindingCandidates,
  updateEvaluationCase,
} from "../packages/core/src/evaluation-suite-authoring.ts";
import {
  describeConversationRevision,
  describeConversationRevisions,
} from "../packages/core/src/conversation-revision-description.ts";
import {
  archivePromptTemplate,
  createProjectFile,
  createPromptTemplate,
  insertPromptTemplateUse,
  PROJECT_SCHEMA_VERSION,
  parseProjectFile,
  ProjectValidationError,
  resolveProjectRevisionMessages,
  serializeProjectFile,
} from "../packages/core/src/project.ts";
import type { ProjectFile } from "../packages/core/src/project.ts";

/**
 * A project whose current revision is deliberately scaffolded: a literal system
 * message plus an existing use of the same template the shortcut will insert.
 * It is the situation where prompt-only and copy-and-append semantics visibly
 * disagree.
 */
function fixture(): ProjectFile {
  let project = createProjectFile({
    name: "Saved prompt authoring",
    idSuffix: "saved-prompt",
    createdAt: "2026-08-01T12:00:00.000Z",
    request: {
      provider: "openai-compatible",
      endpoint: "http://localhost:4010/v1/chat/completions",
      model: "fixture",
      messages: [{ role: "system", content: "Be concise." }],
    },
  });
  project = createPromptTemplate(project, {
    name: "Question",
    messages: [{ role: "user", content: "Explain {{topic}} to {{audience}}." }],
    variableDefaults: { audience: "engineers" },
    idSuffix: "question",
    createdAt: "2026-08-01T12:00:01.000Z",
  });
  project = createPromptTemplate(project, {
    name: "Safety policy",
    messages: [
      { role: "system", content: "Refuse anything outside {{policy}}." },
      { role: "user", content: "Review this change." },
    ],
    idSuffix: "safety",
    createdAt: "2026-08-01T12:00:02.000Z",
  });
  return insertPromptTemplateUse(project, {
    conversationRevisionId: project.defaults.conversationRevisionId,
    templateId: "template_question",
    idSuffix: "existing-use",
  });
}

test("creates a prompt-only child revision that pins the template's current immutable revision", () => {
  const project = fixture();
  const parentRevisionId = project.defaults.conversationRevisionId;
  const parentItemCount = project.conversationRevisions[0]!.items.length;

  const created = createRevisionFromSavedPrompt(project, {
    parentRevisionId,
    templateId: "template_question",
    revisionIdSuffix: "from-prompt",
    templateUseIdSuffix: "prompt-use",
    createdAt: "2026-08-02T09:00:00.000Z",
  });

  assert.equal(created.conversationRevisionId, "revision_from-prompt");
  assert.equal(created.templateUseId, "template-use_prompt-use");

  const revision = created.project.conversationRevisions.find(
    ({ id }) => id === created.conversationRevisionId,
  )!;
  // Prompt-only: the parent's system message and its earlier use of the same
  // template are deliberately absent, so the action cannot duplicate them.
  assert.equal(revision.items.length, 1);
  assert.equal(revision.items[0]!.kind, "template-use");
  assert.equal(revision.parentRevisionId, parentRevisionId);
  assert.equal(revision.conversationId, project.conversationRevisions[0]!.conversationId);
  assert.equal(revision.createdAt, "2026-08-02T09:00:00.000Z");

  const use = revision.items[0]!.kind === "template-use" ? revision.items[0]!.use : undefined;
  assert.equal(use?.templateId, "template_question");
  assert.equal(
    use?.templateRevisionId,
    project.promptTemplates.find(({ id }) => id === "template_question")!.currentRevisionId,
  );
  // Empty authored values keep ordinary template defaults in force and leave
  // room for case bindings to supply the final override.
  assert.deepEqual(use?.values, {});

  assert.equal(created.project.defaults.conversationRevisionId, parentRevisionId);
  // The parent is untouched and the input project was not mutated.
  assert.equal(project.defaults.conversationRevisionId, parentRevisionId);
  assert.equal(project.conversationRevisions.length, 1);
  assert.equal(project.conversationRevisions[0]!.items.length, parentItemCount);
});

test("a multi-message saved prompt arrives whole, ordered, and atomic", () => {
  const project = fixture();
  const created = createRevisionFromSavedPrompt(project, {
    parentRevisionId: project.defaults.conversationRevisionId,
    templateId: "template_safety",
    revisionIdSuffix: "from-safety",
    templateUseIdSuffix: "safety-use",
  });
  const revision = created.project.conversationRevisions.find(
    ({ id }) => id === created.conversationRevisionId,
  )!;

  // One authored item, two output messages: the template's own structure is
  // preserved without becoming two independently editable items.
  assert.equal(revision.items.length, 1);
  const use = revision.items[0]!.kind === "template-use" ? revision.items[0]!.use : undefined;
  assert.equal(use?.outputMessageIds.length, 2);
  assert.equal(new Set(use?.outputMessageIds).size, 2);

  const messages = resolveProjectRevisionMessages(created.project, revision);
  assert.deepEqual(messages.map(({ role }) => role), ["system", "user"]);
  assert.equal(
    messages[0]!.content.map(({ text }) => text).join(""),
    "Refuse anything outside {{policy}}.",
  );
});

test("generates fresh identities and leaves suites, bindings, and cases unchanged", () => {
  let project = fixture();
  const candidates = evaluationBindingCandidates(project, project.defaults.conversationRevisionId);
  const suite = createEvaluationSuite(project, "Topics", () => "topics");
  project = suite.project;
  const input = addEvaluationInput(project, suite.suiteId, candidates[0]!, () => "topic");
  project = input.project;
  const added = addEvaluationCase(project, suite.suiteId, () => "first");
  project = updateEvaluationCase(added.project, suite.suiteId, added.caseId, {
    name: "Migrations",
    values: { [input.inputId]: "database migrations" },
  });
  const suitesBefore = structuredClone(project.evaluationSuites);

  const created = createRevisionFromSavedPrompt(project, {
    parentRevisionId: project.defaults.conversationRevisionId,
    templateId: "template_question",
    revisionIdSuffix: "from-prompt",
    templateUseIdSuffix: "prompt-use",
  });

  assert.deepEqual(created.project.evaluationSuites, suitesBefore);
  // The same template, but a new stable use identity: an existing binding is
  // never retargeted onto it.
  assert.notEqual(created.templateUseId, "template-use_existing-use");
  assert.equal(
    created.project.evaluationSuites[0]!.inputBindings[0]!.target.templateUseId,
    "template-use_existing-use",
  );
  assert.deepEqual(created.project.defaults.target, project.defaults.target);
  assert.deepEqual(created.project.defaults.options, project.defaults.options);
  assert.deepEqual(created.project.defaults.enabledToolIds, project.defaults.enabledToolIds);
});

test("rejects a missing template, a missing parent revision, and an archived template", () => {
  const project = fixture();
  const parentRevisionId = project.defaults.conversationRevisionId;

  assert.throws(
    () => createRevisionFromSavedPrompt(project, { parentRevisionId, templateId: "template_absent" }),
    ProjectValidationError,
  );
  assert.throws(
    () => createRevisionFromSavedPrompt(project, {
      parentRevisionId: "revision_absent",
      templateId: "template_question",
    }),
    ProjectValidationError,
  );

  const archived = archivePromptTemplate(project, "template_question");
  assert.throws(
    () => createRevisionFromSavedPrompt(archived, { parentRevisionId, templateId: "template_question" }),
    (error: unknown) =>
      error instanceof ProjectValidationError &&
      error.issues.some(({ message }) => message.includes("Archived templates")),
  );
  // A refusal leaves no half-authored revision behind.
  assert.equal(archived.conversationRevisions.length, 1);
});

test("unresolved template variables are valid authored state, and the project stays schema version 8", () => {
  const project = fixture();
  const created = createRevisionFromSavedPrompt(project, {
    parentRevisionId: project.defaults.conversationRevisionId,
    templateId: "template_question",
    revisionIdSuffix: "from-prompt",
    templateUseIdSuffix: "prompt-use",
  });

  assert.equal(created.project.schemaVersion, PROJECT_SCHEMA_VERSION);
  assert.equal(created.project.schemaVersion, 8);
  // `topic` has no value at any level; that is authoring in progress, not a
  // document the parser may reject.
  const serialized = serializeProjectFile(created.project);
  assert.equal(serializeProjectFile(parseProjectFile(JSON.parse(serialized))), serialized);
  assert.match(serialized, /"topic"|Explain \{\{topic\}\}/u);
});

test("describes literal-only, single-template, multi-template, and empty revisions without raw IDs", () => {
  let project = fixture();
  const created = createRevisionFromSavedPrompt(project, {
    parentRevisionId: project.defaults.conversationRevisionId,
    templateId: "template_safety",
    revisionIdSuffix: "from-safety",
    templateUseIdSuffix: "safety-use",
  });
  project = insertPromptTemplateUse(created.project, {
    conversationRevisionId: created.conversationRevisionId,
    templateId: "template_question",
    idSuffix: "second-use",
  });

  const [parent, child] = describeConversationRevisions(project);
  assert.ok(parent && child);

  assert.equal(parent.isCurrentRevision, true);
  assert.equal(parent.templateUses.length, 1);
  assert.equal(parent.templateUses[0]!.templateName, "Question");
  assert.equal(parent.summary, "Be concise.");
  assert.equal(parent.summaryRole, "system");
  assert.equal(parent.messageCount, 2);

  assert.equal(child.isCurrentRevision, false);
  // Authored order is preserved, and each use is described by its own identity.
  assert.deepEqual(child.templateUses.map(({ templateName }) => templateName), [
    "Safety policy",
    "Question",
  ]);
  assert.deepEqual(child.templateUses.map(({ templateUseId }) => templateUseId), [
    "template-use_safety-use",
    "template-use_second-use",
  ]);
  assert.ok(child.templateUses.every(({ pinnedToCurrentTemplateRevision }) => pinnedToCurrentTemplateRevision));
  assert.equal(child.messageCount, 3);
  assert.equal(child.summary, "Refuse anything outside {{policy}}.");
  assert.equal(child.resolvable, true);

  for (const descriptor of [parent, child]) {
    for (const value of [descriptor.summary, ...descriptor.templateUses.map(({ templateName }) => templateName)]) {
      assert.doesNotMatch(value, /undefined|NaN|\[object Object\]/u);
      assert.doesNotMatch(value, /^(revision|template-use|template)_/u);
    }
  }
});

test("a first message that is only whitespace is not a meaningful summary", () => {
  let project = createProjectFile({
    name: "Blank lead",
    idSuffix: "blank",
    createdAt: "2026-08-01T12:00:00.000Z",
    request: {
      provider: "openai-compatible",
      endpoint: "http://localhost:4010/v1",
      model: "fixture",
      messages: [
        { role: "system", content: "   " },
        { role: "user", content: "  Compare  the\n two plans.  " },
      ],
    },
  });
  const [descriptor] = describeConversationRevisions(project);
  assert.equal(descriptor!.summary, "Compare the two plans.");
  assert.equal(descriptor!.summaryRole, "user");

  project = parseProjectFile({
    ...project,
    conversationRevisions: project.conversationRevisions.map((revision) => ({ ...revision, items: [] })),
  });
  const [empty] = describeConversationRevisions(project);
  assert.equal(empty!.summary, "");
  assert.equal(empty!.messageCount, 0);
  assert.equal(empty!.summaryRole, undefined);
});

test("classifies compatibility by exact template-use ID and variable, not by template ID", () => {
  let project = fixture();
  const candidates = evaluationBindingCandidates(project, project.defaults.conversationRevisionId);
  const suite = createEvaluationSuite(project, "Topics", () => "topics");
  project = suite.project;
  project = addEvaluationInput(project, suite.suiteId, candidates[0]!, () => "topic").project;

  const parentRevisionId = project.defaults.conversationRevisionId;
  const created = createRevisionFromSavedPrompt(project, {
    parentRevisionId,
    // The same template as the bound use, but a new stable use identity.
    templateId: "template_question",
    revisionIdSuffix: "from-prompt",
    templateUseIdSuffix: "prompt-use",
  });
  const authored = created.project.evaluationSuites[0]!;

  const parent = describeConversationRevision(
    created.project,
    created.project.conversationRevisions.find(({ id }) => id === parentRevisionId)!,
    authored,
  );
  assert.deepEqual(parent.compatibility, { kind: "compatible" });

  const child = describeConversationRevision(
    created.project,
    created.project.conversationRevisions.find(({ id }) => id === created.conversationRevisionId)!,
    authored,
  );
  assert.equal(child.compatibility.kind, "incompatible");
  assert.deepEqual(
    child.compatibility.kind === "incompatible"
      ? child.compatibility.mismatches.map(({ reason, variableName }) => ({ reason, variableName }))
      : [],
    [{ reason: "missing-template-use", variableName: "topic" }],
  );

  // With no bindings there is nothing to be incompatible with.
  assert.deepEqual(
    describeConversationRevision(created.project, created.project.conversationRevisions[0]!).compatibility,
    { kind: "unbound" },
  );
});
