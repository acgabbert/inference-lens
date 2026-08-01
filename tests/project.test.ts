import assert from "node:assert/strict";
import test from "node:test";

import {
  PROJECT_DIRECTORY_SUFFIX,
  PROJECT_FILE_NAME,
  PROJECT_GITIGNORE_CONTENTS,
  PROJECT_SCHEMA_VERSION,
  ProjectValidationError,
  archivePromptTemplate,
  appendPromptTemplateRevision,
  authoredItemsForMessages,
  createBranchRevision,
  createProjectFile,
  createPromptTemplate,
  detachPromptTemplateUse,
  findPromptTemplateUsages,
  insertPromptTemplateUse,
  parseProjectFile,
  parseProjectJson,
  prepareProjectRevisionRun,
  projectDirectoryName,
  projectExportFileName,
  projectDraft,
  renamePromptTemplate,
  removePromptTemplateRevision,
  removePromptTemplateUse,
  resolveProjectRevision,
  restorePromptTemplate,
  sameConversationMessages,
  serializeProjectFile,
  setPromptTemplateCurrentRevision,
  setPromptTemplateRecommendedTarget,
  updateConnectionRequirementEndpoint,
  updateProjectDraft,
  updatePromptTemplateUseToLatest,
  updatePromptTemplateUseValues,
} from "../packages/core/src/project.ts";
import { evaluationSuitePreflight } from "../packages/core/src/evaluation-suites.ts";
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

function projectWithEvaluationSuite() {
  let project = createProjectFile({
    name: "Evaluation contract",
    request,
    idSuffix: "evaluation",
    createdAt: "2026-08-01T12:00:00.000Z",
  });
  project = createPromptTemplate(project, {
    name: "Question",
    messages: [{ role: "user", content: "Explain {{topic}}." }],
    idSuffix: "evaluation-question",
    revisionIdSuffix: "evaluation-question-1",
    createdAt: "2026-08-01T12:00:01.000Z",
  });
  project = insertPromptTemplateUse(project, {
    conversationRevisionId: project.defaults.conversationRevisionId,
    templateId: "template_evaluation-question",
    idSuffix: "evaluation-question",
    outputMessageIdSuffixes: ["evaluation-question"],
  });
  return parseProjectFile({
    ...project,
    evaluationSuites: [{
      id: "evaluation-suite_topics",
      name: "Topics",
      inputBindings: [{
        id: "evaluation-input_topic",
        name: "Topic",
        target: {
          kind: "template-variable",
          templateUseId: "template-use_evaluation-question",
          variableName: "topic",
        },
      }],
      cases: [{
        id: "evaluation-case_migrations",
        name: "Migrations",
        values: { "evaluation-input_topic": "database migrations" },
        checks: [
          {
            checkId: "check_mentions-migrations",
            kind: "contains",
            value: "migration",
            caseSensitive: false,
          },
          {
            checkId: "check_length",
            kind: "max-output-characters",
            limit: 500,
          },
        ],
        referenceAnswer: "A concise explanation of safe database migrations.",
      }],
    }],
  });
}

