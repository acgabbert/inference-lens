import assert from "node:assert/strict";
import test from "node:test";

import {
  PROJECT_FILE_NAME,
  ProjectValidationError,
  appendPromptTemplateRevision,
  createBranchRevision,
  createProjectFile,
  createPromptTemplate,
  detachPromptTemplateUse,
  findPromptTemplateUsages,
  insertPromptTemplateUse,
  parseProjectFile,
  parseProjectJson,
  prepareProjectRevisionRun,
  projectDraft,
  removePromptTemplateRevision,
  removePromptTemplateUse,
  serializeProjectFile,
  setPromptTemplateCurrentRevision,
  updateProjectDraft,
  updatePromptTemplateUseToLatest,
  updatePromptTemplateUseValues,
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

test("creates a strict, portable Project v3 document", () => {
  const project = createProjectFile({
    name: "Example",
    request,
    idSuffix: "example",
    createdAt: "2026-07-24T12:00:00.000Z",
  });

  assert.equal(PROJECT_FILE_NAME, "trace-lens.project.json");
  assert.equal(project.schemaVersion, 3);
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
  assert.equal(JSON.parse(serializeProjectFile(project)).schemaVersion, 3);
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

test("migrates Project v2 messages to literal v3 authored items", () => {
  const current = createProjectFile({
    name: "Legacy",
    request,
    idSuffix: "legacy",
    createdAt: "2026-07-24T12:00:00.000Z",
  });
  const legacy = {
    ...current,
    schemaVersion: 2,
    conversationRevisions: current.conversationRevisions.map(
      ({ items, ...revision }) => ({
        ...revision,
        messages: items.map((item) => {
          assert.equal(item.kind, "message");
          if (item.kind !== "message") throw new Error("Unexpected template use.");
          return item.message;
        }),
      }),
    ),
  };

  const migrated = parseProjectFile(legacy);
  assert.equal(migrated.schemaVersion, 3);
  assert.deepEqual(
    migrated.conversationRevisions[0]?.items,
    current.conversationRevisions[0]?.items,
  );
  assert.equal(JSON.parse(serializeProjectFile(migrated)).schemaVersion, 3);
});

test("resolves pinned fragment and message-set uses with stable output IDs", () => {
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
          content: { kind: "fragment", text: "Explain {{topic}} to {{audience}}." },
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
          content: {
            kind: "messages",
            messages: [
              { role: "system", content: "Voice: {{voice}}" },
              { role: "user", content: "Question: {{question}}" },
            ],
          },
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
        fragmentRole: "user",
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
          content: {
            kind: "messages",
            messages: [
              { role: "user", content: "Second" },
              { role: "assistant", content: "Third" },
            ],
          },
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
    content: { kind: "fragment", text: "Explain {{topic}}." },
    variableDefaults: { topic: "branching" },
    idSuffix: "question",
    revisionIdSuffix: "question-1",
    createdAt: "2026-07-24T12:01:00.000Z",
  });
  const unchanged = appendPromptTemplateRevision(created, {
    templateId: "template_question",
    content: { kind: "fragment", text: "Explain {{topic}}." },
    variableDefaults: { topic: "branching" },
    idSuffix: "unused",
  });
  assert.equal(unchanged, created);

  const revised = appendPromptTemplateRevision(created, {
    templateId: "template_question",
    content: { kind: "fragment", text: "Summarize {{topic}}." },
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
      fragmentRole: "user",
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

test("inserts, updates, detaches, and removes template uses through core helpers", () => {
  const base = createProjectFile({
    name: "Template use helpers",
    request,
    idSuffix: "template-use-helpers",
    createdAt: "2026-07-24T12:00:00.000Z",
  });
  const created = createPromptTemplate(base, {
    name: "Reusable",
    content: {
      kind: "fragment",
      text: "{{kept}} {{obsolete}}",
    },
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
    fragmentRole: "user",
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
    values: { kept: "Still", obsolete: "Drop", added: "Now" },
  });
  const revised = appendPromptTemplateRevision(valuesUpdated, {
    templateId: "template_reusable",
    content: {
      kind: "messages",
      messages: [
        { role: "system", content: "{{kept}}" },
        { role: "user", content: "{{added}}" },
      ],
    },
    variableDefaults: {},
    idSuffix: "reusable-2",
    createdAt: "2026-07-24T12:02:00.000Z",
  });
  const latest = updatePromptTemplateUseToLatest(revised, {
    conversationRevisionId,
    templateUseId: "template-use_reusable",
    newOutputMessageIdSuffixes: ["reusable-2"],
  });
  const latestUse = findPromptTemplateUsages(
    latest,
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
  assert.equal(latestUse.fragmentRole, undefined);

  const detached = detachPromptTemplateUse(latest, {
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
    latest,
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
          content: { kind: "fragment", text: "Explain {{topic}}." },
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
        fragmentRole: "user",
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
          content: { kind: "fragment", text: "{{input}}" },
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
      fragmentRole: "user",
    },
  };
  assert.throws(() => parseProjectFile(project), /Secret values cannot be stored/);
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
          content: {
            kind: "messages",
            messages: [
              { role: "system", content: "System {{topic}}" },
              { role: "user", content: "User {{topic}}" },
            ],
          },
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
