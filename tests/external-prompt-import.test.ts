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
  importExternalPromptCandidate,
} from "../packages/core/src/external-prompt-project.ts";
import {
  createProjectFile,
  parseProjectFile,
  parseProjectJson,
  projectDraft,
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
  assert.equal(imported.project.schemaVersion, 4);
  assert.equal(imported.project.externalImports.length, 1);
  assert.equal(
    imported.project.externalImports[0]?.sourceDigest,
    candidate.sourceDigest,
  );
  assert.equal(
    imported.project.externalImports[0]?.authored[0]?.text,
    "={{ customer_prompt }}",
  );
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
    /must be referenced by a message item/,
  );
});