test("creates a strict, portable Project v7 document", () => {
  const project = createProjectFile({
    name: "Example",
    request,
    idSuffix: "example",
    createdAt: "2026-07-24T12:00:00.000Z",
  });

  assert.equal(PROJECT_DIRECTORY_SUFFIX, ".inference-lens");
  assert.equal(PROJECT_FILE_NAME, "project.json");
  assert.equal(PROJECT_GITIGNORE_CONTENTS, "*\n");
  assert.equal(
    projectDirectoryName("Customer prompt lab"),
    "Customer prompt lab.inference-lens",
  );
  assert.equal(
    projectDirectoryName("Draft / Windows: test.inference-lens"),
    "Draft - Windows- test.inference-lens",
  );
  assert.equal(projectDirectoryName("CON"), "CON-project.inference-lens");
  assert.equal(
    projectDirectoryName("COM1.archive"),
    "COM1-project.archive.inference-lens",
  );
  assert.equal(projectDirectoryName("   "), "Untitled.inference-lens");
  assert.equal(projectExportFileName("Prompt Lab"), "Prompt Lab.project.json");
  assert.equal(projectExportFileName("CON"), "CON-project.project.json");
  assert.equal(PROJECT_SCHEMA_VERSION, 7);
  assert.equal(project.schemaVersion, 7);
  assert.equal(project.projectId, "project_example");
  const draft = projectDraft(project);
  assert.deepEqual(projectDraft(project), {
    connectionRequirement: {
      id: "connection_example-default",
      name: "Default connection",
      provider: "openai-compatible",
      protocol: "openai-compatible-chat-completions",
      endpoint: "https://api.example.com/v1",
      capabilityOverrides: request.capabilities,
    },
    items: project.conversationRevisions[0].items,
    messages: draft.messages,
    templateResolutions: [],
    templateDiagnostics: [],
    model: "example-model",
    temperature: 0.4,
    tools: [],
    toolMocks: [],
    enabledToolIds: [],
  });
  assert.deepEqual(project.externalImports, []);
  assert.deepEqual(project.evaluationSuites, []);
  assert.equal(JSON.parse(serializeProjectFile(project)).schemaVersion, 7);
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

test("rejects projects older than the supported v5 migration boundary", () => {
  const current = createProjectFile({
    name: "Legacy",
    request,
    idSuffix: "legacy",
    createdAt: "2026-07-24T12:00:00.000Z",
  });

  for (const schemaVersion of [2, 3, 4]) {
    assert.throws(
      () => parseProjectFile({ ...current, schemaVersion }),
      /Invalid Inference Lens project/,
      `schema version ${schemaVersion} should be rejected`,
    );
  }
});

test("migrates Project v6 by adding an empty evaluation suite collection", () => {
  const current = createProjectFile({
    name: "Version 6",
    request,
    idSuffix: "version-6",
    createdAt: "2026-08-01T12:00:00.000Z",
  });
  const { evaluationSuites, ...version7WithoutSuites } = current;
  assert.deepEqual(evaluationSuites, []);

  const migrated = parseProjectFile({
    ...version7WithoutSuites,
    schemaVersion: 6,
  });

  assert.equal(migrated.schemaVersion, 7);
  assert.deepEqual(migrated.evaluationSuites, []);
  assert.equal(JSON.parse(serializeProjectFile(migrated)).schemaVersion, 7);
});

test("stores ordered evaluation suites, cases, bindings, checks, and reference answers", () => {
  const project = projectWithEvaluationSuite();
  const suite = project.evaluationSuites[0]!;

  assert.equal(suite.id, "evaluation-suite_topics");
  assert.deepEqual(suite.inputBindings.map(({ id }) => id), [
    "evaluation-input_topic",
  ]);
  assert.deepEqual(suite.cases[0]?.checks.map(({ checkId }) => checkId), [
    "check_mentions-migrations",
    "check_length",
  ]);
  assert.equal(
    suite.cases[0]?.referenceAnswer,
    "A concise explanation of safe database migrations.",
  );
  const serialized = serializeProjectFile(project);
  assert.deepEqual(parseProjectJson(serialized), project);
  assert.equal(serializeProjectFile(parseProjectJson(serialized)), serialized);

  const empty = parseProjectFile({
    ...project,
    evaluationSuites: [{ ...suite, cases: [] }],
  });
  assert.deepEqual(empty.evaluationSuites[0]?.cases, []);
});

test("strictly validates evaluation identities, checks, and complete case values", () => {
  const project = projectWithEvaluationSuite();
  const suite = project.evaluationSuites[0]!;
  const evaluationCase = suite.cases[0]!;
  const binding = suite.inputBindings[0]!;

  assert.throws(
    () => parseProjectFile({
      ...project,
      evaluationSuites: [{ ...suite, extra: true }],
    }),
    /Unrecognized key: "extra"/,
  );
  assert.throws(
    () => parseProjectFile({
      ...project,
      evaluationSuites: [{
        ...suite,
        inputBindings: [binding, { ...binding, name: "Second" }],
      }],
    }),
    /Duplicate identifier "evaluation-input_topic"/,
  );
  assert.throws(
    () => parseProjectFile({
      ...project,
      evaluationSuites: [{
        ...suite,
        cases: [{ ...evaluationCase, values: {} }],
      }],
    }),
    /missing a value for "evaluation-input_topic"/,
  );
  assert.throws(
    () => parseProjectFile({
      ...project,
      evaluationSuites: [{
        ...suite,
        cases: [{
          ...evaluationCase,
          values: {
            ...evaluationCase.values,
            "evaluation-input_unknown": "extra",
          },
        }],
      }],
    }),
    /unknown suite input "evaluation-input_unknown"/,
  );
  assert.throws(
    () => parseProjectFile({
      ...project,
      evaluationSuites: [{
        ...suite,
        cases: [{ ...evaluationCase, values: { "not-an-id": "extra" } }],
      }],
    }),
    /Invalid key in record/,
  );
  assert.throws(
    () => parseProjectFile({
      ...project,
      evaluationSuites: [{
        ...suite,
        cases: [
          evaluationCase,
          {
            ...evaluationCase,
            id: "evaluation-case_second",
            checks: [evaluationCase.checks[0]],
          },
        ],
      }],
    }),
    /Duplicate identifier "check_mentions-migrations"/,
  );
  assert.throws(
    () => parseProjectFile({
      ...project,
      evaluationSuites: [{
        ...suite,
        cases: [{
          ...evaluationCase,
          checks: [{
            checkId: "check_invalid-regex",
            kind: "regex",
            syntax: "re2",
            pattern: "(unclosed",
          }],
        }],
      }],
    }),
    /valid RE2-compatible Safe regex syntax/,
  );
});

test("rejects dangling and secret-like evaluation input bindings", () => {
  const project = projectWithEvaluationSuite();
  const suite = project.evaluationSuites[0]!;
  const binding = suite.inputBindings[0]!;

  assert.throws(
    () => parseProjectFile({
      ...project,
      evaluationSuites: [{
        ...suite,
        inputBindings: [{
          ...binding,
          target: { ...binding.target, templateUseId: "template-use_missing" },
        }],
      }],
    }),
    /unknown template use "template-use_missing"/,
  );
  assert.throws(
    () => parseProjectFile({
      ...project,
      evaluationSuites: [{
        ...suite,
        inputBindings: [{
          ...binding,
          target: { ...binding.target, variableName: "audience" },
        }],
      }],
    }),
    /no revision containing variable "audience"/,
  );
  assert.throws(
    () => parseProjectFile({
      ...project,
      evaluationSuites: [{
        ...suite,
        inputBindings: [{
          ...binding,
          target: { ...binding.target, variableName: "api_key" },
        }],
      }],
    }),
    /Secret-like template variables cannot be evaluation inputs/,
  );
});

test("preflight reports selected-revision compatibility without invalidating historical bindings", () => {
  let project = projectWithEvaluationSuite();
  const originalRevisionId = project.defaults.conversationRevisionId;
  assert.deepEqual(
    evaluationSuitePreflight(
      project,
      "evaluation-suite_topics",
      originalRevisionId,
    ),
    [],
  );

  project = appendPromptTemplateRevision(project, {
    templateId: "template_evaluation-question",
    messages: [{ role: "user", content: "Explain the selected subject." }],
    idSuffix: "evaluation-question-2",
    createdAt: "2026-08-01T12:00:02.000Z",
  });
  const original = project.conversationRevisions.find(
    ({ id }) => id === originalRevisionId,
  )!;
  const incompatibleRevisionId = "revision_evaluation-incompatible" as const;
  const missingUseRevisionId = "revision_evaluation-missing-use" as const;
  project = parseProjectFile({
    ...project,
    conversationRevisions: [
      ...project.conversationRevisions,
      {
        id: incompatibleRevisionId,
        conversationId: original.conversationId,
        parentRevisionId: original.id,
        createdAt: "2026-08-01T12:00:03.000Z",
        items: original.items.map((item) =>
          item.kind === "template-use"
            ? {
                ...item,
                use: {
                  ...item.use,
                  templateRevisionId: "template-revision_evaluation-question-2",
                },
              }
            : item,
        ),
      },
      {
        id: missingUseRevisionId,
        conversationId: original.conversationId,
        parentRevisionId: incompatibleRevisionId,
        createdAt: "2026-08-01T12:00:04.000Z",
        items: original.items.filter((item) => item.kind !== "template-use"),
      },
    ],
  });

  assert.deepEqual(
    evaluationSuitePreflight(
      project,
      "evaluation-suite_topics",
      incompatibleRevisionId,
    ).map(({ code }) => code),
    ["missing-template-variable"],
  );
  assert.deepEqual(
    evaluationSuitePreflight(
      project,
      "evaluation-suite_topics",
      missingUseRevisionId,
    ).map(({ code }) => code),
    ["missing-template-use"],
  );
});

test("migrates v5 fragments by duplicating templates used under different roles", () => {
  const base = createProjectFile({
    name: "Legacy roles",
    request,
    idSuffix: "legacy-roles",
    createdAt: "2026-07-24T12:00:00.000Z",
  });
  const { evaluationSuites, ...legacyBase } = base;
  assert.deepEqual(evaluationSuites, []);
  const legacy = {
    ...legacyBase,
    schemaVersion: 5,
    promptTemplates: [{
      id: "template_legacy-prompt",
      name: "Legacy prompt",
      currentRevisionId: "template-revision_legacy-prompt-1",
      revisions: [{
        id: "template-revision_legacy-prompt-1",
        createdAt: "2026-07-24T12:00:01.000Z",
        content: { kind: "fragment", text: "Hello {{name}}" },
        variableDefaults: { name: "Ada" },
      }],
    }],
    conversationRevisions: base.conversationRevisions.map((revision) => ({
      ...revision,
      items: ["user", "system"].map((role, index) => ({
        kind: "template-use",
        use: {
          id: `template-use_legacy-${role}`,
          templateId: "template_legacy-prompt",
          templateRevisionId: "template-revision_legacy-prompt-1",
          values: {},
          outputMessageIds: [`message_legacy-${index}`],
          fragmentRole: role,
        },
      })),
    })),
  };

  const migrated = parseProjectFile(legacy);
  assert.equal(migrated.schemaVersion, 7);
  assert.deepEqual(migrated.evaluationSuites, []);
  assert.equal(migrated.promptTemplates.length, 2);
  assert.deepEqual(
    migrated.promptTemplates.map(({ name, revisions }) => [
      name,
      revisions[0]?.messages[0]?.role,
    ]),
    [["Legacy prompt", "user"], ["Legacy prompt (System)", "system"]],
  );
  assert.deepEqual(
    projectDraft(migrated).messages.map(({ role, content }) => [
      role,
      content[0]?.type === "text" ? content[0].text : undefined,
    ]),
    [["user", "Hello Ada"], ["system", "Hello Ada"]],
  );
  const serialized = serializeProjectFile(migrated);
  assert.doesNotMatch(serialized, /fragmentRole|"kind": "fragment"/);
});

test("refuses to migrate a v5 revision that carries no messages", () => {
  const base = createProjectFile({
    name: "Legacy empty",
    request,
    idSuffix: "legacy-empty",
    createdAt: "2026-07-24T12:00:00.000Z",
  });
  const { evaluationSuites, ...legacyBase } = base;
  assert.deepEqual(evaluationSuites, []);
  const legacy = {
    ...legacyBase,
    schemaVersion: 5,
    promptTemplates: [{
      id: "template_legacy-empty",
      name: "Legacy empty",
      currentRevisionId: "template-revision_legacy-empty-1",
      revisions: [{
        id: "template-revision_legacy-empty-1",
        createdAt: "2026-07-24T12:00:01.000Z",
        content: { kind: "messages", messages: [] },
        variableDefaults: {},
      }],
    }],
    conversationRevisions: base.conversationRevisions.map((revision) => ({
      ...revision,
      items: [{
        kind: "template-use",
        use: {
          id: "template-use_legacy-empty",
          templateId: "template_legacy-empty",
          templateRevisionId: "template-revision_legacy-empty-1",
          values: {},
          outputMessageIds: ["message_legacy-empty-0"],
        },
      }],
    })),
  };

  assert.throws(
    () => parseProjectFile(legacy),
    /Cannot migrate a template revision with no messages/,
  );
});

test("resolves pinned single and multi-message prompts with stable output IDs", () => {
  const project = createProjectFile({
    name: "Templates",
    request,
    idSuffix: "templates",
    createdAt: "2026-07-24T12:00:00.000Z",
  });
  project.promptTemplates = [
    {
      id: "template_prompt",
      name: "Prompt",
      currentRevisionId: "template-revision_prompt-1",
      revisions: [
        {
          id: "template-revision_prompt-1",
          createdAt: "2026-07-24T12:00:00.000Z",
          messages: [{ role: "user", content: "Explain {{topic}} to {{audience}}." }],
          variableDefaults: { audience: "developers" },
        },
      ],
    },
    {
      id: "template_pair",
      name: "Pair",
      currentRevisionId: "template-revision_pair-1",
      revisions: [
        {
          id: "template-revision_pair-1",
          createdAt: "2026-07-24T12:00:00.000Z",
          messages: [
              { role: "system", content: "Voice: {{voice}}" },
              { role: "user", content: "Question: {{question}}" },
            ],
          variableDefaults: { voice: "clear" },
        },
      ],
    },
  ];
  project.conversationRevisions[0]!.items = [
    {
      kind: "template-use",
      use: {
        id: "template-use_prompt",
        templateId: "template_prompt",
        templateRevisionId: "template-revision_prompt-1",
        values: { topic: "migrations" },
        outputMessageIds: ["message_prompt"],
      },
    },
    {
      kind: "template-use",
      use: {
        id: "template-use_pair",
        templateId: "template_pair",
        templateRevisionId: "template-revision_pair-1",
        values: { question: "Why?" },
        outputMessageIds: ["message_pair-system", "message_pair-user"],
      },
    },
  ];

  const validated = parseProjectFile(project);
  assert.deepEqual(
    projectDraft(validated, {
      "template-use_prompt": { audience: "" },
    }).messages,
    [
      {
        id: "message_prompt",
        role: "user",
        content: [{ type: "text", text: "Explain migrations to ." }],
      },
      {
        id: "message_pair-system",
        role: "system",
        content: [{ type: "text", text: "Voice: clear" }],
      },
      {
        id: "message_pair-user",
        role: "user",
        content: [{ type: "text", text: "Question: Why?" }],
      },
    ],
  );

  const unchangedDraft = projectDraft(validated);
  const saved = updateProjectDraft(validated, {
    messages: unchangedDraft.messages,
    model: unchangedDraft.model,
    temperature: unchangedDraft.temperature,
    tools: unchangedDraft.tools,
    toolMocks: unchangedDraft.toolMocks,
    enabledToolIds: unchangedDraft.enabledToolIds,
  });
  assert.deepEqual(
    saved.conversationRevisions[0]?.items,
    validated.conversationRevisions[0]?.items,
  );
  assert.throws(
    () =>
      updateProjectDraft(validated, {
        messages: unchangedDraft.messages.map((message, index) =>
          index === 0
            ? {
                ...message,
                content: [{ type: "text", text: "Silently drifted" }],
              }
            : message,
        ),
        model: unchangedDraft.model,
        temperature: unchangedDraft.temperature,
        tools: unchangedDraft.tools,
        toolMocks: unchangedDraft.toolMocks,
        enabledToolIds: unchangedDraft.enabledToolIds,
      }),
    /Detach the template use/,
  );
});

test("keeps authored order when literal messages and template uses interleave", () => {
  const project = createProjectFile({
    name: "Interleaved",
    request,
    idSuffix: "interleaved",
    createdAt: "2026-07-24T12:00:00.000Z",
  });
  project.promptTemplates = [
    {
      id: "template_middle",
      name: "Middle",
      currentRevisionId: "template-revision_middle-1",
      revisions: [
        {
          id: "template-revision_middle-1",
          createdAt: "2026-07-24T12:00:00.000Z",
          messages: [
              { role: "user", content: "Second" },
              { role: "assistant", content: "Third" },
            ],
          variableDefaults: {},
        },
      ],
    },
  ];
  project.conversationRevisions[0]!.items = [
    {
      kind: "message",
      message: {
        id: "message_first",
        role: "system",
        content: [{ type: "text", text: "First" }],
      },
    },
    {
      kind: "template-use",
      use: {
        id: "template-use_middle",
        templateId: "template_middle",
        templateRevisionId: "template-revision_middle-1",
        values: {},
        outputMessageIds: ["message_second", "message_third"],
      },
    },
    {
      kind: "message",
      message: {
        id: "message_fourth",
        role: "user",
        content: [{ type: "text", text: "Fourth" }],
      },
    },
  ];

  const draft = projectDraft(parseProjectFile(project));
  assert.deepEqual(
    draft.messages.map(({ id, role, content }) => [
      id,
      role,
      content[0]?.type === "text" ? content[0].text : null,
    ]),
    [
      ["message_first", "system", "First"],
      ["message_second", "user", "Second"],
      ["message_third", "assistant", "Third"],
      ["message_fourth", "user", "Fourth"],
    ],
  );
});

test("creates immutable template revisions, finds uses, and rejects unsafe removal", () => {
  const project = createProjectFile({
    name: "Template helpers",
    request,
    idSuffix: "template-helpers",
    createdAt: "2026-07-24T12:00:00.000Z",
  });
  const created = createPromptTemplate(project, {
    name: "Question",
    messages: [{ role: "user", content: "Explain {{topic}}." }],
    variableDefaults: { topic: "branching" },
    idSuffix: "question",
    revisionIdSuffix: "question-1",
    createdAt: "2026-07-24T12:01:00.000Z",
  });
  const unchanged = appendPromptTemplateRevision(created, {
    templateId: "template_question",
    messages: [{ role: "user", content: "Explain {{topic}}." }],
    variableDefaults: { topic: "branching" },
    idSuffix: "unused",
  });
  assert.equal(unchanged, created);

  const renamed = renamePromptTemplate(created, "template_question", "Question v2");
  assert.equal(renamed.promptTemplates[0]?.name, "Question v2");
  assert.equal(
    renamed.promptTemplates[0]?.currentRevisionId,
    created.promptTemplates[0]?.currentRevisionId,
  );
  assert.throws(
    () => renamePromptTemplate(created, "template_question", " "),
    /Template name is required/,
  );

  const revised = appendPromptTemplateRevision(created, {
    templateId: "template_question",
    messages: [{ role: "user", content: "Summarize {{topic}}." }],
    variableDefaults: { topic: "branching" },
    idSuffix: "question-2",
    createdAt: "2026-07-24T12:02:00.000Z",
  });
  assert.equal(
    revised.promptTemplates[0]?.currentRevisionId,
    "template-revision_question-2",
  );
  assert.equal(revised.promptTemplates[0]?.revisions.length, 2);

  revised.conversationRevisions[0]!.items.push({
    kind: "template-use",
    use: {
      id: "template-use_question",
      templateId: "template_question",
      templateRevisionId: "template-revision_question-1",
      values: {},
      outputMessageIds: ["message_question"],
    },
  });
  const used = parseProjectFile(revised);
  assert.deepEqual(
    findPromptTemplateUsages(
      used,
      "template_question",
      "template-revision_question-1",
    ).map(({ conversationRevisionId, itemIndex, use }) => [
      conversationRevisionId,
      itemIndex,
      use.id,
    ]),
    [["revision_template-helpers-initial", 2, "template-use_question"]],
  );
  assert.throws(
    () =>
      removePromptTemplateRevision(
        used,
        "template_question",
        "template-revision_question-1",
      ),
    /referenced template revision cannot be removed/,
  );

  const resetCurrent = setPromptTemplateCurrentRevision(
    revised,
    "template_question",
    "template-revision_question-1",
  );
  const removed = removePromptTemplateRevision(
    resetCurrent,
    "template_question",
    "template-revision_question-2",
  );
  assert.deepEqual(
    removed.promptTemplates[0]?.revisions.map(({ id }) => id),
    ["template-revision_question-1"],
  );
});

test("archives templates without breaking pinned uses and restores future insertion", () => {
  const base = createProjectFile({
    name: "Archived template",
    request,
    idSuffix: "archive-template",
    createdAt: "2026-07-31T12:00:00.000Z",
  });
  const created = createPromptTemplate(base, {
    name: "Reusable",
    messages: [{ role: "user", content: "Explain {{topic}}." }],
    variableDefaults: { topic: "archives" },
    idSuffix: "archive-reusable",
    revisionIdSuffix: "archive-reusable-1",
    createdAt: "2026-07-31T12:01:00.000Z",
  });
  const conversationRevisionId = created.defaults.conversationRevisionId;
  const used = insertPromptTemplateUse(created, {
    conversationRevisionId,
    templateId: "template_archive-reusable",
    idSuffix: "archive-use",
    outputMessageIdSuffixes: ["archive-output"],
  });

  const archived = archivePromptTemplate(
    used,
    "template_archive-reusable",
    "2026-07-31T12:02:00.000Z",
  );
  assert.equal(
    archived.promptTemplates[0]?.archivedAt,
    "2026-07-31T12:02:00.000Z",
  );
  assert.equal(findPromptTemplateUsages(archived, "template_archive-reusable").length, 1);
  assert.equal(resolveProjectRevision(archived, archived.conversationRevisions[0]!).messages.at(-1)?.content[0]?.type, "text");
  assert.throws(
    () =>
      insertPromptTemplateUse(archived, {
        conversationRevisionId,
        templateId: "template_archive-reusable",
      }),
    /Archived templates cannot be added/,
  );

  const restored = restorePromptTemplate(archived, "template_archive-reusable");
  assert.equal(restored.promptTemplates[0]?.archivedAt, undefined);
  assert.doesNotThrow(() =>
    insertPromptTemplateUse(restored, {
      conversationRevisionId,
      templateId: "template_archive-reusable",
    }),
  );
});

test("inserts, updates, detaches, and removes template uses through core helpers", () => {
  const base = createProjectFile({
    name: "Template use helpers",
    request,
    idSuffix: "template-use-helpers",
    createdAt: "2026-07-24T12:00:00.000Z",
  });
  const created = createPromptTemplate(base, {
    name: "Reusable",
    messages: [{ role: "user", content: "{{kept}} {{obsolete}}" }],
    variableDefaults: {},
    idSuffix: "reusable",
    revisionIdSuffix: "reusable-1",
    createdAt: "2026-07-24T12:01:00.000Z",
  });
  const conversationRevisionId = created.conversationRevisions[0]!.id;
  const inserted = insertPromptTemplateUse(created, {
    conversationRevisionId,
    templateId: "template_reusable",
    values: { kept: "Keep", obsolete: "Remove" },
    itemIndex: 1,
    idSuffix: "reusable",
    outputMessageIdSuffixes: ["reusable-1"],
  });
  assert.equal(
    inserted.conversationRevisions[0]?.items[1]?.kind,
    "template-use",
  );

  const valuesUpdated = updatePromptTemplateUseValues(inserted, {
    conversationRevisionId,
    templateUseId: "template-use_reusable",
    values: { kept: "Still", obsolete: "Drop" },
  });
  const revised = appendPromptTemplateRevision(valuesUpdated, {
    templateId: "template_reusable",
    messages: [
        { role: "system", content: "{{kept}}" },
        { role: "user", content: "{{added}}" },
      ],
    variableDefaults: {},
    idSuffix: "reusable-2",
    createdAt: "2026-07-24T12:02:00.000Z",
  });
  const latest = updatePromptTemplateUseToLatest(revised, {
    conversationRevisionId,
    templateUseId: "template-use_reusable",
    newOutputMessageIdSuffixes: ["reusable-2"],
  });
  const latestWithValues = updatePromptTemplateUseValues(latest, {
    conversationRevisionId,
    templateUseId: "template-use_reusable",
    values: { kept: "Still", added: "Now" },
  });
  const latestUse = findPromptTemplateUsages(
    latestWithValues,
    "template_reusable",
  )[0]!.use;
  assert.equal(
    latestUse.templateRevisionId,
    "template-revision_reusable-2",
  );
  assert.deepEqual(latestUse.values, { added: "Now", kept: "Still" });
  assert.deepEqual(latestUse.outputMessageIds, [
    "message_reusable-1",
    "message_reusable-2",
  ]);
  assert.equal("fragmentRole" in latestUse, false);

  const detached = detachPromptTemplateUse(latestWithValues, {
    conversationRevisionId,
    templateUseId: "template-use_reusable",
  });
  assert.deepEqual(
    detached.conversationRevisions[0]?.items.slice(1, 3),
    [
      {
        kind: "message",
        message: {
          id: "message_reusable-1",
          role: "system",
          content: [{ type: "text", text: "Still" }],
        },
      },
      {
        kind: "message",
        message: {
          id: "message_reusable-2",
          role: "user",
          content: [{ type: "text", text: "Now" }],
        },
      },
    ],
  );

  const removed = removePromptTemplateUse(
    latestWithValues,
    conversationRevisionId,
    "template-use_reusable",
  );
  assert.equal(findPromptTemplateUsages(removed, "template_reusable").length, 0);
  assert.deepEqual(
    removed.conversationRevisions[0]?.items,
    base.conversationRevisions[0]?.items,
  );
});

test("resolves an unfilled variable into a diagnostic instead of a failure", () => {
  const project = createProjectFile({
    name: "Unfilled",
    request,
    idSuffix: "unfilled",
    createdAt: "2026-07-24T12:00:00.000Z",
  });
  project.promptTemplates = [
    {
      id: "template_open",
      name: "Open",
      currentRevisionId: "template-revision_open-1",
      revisions: [
        {
          id: "template-revision_open-1",
          createdAt: "2026-07-24T12:00:00.000Z",
          messages: [{ role: "user", content: "Explain {{topic}}." }],
          variableDefaults: {},
        },
      ],
    },
  ];
  project.conversationRevisions[0]!.items = [
    {
      kind: "template-use",
      use: {
        id: "template-use_open",
        templateId: "template_open",
        templateRevisionId: "template-revision_open-1",
        values: {},
        outputMessageIds: ["message_open"],
      },
    },
  ];

  // A template use whose value arrives later, or per run, is authorable state.
  const validated = parseProjectFile(project);
  const draft = projectDraft(validated);
  assert.deepEqual(draft.messages, [
    {
      id: "message_open",
      role: "user",
      content: [{ type: "text", text: "Explain {{topic}}." }],
    },
  ]);
  assert.deepEqual(
    draft.templateDiagnostics.map(({ itemIndex, templateUseId, diagnostic }) => [
      itemIndex,
      templateUseId,
      diagnostic.code,
      diagnostic.code === "missing-template-variable" ? diagnostic.name : null,
    ]),
    [[0, "template-use_open", "missing-template-variable", "topic"]],
  );

  // An unrelated edit still saves; the unresolved variable does not lock the
  // whole document.
  const saved = updateProjectDraft(validated, {
    messages: draft.messages,
    model: "another-model",
    temperature: draft.temperature,
    tools: draft.tools,
    toolMocks: draft.toolMocks,
    enabledToolIds: draft.enabledToolIds,
  });
  assert.equal(saved.defaults.target.model, "another-model");
  assert.deepEqual(
    saved.conversationRevisions[0]?.items,
    validated.conversationRevisions[0]?.items,
  );

  // A run override supplies the value without changing the saved document.
  assert.deepEqual(
    projectDraft(validated, { "template-use_open": { topic: "migrations" } })
      .messages[0]?.content,
    [{ type: "text", text: "Explain migrations." }],
  );

  const blocked = prepareProjectRevisionRun(
    validated,
    validated.conversationRevisions[0]!,
  );
  assert.equal(blocked.ok, false);
  if (blocked.ok) return;
  assert.deepEqual(
    blocked.diagnostics.map(({ templateUseId, diagnostic }) => [
      templateUseId,
      diagnostic.code,
    ]),
    [["template-use_open", "missing-template-variable"]],
  );

  const prepared = prepareProjectRevisionRun(
    validated,
    validated.conversationRevisions[0]!,
    { "template-use_open": { topic: "migrations" } },
  );
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  assert.deepEqual(prepared.messages[0]?.content, [
    { type: "text", text: "Explain migrations." },
  ]);
  assert.equal(prepared.templateResolutions[0]?.values.topic, "migrations");
  assert.throws(
    () =>
      prepareProjectRevisionRun(validated, validated.conversationRevisions[0]!, {
        "template-use_open": { apiKey: "not-portable" },
      }),
    /Secret values cannot be supplied as template run overrides/,
  );
  assert.throws(
    () =>
      prepareProjectRevisionRun(validated, validated.conversationRevisions[0]!, {
        "template-use_unknown": { topic: "migrations" },
      }),
    /unknown template use/,
  );
});

test("rejects invalid template-use ownership, output shape, and secret-like values", () => {
  const project = createProjectFile({
    name: "Invalid template use",
    request,
    idSuffix: "invalid-use",
    createdAt: "2026-07-24T12:00:00.000Z",
  });
  project.promptTemplates = [
    {
      id: "template_prompt",
      name: "Prompt",
      currentRevisionId: "template-revision_prompt-1",
      revisions: [
        {
          id: "template-revision_prompt-1",
          createdAt: "2026-07-24T12:00:00.000Z",
          messages: [{ role: "user", content: "{{input}}" }],
          variableDefaults: {},
        },
      ],
    },
  ];
  project.conversationRevisions[0]!.items = [
    {
      kind: "template-use",
      use: {
        id: "template-use_prompt",
        templateId: "template_prompt",
        templateRevisionId: "template-revision_missing",
        values: { apiKey: "not-allowed" },
        outputMessageIds: ["message_one", "message_two"],
      },
    },
  ];

  assert.throws(
    () => parseProjectFile(project),
    /does not belong to the referenced template/,
  );
  project.conversationRevisions[0]!.items[0] = {
    kind: "template-use",
    use: {
      id: "template-use_prompt",
      templateId: "template_prompt",
      templateRevisionId: "template-revision_prompt-1",
      values: { apiKey: "not-allowed" },
      outputMessageIds: ["message_one", "message_two"],
    },
  };
  assert.throws(() => parseProjectFile(project), /provide 1 output message ID/);
  project.conversationRevisions[0]!.items[0] = {
    kind: "template-use",
    use: {
      id: "template-use_prompt",
      templateId: "template_prompt",
      templateRevisionId: "template-revision_prompt-1",
      values: { apiKey: "not-allowed" },
      outputMessageIds: ["message_one"],
    },
  };
  assert.throws(() => parseProjectFile(project), /Secret values cannot be stored/);
});

test("rejects use values that are not present in their pinned revision", () => {
  const project = templateBranchProject();
  const item = project.conversationRevisions[0]!.items[0]!;
  assert.equal(item.kind, "template-use");
  if (item.kind !== "template-use") return;
  item.use.values.unused = "hidden";
  assert.throws(
    () => parseProjectFile(project),
    /use value "unused" is not used/,
  );
});

test("records a recommended target without appending a revision or unpinning uses", () => {
  const base = createProjectFile({
    name: "Recommendations",
    request,
    idSuffix: "recommendations",
    createdAt: "2026-07-24T12:00:00.000Z",
  });
  const created = createPromptTemplate(base, {
    name: "Question",
    messages: [{ role: "user", content: "Explain {{topic}}." }],
    variableDefaults: { topic: "branching" },
    idSuffix: "question",
    revisionIdSuffix: "question-1",
    createdAt: "2026-07-24T12:01:00.000Z",
  });
  const inserted = insertPromptTemplateUse(created, {
    conversationRevisionId: created.conversationRevisions[0]!.id,
    templateId: "template_question",
    itemIndex: 0,
    values: {},
    idSuffix: "question-use",
    outputMessageIdSuffixes: ["question-use-1"],
  });
  const pinnedUse = inserted.conversationRevisions
    .at(-1)!
    .items.find((item) => item.kind === "template-use")!;
  assert.equal(pinnedUse.kind, "template-use");
  if (pinnedUse.kind !== "template-use") return;

  const target = {
    connectionRequirementId: base.connectionRequirements[0]!.id,
    model: "model-authored-for-question",
  };
  const recommended = setPromptTemplateRecommendedTarget(
    inserted,
    "template_question",
    target,
  );
  const template = recommended.promptTemplates[0]!;
  assert.deepEqual(template.recommendedTarget, target);
  // The point of template-level ownership: authored content is untouched, so
  // every existing use stays pinned to the revision it already named.
  assert.equal(template.revisions.length, 1);
  assert.deepEqual(template.revisions, inserted.promptTemplates[0]!.revisions);
  assert.equal(
    template.currentRevisionId,
    inserted.promptTemplates[0]!.currentRevisionId,
  );
  const stillPinned = recommended.conversationRevisions
    .at(-1)!
    .items.find((item) => item.kind === "template-use")!;
  assert.equal(stillPinned.kind, "template-use");
  if (stillPinned.kind !== "template-use") return;
  assert.equal(
    stillPinned.use.templateRevisionId,
    pinnedUse.use.templateRevisionId,
  );

  assert.equal(
    setPromptTemplateRecommendedTarget(recommended, "template_question", {
      ...target,
    }),
    recommended,
  );
  const cleared = setPromptTemplateRecommendedTarget(
    recommended,
    "template_question",
    undefined,
  );
  assert.equal(cleared.promptTemplates[0]?.recommendedTarget, undefined);
  assert.ok(
    !Object.hasOwn(cleared.promptTemplates[0]!, "recommendedTarget"),
    "clearing should drop the key rather than store undefined",
  );
  assert.throws(
    () => setPromptTemplateRecommendedTarget(base, "template_missing", target),
    /Template does not exist/,
  );
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
      messages: [
        {
          id: "message_updated",
          role: "user",
          content: [{ type: "text", text: "Updated" }],
        },
      ],
      model: "new-model",
      temperature: 0,
      tools: project.tools,
      toolMocks: project.toolMocks,
      enabledToolIds: project.defaults.enabledToolIds,
    },
  );

  assert.equal(updated.tools[0]?.id, "tool_lookup");
  assert.equal(updated.defaults.target.model, "new-model");
  assert.equal(updated.defaults.options.temperature, 0);
  assert.deepEqual(projectDraft(updated).messages, [
    {
      id: "message_updated",
      role: "user",
      content: [{ type: "text", text: "Updated" }],
    },
  ]);
});

