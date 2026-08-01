import assert from "node:assert/strict";
import test from "node:test";

import {
  computeExternalPromptSourceDigest,
  createExternalPromptCandidate,
  parseExternalPromptCandidate,
} from "../packages/core/src/external-prompt-import.ts";
import type {
  ExternalPromptCandidateEvidence,
} from "../packages/core/src/external-prompt-import.ts";
import {
  canImportExternalPromptAsTemplate,
  importExternalPromptCandidate,
  importExternalPromptTemplateCandidate,
  projectExternalPromptTemplate,
} from "../packages/core/src/external-prompt-project.ts";
import {
  appendPromptTemplateRevision,
  createProjectFile,
  parseProjectFile,
  parseProjectJson,
  projectDraft,
  removePromptTemplateRevision,
  removePromptTemplateUse,
  serializeProjectFile,
  updateProjectDraft,
} from "../packages/core/src/project.ts";

const importedAt = "2026-07-28T18:00:00.000Z";

function candidateEvidence(
  overrides: Partial<ExternalPromptCandidateEvidence> = {},
): ExternalPromptCandidateEvidence {
  return {
    source: {
      adapter: "synthetic-fixture",
      resource: {
        kind: "workflow",
        id: "workflow-17",
        name: "Fixture workflow",
      },
      execution: {
        id: "execution-23",
        executedAt: "2026-07-28T17:55:00.000Z",
      },
      version: "1.0",
    },
    invocation: {
      id: "node-5",
      name: "Fixture prompt",
      type: "fixture.prompt",
      version: "1",
      runIndex: 0,
      itemIndex: 0,
    },
    authored: [
      {
        path: "parameters.prompt",
        role: "user",
        syntax: "external-expression",
        text: "={{ customer_prompt }}",
      },
    ],
    resolved: {
      messages: [{ role: "user", content: "Explain deterministic imports." }],
      model: "fixture-model",
      options: { temperature: 0 },
    },
    bindings: [
      {
        authoredPath: "parameters.prompt",
        expression: "={{ customer_prompt }}",
        source: { kind: "whole-field" },
        resolvedValue: "Explain deterministic imports.",
        status: "resolved",
        valueEvidence: {
          kind: "saved-parameter-value",
          path: "execution.prompt",
        },
      },
    ],
    fidelity: "execution-reconstructed",
    warnings: [
      {
        code: "reconstructed-input",
        severity: "info",
        message: "The saved execution contains reconstructed model input.",
      },
    ],
    ...overrides,
  };
}

function project() {
  return createProjectFile({
    name: "Import target",
    request: {
      provider: "openai-compatible",
      endpoint: "https://api.example.test/v1",
      model: "local-model",
      messages: [{ role: "user", content: "Existing draft" }],
    },
    idSuffix: "external-import",
    createdAt: "2026-07-28T17:00:00.000Z",
  });
}

