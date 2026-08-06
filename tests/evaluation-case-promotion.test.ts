import assert from "node:assert/strict";
import test from "node:test";

import { evaluationCasePromotionCompatibility, promoteTraceToEvaluationCase } from "../packages/core/src/evaluation-case-promotion.ts";
import { createEntityId } from "../packages/core/src/run-kernel/types.ts";
import type { ProjectFile } from "../packages/core/src/project.ts";
import type { RunTrace } from "../packages/core/src/run-kernel/types.ts";
import { emptyEvaluationCaseSources, parseEvaluationCaseSourcesJson, serializeEvaluationCaseSources, upsertEvaluationCaseSource } from "../packages/core/src/evaluation-case-sources.ts";

const suiteId = createEntityId("evaluation-suite", "promotion");
const revisionId = createEntityId("revision", "promotion");
const useId = createEntityId("template-use", "promotion");
const bindingId = createEntityId("evaluation-input", "topic");

function project(): ProjectFile {
  return {
    schemaVersion: 10, projectId: createEntityId("project", "promotion"), name: "Promotion",
    defaults: { conversationRevisionId: revisionId, target: { connectionRequirementId: createEntityId("connection", "local"), model: "fixture" }, options: {}, enabledToolIds: [] },
    connectionRequirements: [{ id: createEntityId("connection", "local"), name: "Local", provider: "openai-compatible", protocol: "openai-compatible-chat-completions", endpoint: "http://localhost" }],
    conversations: [{ id: createEntityId("conversation", "promotion"), name: "Promotion" }],
    conversationRevisions: [{ id: revisionId, conversationId: createEntityId("conversation", "promotion"), createdAt: "2026-08-06T12:00:00.000Z", items: [{ kind: "template-use", use: { id: useId, templateId: createEntityId("template", "prompt"), templateRevisionId: createEntityId("template-revision", "one"), values: {}, outputMessageIds: [createEntityId("message", "one")] } }] }],
    promptTemplates: [{ id: createEntityId("template", "prompt"), name: "Prompt", currentRevisionId: createEntityId("template-revision", "one"), revisions: [{ id: createEntityId("template-revision", "one"), createdAt: "2026-08-06T12:00:00.000Z", messages: [{ role: "user", content: "{{topic}}" }], variableDefaults: {} }] }], externalImports: [], tools: [], toolMocks: [], evaluationSuites: [{
      id: suiteId, name: "Incidents", input: { kind: "conversation-revision", conversationRevisionId: revisionId },
      execution: { target: { connectionRequirementId: createEntityId("connection", "local"), model: "fixture" }, responseMode: "buffered", options: {}, repetitions: 1, toolIds: [] },
      variants: [{ id: createEntityId("evaluation-variant", "default"), name: "Default", overrides: {} }],
      inputBindings: [{ id: bindingId, name: "Topic", target: { kind: "template-variable", templateUseId: useId, variableName: "topic" } }], cases: [],
    }],
  } as ProjectFile;
}

function trace(overrides: Partial<RunTrace["input"]> = {}): Pick<RunTrace, "input"> {
  return { input: {
    runId: createEntityId("run", "promotion"), conversationId: createEntityId("conversation", "promotion"), conversationRevisionId: revisionId,
    target: { profileId: createEntityId("profile", "local"), protocol: "mock", endpoint: "http://localhost", model: "fixture", capabilities: { chatCompletions: true, responsesApi: false, streaming: true, modelDiscovery: false, tools: false, parallelToolCalls: false, structuredOutput: false, vision: false, embeddings: false } }, messages: [], responseMode: "buffered", options: {}, tools: [], resolvedAt: "2026-08-06T12:00:00.000Z",
    templateResolutions: [{ templateUseId: useId, templateId: createEntityId("template", "prompt"), templateRevisionId: createEntityId("template-revision", "one"), templateName: "Prompt", messages: [{ role: "user", content: "topic" }], variableDefaults: {}, values: { topic: "database migrations" }, outputMessageIds: [createEntityId("message", "one")] }],
    ...overrides,
  } };
}

test("promotes exact resolved trace values into an ordinary empty-check case", () => {
  const promoted = promoteTraceToEvaluationCase(project(), { suiteId, trace: trace(), name: "Incident", caseIdSuffix: "incident" });
  const evaluationCase = promoted.project.evaluationSuites[0]!.cases[0]!;
  assert.equal(evaluationCase.name, "Incident");
  assert.deepEqual(evaluationCase.values, { [bindingId]: "database migrations" });
  assert.deepEqual(evaluationCase.checks, []);
  assert.equal(evaluationCase.referenceAnswer, undefined);
});

test("refuses a revision mismatch and never infers from rendered messages", () => {
  const incompatible = evaluationCasePromotionCompatibility(project().evaluationSuites[0]!, trace({ conversationRevisionId: createEntityId("revision", "other") }));
  assert.deepEqual(incompatible, { ok: false, incompatibilities: [{ kind: "revision-mismatch", expectedRevisionId: revisionId, traceRevisionId: createEntityId("revision", "other") }] });
  assert.throws(() => promoteTraceToEvaluationCase(project(), { suiteId, trace: trace({ templateResolutions: [] }), name: "Lost" }), /not compatible/);
});

test("case source annotations are strict and replace only the case link", () => {
  const source = { suiteId, caseId: createEntityId("evaluation-case", "incident"), runId: createEntityId("run", "promotion"), capturedAt: "2026-08-06T12:00:00.000Z" };
  const saved = upsertEvaluationCaseSource(emptyEvaluationCaseSources(), source);
  assert.deepEqual(parseEvaluationCaseSourcesJson(serializeEvaluationCaseSources(saved)), saved);
  assert.throws(() => parseEvaluationCaseSourcesJson('{"schemaVersion":1,"sources":[{}]}'), /Invalid evaluation case sources/);
});