test("updates drafts by ID without misattributing tool calls after reordering", () => {
  const project = createProjectFile({
    name: "Example",
    request,
    idSuffix: "rich",
    createdAt: "2026-07-24T12:00:00.000Z",
  });
  const [system, user] = projectDraft(project).messages;
  const assistant = {
    id: "message_assistant" as const,
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "Calling lookup." }],
    toolCalls: [
      {
        id: "tool-call_lookup" as const,
        name: "lookup",
        arguments: { text: '{"query":"hello"}' },
      },
    ],
  };
  const tool = {
    id: "message_tool" as const,
    role: "tool" as const,
    toolCallId: "tool-call_lookup" as const,
    name: "lookup",
    content: [{ type: "text" as const, text: "result" }],
  };
  const inserted = {
    id: "message_inserted" as const,
    role: "user" as const,
    content: [{ type: "text" as const, text: "Clarification" }],
  };
  project.conversationRevisions[0].items = [system, user, assistant, tool].map(
    (message) => ({ kind: "message", message }),
  );

  const updated = updateProjectDraft(project, {
    messages: [system, inserted, tool, assistant],
    model: project.defaults.target.model,
    temperature: project.defaults.options.temperature,
    tools: project.tools,
    toolMocks: project.toolMocks,
    enabledToolIds: project.defaults.enabledToolIds,
  });

  assert.deepEqual(projectDraft(updated).messages, [
    system,
    inserted,
    tool,
    assistant,
  ]);
});