test("computes a deterministic digest from source evidence, not warnings", async () => {
  const first = candidateEvidence();
  const reordered = candidateEvidence({
    resolved: {
      messages: [{ content: "Explain deterministic imports.", role: "user" }],
      options: { temperature: 0 },
      model: "fixture-model",
    },
    warnings: [],
  });

  assert.equal(
    await computeExternalPromptSourceDigest(first),
    await computeExternalPromptSourceDigest(reordered),
  );
  const candidate = await createExternalPromptCandidate(first);
  assert.match(candidate.sourceDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(parseExternalPromptCandidate(candidate), candidate);
});

test("validates fidelity, binding evidence, and UTF-16 source spans", async () => {
  await assert.rejects(
    () =>
      createExternalPromptCandidate(
        candidateEvidence({ fidelity: "authored-only" }),
      ),
    /Authored-only candidates cannot claim a resolved snapshot/,
  );
  await assert.rejects(
    () =>
      createExternalPromptCandidate(
        candidateEvidence({
          bindings: [
            {
              authoredPath: "parameters.prompt",
              expression: "wrong",
              source: {
                kind: "expression-span",
                startOffset: 1,
                endOffset: 5,
              },
              resolvedValue: "value",
              status: "resolved",
              valueEvidence: { kind: "user-supplied" },
            },
          ],
        }),
      ),
    /Expression text does not match its UTF-16 authored span/,
  );
  await assert.rejects(
    () =>
      createExternalPromptCandidate(
        candidateEvidence({
          bindings: [
            {
              authoredPath: "parameters.prompt",
              expression: "={{ customer_prompt }}",
              source: { kind: "whole-field" },
              status: "resolved",
            },
          ],
        }),
      ),
    /Resolved bindings require both a resolved value and value evidence/,
  );
  await assert.rejects(
    () =>
      createExternalPromptCandidate(
        candidateEvidence({
          source: {
            ...candidateEvidence().source,
            resource: {
              kind: "workflow",
              id: "https://private.example.test/workflow/17",
            },
          },
        }),
      ),
    /must not contain an instance URL/,
  );
  await assert.rejects(
    () =>
      createExternalPromptCandidate(
        candidateEvidence({
          resolved: {
            messages: [{ role: "user", content: "Prompt" }],
            options: {
              providerOptions: {
                nested: [{ api_key: "must-not-persist" }],
              },
            },
          },
        }),
      ),
    /Secret-bearing fields are not portable import evidence/,
  );
});

test("projects resolved snapshots into literal messages with durable receipts", async () => {
  const base = project();
  const originalRevisionId = base.defaults.conversationRevisionId;
  const candidate = await createExternalPromptCandidate(candidateEvidence());
  const imported = await importExternalPromptCandidate(base, candidate, {
    importedAt,
    importerVersion: 1,
  });

  assert.equal(base.externalImports.length, 0);
  assert.equal(imported.project.schemaVersion, 6);
  assert.equal(imported.project.externalImports.length, 1);
  assert.equal(
    imported.project.externalImports[0]?.sourceDigest,
    candidate.sourceDigest,
  );
  assert.equal(
    imported.project.externalImports[0]?.authored[0]?.text,
    "={{ customer_prompt }}",
  );
  assert.deepEqual(imported.project.externalImports[0]?.projection, {
    kind: "literal-messages",
  });
  const revision = imported.project.conversationRevisions.at(-1);
  assert.equal(revision?.parentRevisionId, originalRevisionId);
  assert.equal(revision?.items[0]?.kind, "message");
  assert.equal(
    revision?.items[0]?.kind === "message"
      ? revision.items[0].externalImportId
      : undefined,
    imported.externalImportId,
  );
  assert.deepEqual(projectDraft(imported.project).messages, [
    {
      id: imported.messageIds[0],
      role: "user",
      content: [{ type: "text", text: "Explain deterministic imports." }],
    },
  ]);
  assert.equal(projectDraft(imported.project).model, "local-model");

  const serialized = serializeProjectFile(imported.project);
  assert.equal(
    serializeProjectFile(parseProjectJson(serialized)),
    serialized,
  );
  assert.doesNotMatch(
    serialized,
    new RegExp("api[_-]?key|https?://.*workflow-17", "i"),
  );
});

test("uses stable digest IDs with collision-safe repeat-import suffixes", async () => {
  const candidate = await createExternalPromptCandidate(candidateEvidence());
  const first = await importExternalPromptCandidate(project(), candidate, {
    importedAt,
  });
  const second = await importExternalPromptCandidate(first.project, candidate, {
    importedAt: "2026-07-28T18:05:00.000Z",
  });

  assert.equal(
    first.externalImportId,
    `external-import_${candidate.sourceDigest.slice(0, 16)}`,
  );
  assert.equal(
    second.externalImportId,
    `external-import_${candidate.sourceDigest.slice(0, 16)}-2`,
  );
  assert.equal(second.project.externalImports.length, 2);
  assert.equal(
    second.project.externalImports[0]?.sourceDigest,
    second.project.externalImports[1]?.sourceDigest,
  );
});

test("keeps receipt lineage while imported messages are edited and prunes it when removed", async () => {
  const candidate = await createExternalPromptCandidate(candidateEvidence());
  const imported = await importExternalPromptCandidate(project(), candidate, {
    importedAt,
  });
  const draft = projectDraft(imported.project);
  const edited = updateProjectDraft(imported.project, {
    messages: [
      {
        ...draft.messages[0]!,
        content: [{ type: "text", text: "Edited imported prompt" }],
      },
    ],
    model: draft.model,
    temperature: draft.temperature,
    tools: draft.tools,
    toolMocks: draft.toolMocks,
    enabledToolIds: draft.enabledToolIds,
  });
  const editedItem = edited.conversationRevisions.at(-1)?.items[0];
  assert.equal(
    editedItem?.kind === "message" ? editedItem.externalImportId : undefined,
    imported.externalImportId,
  );
  assert.equal(edited.externalImports.length, 1);

  const removed = updateProjectDraft(edited, {
    messages: [],
    model: draft.model,
    temperature: draft.temperature,
    tools: draft.tools,
    toolMocks: draft.toolMocks,
    enabledToolIds: draft.enabledToolIds,
  });
  assert.equal(removed.externalImports.length, 0);
});

test("rejects tampered candidates and dangling or orphaned receipts", async () => {
  const candidate = await createExternalPromptCandidate(candidateEvidence());
  await assert.rejects(
    () =>
      importExternalPromptCandidate(project(), {
        ...candidate,
        resolved: {
          ...candidate.resolved!,
          messages: [{ role: "user", content: "Tampered" }],
        },
      }),
    /digest does not match/,
  );

  const imported = await importExternalPromptCandidate(project(), candidate, {
    importedAt,
  });
  assert.throws(
    () =>
      parseProjectFile({
        ...imported.project,
        conversationRevisions: imported.project.conversationRevisions.map(
          (revision) => ({
            ...revision,
            items: revision.items.map((item) =>
              item.kind === "message" && item.externalImportId
                ? { ...item, externalImportId: "external-import_missing" }
                : item,
            ),
          }),
        ),
      }),
    /unknown external import/,
  );
  assert.throws(
    () =>
      parseProjectFile({
        ...imported.project,
        conversationRevisions: imported.project.conversationRevisions.map(
          (revision) => ({
            ...revision,
            items: revision.items.map((item) => {
              if (item.kind !== "message") return item;
              return { kind: "message" as const, message: item.message };
            }),
          }),
        ),
      }),
    /must be referenced by imported project content/,
  );
});

function expressionSpan(text: string, expression: string, from = 0) {
  const startOffset = text.indexOf(expression, from);
  assert.notEqual(startOffset, -1);
  return {
    kind: "expression-span" as const,
    startOffset,
    endOffset: startOffset + expression.length,
  };
}

test("projects authored expressions into deterministic native variables", async () => {
  const text =
    "=Explain {{ $json.topic }} / {{ $json.topic }} / " +
    "{{ $json['topic'] }} / {{ [$json.first].join(',') }}";
  const first = "{{ $json.topic }}";
  const repeatedStart = text.indexOf(first) + first.length;
  const bracket = "{{ $json['topic'] }}";
  const compound = "{{ [$json.first].join(',') }}";
  const candidate = await createExternalPromptCandidate(
    candidateEvidence({
      authored: [
        {
          path: "parameters.text",
          role: "user",
          syntax: "external-expression",
          text,
          contentSpan: { startOffset: 1, endOffset: text.length },
        },
      ],
      resolved: undefined,
      fidelity: "authored-only",
      bindings: [
        {
          authoredPath: "parameters.text",
          expression: first,
          source: expressionSpan(text, first),
          status: "missing",
        },
        {
          authoredPath: "parameters.text",
          expression: first,
          source: expressionSpan(text, first, repeatedStart),
          status: "missing",
        },
        {
          authoredPath: "parameters.text",
          expression: bracket,
          source: expressionSpan(text, bracket),
          status: "missing",
        },
        {
          authoredPath: "parameters.text",
          expression: compound,
          source: expressionSpan(text, compound),
          status: "missing",
        },
      ],
    }),
  );

  assert.equal(canImportExternalPromptAsTemplate(candidate), true);
  assert.deepEqual(projectExternalPromptTemplate(candidate), {
    name: "Fixture workflow — Fixture prompt",
    messages: [{
      role: "user",
      content: "Explain {{topic}} / {{topic}} / {{topic_2}} / {{expression_1}}",
    }],
    values: {},
    variables: [
      {
        bindingIndex: 0,
        authoredPath: "parameters.text",
        expression: first,
        variableName: "topic",
      },
      {
        bindingIndex: 1,
        authoredPath: "parameters.text",
        expression: first,
        variableName: "topic",
      },
      {
        bindingIndex: 2,
        authoredPath: "parameters.text",
        expression: bracket,
        variableName: "topic_2",
      },
      {
        bindingIndex: 3,
        authoredPath: "parameters.text",
        expression: compound,
        variableName: "expression_1",
      },
    ],
  });

  const imported = await importExternalPromptTemplateCandidate(
    project(),
    candidate,
    { importedAt },
  );
  const template = imported.project.promptTemplates.at(-1)!;
  const revision = template.revisions[0]!;
  assert.equal(revision.externalImportId, imported.externalImportId);
  assert.equal(template.recommendedTarget, undefined);
  assert.equal(revision.messages[0].role, "user");
  assert.deepEqual(
    imported.project.externalImports.at(-1)?.projection,
    {
      kind: "prompt-template",
      templateId: imported.templateId,
      templateRevisionId: imported.templateRevisionId,
      variables: projectExternalPromptTemplate(candidate).variables,
    },
  );
  assert.equal(
    imported.project.conversationRevisions.at(-1)?.items[0]?.kind,
    "template-use",
  );
  assert.throws(
    () =>
      parseProjectFile({
        ...imported.project,
        promptTemplates: imported.project.promptTemplates.map((item) =>
          item.id === imported.templateId
            ? {
                ...item,
                revisions: item.revisions.map((itemRevision) =>
                  itemRevision.id === imported.templateRevisionId
                    ? {
                        ...itemRevision,
                        messages: [{ role: "user" as const, content: "Tampered {{topic}}" }],
                      }
                    : itemRevision,
                ),
              }
            : item,
        ),
      }),
    /does not reproduce its anchored revision/,
  );
  assert.deepEqual(projectDraft(imported.project).templateDiagnostics.map(
    ({ diagnostic }) => diagnostic.code,
  ), [
    "missing-template-variable",
    "missing-template-variable",
    "missing-template-variable",
  ]);

  const withoutUse = removePromptTemplateUse(
    imported.project,
    imported.conversationRevisionId,
    imported.templateUseId,
  );
  assert.equal(withoutUse.externalImports.length, 1);
  const revised = appendPromptTemplateRevision(withoutUse, {
    templateId: imported.templateId,
    messages: [{ role: "user", content: "Edited {{topic}}" }],
    idSuffix: "edited-import",
    createdAt: "2026-07-28T18:10:00.000Z",
  });
  assert.equal(
    revised.promptTemplates.at(-1)?.revisions.at(-1)?.externalImportId,
    undefined,
  );
  const removedImportedRevision = removePromptTemplateRevision(
    revised,
    imported.templateId,
    imported.templateRevisionId,
  );
  assert.equal(removedImportedRevision.externalImports.length, 0);
});

test("uses the last expression path segment when naming native variables", async () => {
  const text = "Classify {{ $('Webhook').item.json.customer.email }}";
  const expression = "{{ $('Webhook').item.json.customer.email }}";
  const candidate = await createExternalPromptCandidate(
    candidateEvidence({
      authored: [{
        path: "parameters.text",
        role: "user",
        syntax: "external-expression",
        text,
      }],
      resolved: undefined,
      fidelity: "authored-only",
      bindings: [{
        authoredPath: "parameters.text",
        expression,
        source: expressionSpan(text, expression),
        status: "missing",
      }],
    }),
  );

  assert.equal(projectExternalPromptTemplate(candidate).variables[0]?.variableName, "email");
});

test("uses a captured string only when one complete expression is attributable", async () => {
  const candidate = await createExternalPromptCandidate(
    candidateEvidence({
      authored: [
        {
          path: "parameters.text",
          role: "user",
          syntax: "external-expression",
          text: "={{ $json.topic }}",
          contentSpan: { startOffset: 1, endOffset: 18 },
        },
      ],
      bindings: [
        {
          authoredPath: "parameters.text",
          expression: "{{ $json.topic }}",
          source: {
            kind: "expression-span",
            startOffset: 1,
            endOffset: 18,
          },
          resolvedValue: "Captured topic",
          status: "resolved",
          valueEvidence: {
            kind: "saved-parameter-value",
            path: "execution.prompt",
          },
        },
      ],
    }),
  );
  const projection = projectExternalPromptTemplate(candidate);
  assert.deepEqual(projection.messages, [{ role: "user", content: "{{topic}}" }]);
  assert.deepEqual(projection.values, { topic: "Captured topic" });
});

test("the digest is stable across a parse round trip", async () => {
  // Several field schemas trim their input, so a digest taken over raw evidence
  // would not survive the parse every import path performs before verifying it.
  const evidence = candidateEvidence({
    source: {
      adapter: "synthetic-fixture",
      resource: {
        kind: "workflow",
        id: "workflow-17",
        name: "Fixture workflow ",
      },
      execution: { id: "execution-23" },
    },
    invocation: {
      id: "node-5",
      name: " Fixture prompt",
      type: "fixture.prompt",
    },
  });

  const candidate = await createExternalPromptCandidate(evidence);
  assert.equal(candidate.source.resource.name, "Fixture workflow");
  assert.equal(candidate.invocation.name, "Fixture prompt");
  assert.equal(
    await computeExternalPromptSourceDigest(
      parseExternalPromptCandidate(candidate),
    ),
    candidate.sourceDigest,
  );
});

test("names carrying incidental whitespace still import", async () => {
  const candidate = await createExternalPromptCandidate(
    candidateEvidence({
      source: {
        adapter: "synthetic-fixture",
        resource: {
          kind: "workflow",
          id: "workflow-17",
          name: "Fixture workflow ",
        },
        execution: { id: "execution-23" },
      },
    }),
  );

  const imported = await importExternalPromptCandidate(project(), candidate, {
    importedAt,
  });
  assert.equal(
    imported.project.externalImports.at(-1)?.source.resource.name,
    "Fixture workflow",
  );

  const asTemplate = await importExternalPromptTemplateCandidate(
    project(),
    candidate,
    { importedAt },
  );
  assert.equal(asTemplate.project.promptTemplates.length, 1);
  // The source model pairs an external provider's model with a connection this
  // project owns, so the importer never asserts it unless asked.
  assert.equal(
    asTemplate.project.promptTemplates[0]?.recommendedTarget,
    undefined,
  );

  const recommended = await importExternalPromptTemplateCandidate(
    project(),
    candidate,
    { importedAt, recommendModel: true },
  );
  assert.deepEqual(recommended.project.promptTemplates[0]?.recommendedTarget, {
    connectionRequirementId:
      recommended.project.defaults.target.connectionRequirementId,
    model: "fixture-model",
  });
  assert.deepEqual(
    recommended.project.promptTemplates[0]?.revisions,
    asTemplate.project.promptTemplates[0]?.revisions,
  );
});