test("appends a branch revision with validated lineage and preserves it through export", () => {
  const project = createProjectFile({
    name: "Example",
    request,
    idSuffix: "branch",
    createdAt: "2026-07-24T12:00:00.000Z",
  });
  const root = project.conversationRevisions[0]!;
  const rootMessages = projectDraft(project).messages;
  const child = createBranchRevision(project, {
    conversationId: root.conversationId,
    parentRevisionId: root.id,
    messages: [rootMessages[0]!],
    idSuffix: "child",
    createdAt: "2026-07-24T12:01:00.000Z",
  });
  const grandchild = createBranchRevision(child, {
    conversationId: root.conversationId,
    parentRevisionId: "revision_child",
    messages: rootMessages,
    idSuffix: "grandchild",
    createdAt: "2026-07-24T12:02:00.000Z",
  });

  assert.equal(grandchild.defaults.conversationRevisionId, "revision_grandchild");
  assert.deepEqual(
    grandchild.conversationRevisions.map(({ id, parentRevisionId }) => ({ id, parentRevisionId })),
    [
      { id: root.id, parentRevisionId: undefined },
      { id: "revision_child", parentRevisionId: root.id },
      { id: "revision_grandchild", parentRevisionId: "revision_child" },
    ],
  );
  assert.deepEqual(
    parseProjectJson(serializeProjectFile(grandchild)).conversationRevisions,
    grandchild.conversationRevisions,
  );
});

test("keeps template uses atomic and authored when creating a branch", () => {
  const project = createProjectFile({
    name: "Template branch",
    request,
    idSuffix: "template-branch",
    createdAt: "2026-07-24T12:00:00.000Z",
  });
  project.promptTemplates = [
    {
      id: "template_pair",
      name: "Pair",
      currentRevisionId: "template-revision_pair-1",
      revisions: [
        {
          id: "template-revision_pair-1",
          createdAt: "2026-07-24T12:00:00.000Z",
          messages: [
              { role: "system", content: "System {{topic}}" },
              { role: "user", content: "User {{topic}}" },
            ],
          variableDefaults: { topic: "branching" },
        },
      ],
    },
  ];
  project.conversationRevisions[0]!.items = [
    {
      kind: "template-use",
      use: {
        id: "template-use_pair",
        templateId: "template_pair",
        templateRevisionId: "template-revision_pair-1",
        values: {},
        outputMessageIds: ["message_pair-system", "message_pair-user"],
      },
    },
  ];
  const validated = parseProjectFile(project);
  const messages = projectDraft(validated).messages;
  const assistant = {
    id: "message_assistant" as const,
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "Answer" }],
  };
  const branched = createBranchRevision(validated, {
    conversationId: validated.conversations[0]!.id,
    parentRevisionId: validated.conversationRevisions[0]!.id,
    messages: [...messages, assistant],
    idSuffix: "child",
    createdAt: "2026-07-24T12:01:00.000Z",
  });
  assert.deepEqual(branched.conversationRevisions.at(-1)?.items, [
    validated.conversationRevisions[0]!.items[0],
    { kind: "message", message: assistant },
  ]);
  const prepared = prepareProjectRevisionRun(
    branched,
    branched.conversationRevisions.at(-1)!,
  );
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  assert.equal(prepared.templateResolutions.length, 1);

  assert.throws(
    () =>
      createBranchRevision(validated, {
        conversationId: validated.conversations[0]!.id,
        parentRevisionId: validated.conversationRevisions[0]!.id,
        messages: [messages[0]!],
      }),
    /template use is atomic/,
  );
  assert.throws(
    () =>
      createBranchRevision(validated, {
        conversationId: validated.conversations[0]!.id,
        parentRevisionId: validated.conversationRevisions[0]!.id,
        messages: [
          {
            ...messages[0]!,
            content: [{ type: "text", text: "Edited generated text" }],
          },
          messages[1]!,
        ],
      }),
    /generated text cannot be edited/,
  );
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
  assert.throws(
    () =>
      parseProjectFile({
        ...project,
        promptTemplates: [
          {
            id: "template_invalid-target",
            name: "Invalid target",
            currentRevisionId: "template-revision_invalid-target-1",
            recommendedTarget: {
              connectionRequirementId: "connection_missing",
              model: "example-model",
            },
            revisions: [
              {
                id: "template-revision_invalid-target-1",
                createdAt: "2026-07-24T12:00:01.000Z",
                messages: [{ role: "user", content: "Hello" }],
                variableDefaults: {},
              },
            ],
          },
        ],
      }),
    /unknown connection requirement/,
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

  for (const endpoint of [
    "https://api.example.com/v1?x-api-key=secret",
    "https://api.example.com/v1?token=secret",
    "https://api.example.com/v1?X-Amz-Credential=scope&X-Amz-Signature=signed",
    "https://api.example.com/v1?sig=signed",
    "https://api.example.com/v1#access_token=secret",
  ]) {
    project.connectionRequirements[0].endpoint = endpoint;
    assert.throws(
      () => parseProjectFile(project),
      /query parameters, or fragments/,
      endpoint,
    );
  }

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
        messages: [{ role: "user", content: "Summarize {{input}}" }],
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

function templateBranchProject() {
  const project = createProjectFile({
    name: "Override branch",
    request,
    idSuffix: "override-branch",
    createdAt: "2026-07-26T12:00:00.000Z",
  });
  project.promptTemplates = [
    {
      id: "template_pair",
      name: "Pair",
      currentRevisionId: "template-revision_pair-1",
      revisions: [
        {
          id: "template-revision_pair-1",
          createdAt: "2026-07-26T12:00:00.000Z",
          messages: [
              { role: "system", content: "System {{topic}}" },
              { role: "user", content: "User {{topic}}" },
            ],
          variableDefaults: { topic: "saved" },
        },
      ],
    },
  ];
  project.conversationRevisions[0]!.items = [
    {
      kind: "template-use",
      use: {
        id: "template-use_pair",
        templateId: "template_pair",
        templateRevisionId: "template-revision_pair-1",
        values: {},
        outputMessageIds: ["message_pair-system", "message_pair-user"],
      },
    },
  ];
  return parseProjectFile(project);
}

test("compares conversation messages by value, not by serialized key order", () => {
  const reordered = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "Answer" }],
    id: "message_answer" as const,
  };
  const declared = {
    id: "message_answer" as const,
    content: [{ type: "text" as const, text: "Answer" }],
    role: "assistant" as const,
  };
  assert.notEqual(JSON.stringify([reordered]), JSON.stringify([declared]));
  assert.equal(sameConversationMessages([reordered], [declared]), true);
  assert.equal(
    sameConversationMessages(
      [reordered],
      [{ ...declared, content: [{ type: "text", text: "Different" }] }],
    ),
    false,
  );
  assert.equal(sameConversationMessages([reordered], []), false);
});

test("branches a template-backed conversation whose messages came off run state", () => {
  const validated = templateBranchProject();
  const resolved = projectDraft(validated).messages;
  // Run state hands messages back with their own key order; validation rebuilds
  // them in schema order. The branch must not read that as an edit.
  const fromRunState = resolved.map((message) => ({
    role: message.role,
    content: message.content,
    id: message.id,
  })) as typeof resolved;
  assert.notEqual(JSON.stringify(fromRunState), JSON.stringify(resolved));

  const branched = createBranchRevision(validated, {
    conversationId: validated.conversations[0]!.id,
    parentRevisionId: validated.conversationRevisions[0]!.id,
    messages: fromRunState,
    idSuffix: "child",
    createdAt: "2026-07-26T12:01:00.000Z",
  });
  assert.deepEqual(branched.conversationRevisions.at(-1)?.items, [
    validated.conversationRevisions[0]!.items[0],
  ]);

  // The same comparison the run path applies before sending a request.
  const child = branched.conversationRevisions.at(-1)!;
  const prepared = prepareProjectRevisionRun(branched, child);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  assert.equal(sameConversationMessages(fromRunState, prepared.messages), true);
});

test("branches with the run overrides the branched messages were produced with", () => {
  const validated = templateBranchProject();
  const runOverrides = { "template-use_pair": { topic: "overridden" } };
  const overridden = projectDraft(validated, runOverrides).messages;
  assert.equal(
    overridden[0]?.content[0]?.type === "text" &&
      overridden[0].content[0].text,
    "System overridden",
  );

  // Without the overrides the parent resolves to the saved text and the
  // transcript reads as edited template output.
  assert.throws(
    () =>
      createBranchRevision(validated, {
        conversationId: validated.conversations[0]!.id,
        parentRevisionId: validated.conversationRevisions[0]!.id,
        messages: overridden,
      }),
    /generated text cannot be edited/,
  );

  const branched = createBranchRevision(validated, {
    conversationId: validated.conversations[0]!.id,
    parentRevisionId: validated.conversationRevisions[0]!.id,
    messages: overridden,
    runOverrides,
    idSuffix: "child",
    createdAt: "2026-07-26T12:01:00.000Z",
  });
  assert.deepEqual(branched.conversationRevisions.at(-1)?.items, [
    validated.conversationRevisions[0]!.items[0],
  ]);
});

test("previews a pending branch as authored items", () => {
  const validated = templateBranchProject();
  const resolved = projectDraft(validated).messages;
  const assistant = {
    id: "message_assistant" as const,
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "Answer" }],
  };
  const revision = validated.conversationRevisions[0]!;

  assert.deepEqual(
    authoredItemsForMessages(validated, revision, [...resolved, assistant]),
    [revision.items[0], { kind: "message", message: assistant }],
  );

  // Truncating inside the message set is what the composer must not render as
  // a use; the caller falls back to literal messages when this throws.
  assert.throws(
    () => authoredItemsForMessages(validated, revision, [resolved[0]!]),
    /template use is atomic/,
  );
});

test("explains that a secret-like variable can never be filled", () => {
  let project = createProjectFile({
    name: "Secret template",
    request,
    idSuffix: "secret",
    createdAt: "2026-07-26T12:00:00.000Z",
  });
  project = createPromptTemplate(project, {
    name: "Leaky",
    messages: [{ role: "user", content: "Key is {{api_key}}." }],
    idSuffix: "leaky",
    revisionIdSuffix: "leaky-1",
    createdAt: "2026-07-26T12:00:01.000Z",
  });
  project = insertPromptTemplateUse(project, {
    conversationRevisionId: project.defaults.conversationRevisionId,
    templateId: "template_leaky",
    idSuffix: "leaky",
    outputMessageIdSuffixes: ["leaky-out"],
  });
  const revision = project.conversationRevisions.find(
    ({ id }) => id === project.defaults.conversationRevisionId,
  )!;
  const [diagnostic] = resolveProjectRevision(project, revision).diagnostics;
  assert.match(diagnostic!.diagnostic.message, /secret-like/);
  assert.match(diagnostic!.diagnostic.message, /Rename it/);
  assert.equal(prepareProjectRevisionRun(project, revision).ok, false);
});

test("re-points a declared connection at a new endpoint", () => {
  const project = createProjectFile({
    name: "Moved project",
    request,
    idSuffix: "moved",
    createdAt: "2026-07-30T12:00:00.000Z",
  });
  const requirement = project.connectionRequirements[0]!;
  assert.equal(requirement.endpoint, "https://api.example.com/v1");

  const updated = updateConnectionRequirementEndpoint(
    project,
    requirement.id,
    "  http://127.0.0.1:8080/v1  ",
  );

  assert.equal(updated.connectionRequirements[0]!.endpoint, "http://127.0.0.1:8080/v1");
  // Nothing else about the declaration moves with the endpoint.
  assert.equal(updated.connectionRequirements[0]!.name, requirement.name);
  assert.deepEqual(
    updated.connectionRequirements[0]!.capabilityOverrides,
    requirement.capabilityOverrides,
  );
  assert.equal(updated.projectId, project.projectId);
  // The original is untouched, and the result survives a round trip.
  assert.equal(project.connectionRequirements[0]!.endpoint, "https://api.example.com/v1");
  assert.deepEqual(parseProjectJson(serializeProjectFile(updated)), updated);
});

test("re-pointing to the endpoint already declared changes nothing", () => {
  const project = createProjectFile({
    name: "Unmoved project",
    request,
    idSuffix: "unmoved",
    createdAt: "2026-07-30T12:00:00.000Z",
  });
  assert.equal(
    updateConnectionRequirementEndpoint(
      project,
      project.connectionRequirements[0]!.id,
      "https://api.example.com/v1",
    ),
    project,
  );
});

test("re-pointing refuses an endpoint the project could never carry", () => {
  const project = createProjectFile({
    name: "Refused project",
    request,
    idSuffix: "refused",
    createdAt: "2026-07-30T12:00:00.000Z",
  });
  const requirementId = project.connectionRequirements[0]!.id;

  // The value arrives from a profile field the user typed into, so the rules
  // that guard a project on load have to hold on the way in too.
  assert.throws(
    () =>
      updateConnectionRequirementEndpoint(
        project,
        requirementId,
        "https://example.com/v1?api_key=secret",
      ),
    ProjectValidationError,
  );
  assert.throws(
    () =>
      updateConnectionRequirementEndpoint(
        project,
        requirementId,
        "https://user:pass@example.com/v1",
      ),
    ProjectValidationError,
  );
  assert.throws(
    () => updateConnectionRequirementEndpoint(project, requirementId, "ftp://example.com/v1"),
    ProjectValidationError,
  );
  assert.throws(
    () => updateConnectionRequirementEndpoint(project, requirementId, "not a url"),
    ProjectValidationError,
  );
});

test("re-pointing an unknown connection is refused rather than ignored", () => {
  const project = createProjectFile({
    name: "Unknown connection",
    request,
    idSuffix: "unknown",
    createdAt: "2026-07-30T12:00:00.000Z",
  });
  assert.throws(
    () =>
      updateConnectionRequirementEndpoint(
        project,
        "connection_missing",
        "http://127.0.0.1:8080/v1",
      ),
    ProjectValidationError,
  );
});
