import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createProjectFile,
  createPromptTemplate,
  insertPromptTemplateUse,
  parseProjectFile,
  serializeProjectFile,
} from "../../../packages/core/src/project.ts";
import type { ProjectFile } from "../../../packages/core/src/project.ts";
import type { CheckDefinition } from "../../../packages/core/src/checks.ts";
import type { DecisionInput } from "../../../packages/core/src/decision.ts";
import { updateDecisionRequestDraft } from "../../../packages/core/src/decision-request.ts";
import type { ToolDefinition } from "../../../packages/core/src/run-kernel/types.ts";

export const HEADLESS_CONNECTION_ID = "connection_headless-default";

/**
 * A project with one buffered suite against `scripts/buffered-openai-provider.mjs`,
 * whose `buffered-test-model` always answers "Buffered fixture response: 2 + 2 = 4."
 * — so which cases pass is known before the run.
 */
export function headlessProject(options: {
  endpoint: string;
  cases?: Array<{ id: string; name: string; topic: string; checks: CheckDefinition[] }>;
  repetitions?: number;
  model?: string;
}): ProjectFile {
  let project = createProjectFile({
    name: "Headless fixture",
    idSuffix: "headless",
    createdAt: "2026-10-01T12:00:00.000Z",
    request: {
      provider: "openai-compatible",
      endpoint: options.endpoint,
      model: options.model ?? "buffered-test-model",
      messages: [{ role: "system", content: "Answer briefly." }],
    },
  });
  project = createPromptTemplate(project, {
    name: "Question",
    messages: [{ role: "user", content: "Tell me about {{topic}}." }],
    variableDefaults: { topic: "arithmetic" },
    idSuffix: "question",
    revisionIdSuffix: "question-1",
    createdAt: "2026-10-01T12:00:01.000Z",
  });
  const revisionId = project.defaults.conversationRevisionId;
  project = insertPromptTemplateUse(project, {
    conversationRevisionId: revisionId,
    templateId: "template_question",
    itemIndex: 1,
    idSuffix: "question-use",
    outputMessageIdSuffixes: ["question-output"],
  });
  const cases = options.cases ?? [
    {
      id: "evaluation-case_sum",
      name: "States the sum",
      topic: "addition",
      checks: [{ checkId: "check_sum", kind: "contains", value: "2 + 2 = 4" }],
    },
  ];
  return parseProjectFile({
    ...project,
    evaluationSuites: [{
      id: "evaluation-suite_arithmetic",
      name: "Arithmetic",
      input: { kind: "conversation-revision", conversationRevisionId: revisionId },
      execution: {
        target: { ...project.defaults.target },
        responseMode: "buffered",
        options: {},
        repetitions: options.repetitions ?? 1,
        toolIds: [],
      },
      variants: [{ id: "evaluation-variant_default", name: "Default", overrides: {} }],
      inputBindings: [{
        id: "evaluation-input_topic",
        name: "Topic",
        target: { kind: "template-variable", templateUseId: "template-use_question-use", variableName: "topic" },
      }],
      cases: cases.map(({ id, name, topic, checks }) => ({
        id,
        name,
        values: { "evaluation-input_topic": topic },
        checks,
      })),
    }],
  });
}

/** A one-case suite that exposes `tool` and passes only if `expected` reaches the answer. */
export function headlessToolProject(endpoint: string, tool: ToolDefinition, expected: string, extra: Partial<ProjectFile> = {}) {
  const base = headlessProject({
    endpoint,
    cases: [{
      id: "evaluation-case_tool",
      name: "Uses the tool",
      topic: "the weather",
      checks: [{ checkId: "check_tool", kind: "contains", value: expected }],
    }],
  });
  return parseProjectFile({
    ...base,
    connectionRequirements: base.connectionRequirements.map((requirement) => ({
      ...requirement,
      capabilityOverrides: { ...requirement.capabilityOverrides, tools: true },
    })),
    tools: [tool],
    evaluationSuites: base.evaluationSuites.map((suite) => ({
      ...suite,
      execution: { ...suite.execution, toolIds: [tool.id] },
    })),
    ...extra,
  });
}

/** Writes a project folder the way the app lays one out, minus any history. */
export async function writeHeadlessProjectFolder(project: ProjectFile): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "inference-lens-headless-"));
  const directory = path.join(root, "fixture.inference-lens");
  await mkdir(directory);
  await writeFile(path.join(directory, "project.json"), serializeProjectFile(project));
  return directory;
}

/**
 * A project with one decision request asking the captured llama.cpp questions
 * and a decision suite on it, against `recordingDecisionProvider`. The capture
 * answers `intent` with billing and `severity` about 1.09, so the first case
 * passes and the second (`expectBug`) fails.
 */
export function headlessDecisionProject(options: {
  endpoint: string;
  questions: DecisionInput["questions"];
  model?: string;
  repetitions?: number;
  expectBug?: boolean;
}): ProjectFile {
  const base = createProjectFile({
    name: "Headless decisions",
    idSuffix: "headless",
    createdAt: "2026-10-01T12:00:00.000Z",
    request: {
      provider: "openai-compatible",
      endpoint: options.endpoint,
      model: "chat-model",
      messages: [{ role: "user", content: "Hello" }],
    },
  });
  const project = updateDecisionRequestDraft(base, {
    decision: { state: { ticket: "{{ticket}}", plan: "pro" }, questions: options.questions },
    values: { ticket: "Charged twice" },
    branch: false,
    idSuffix: "triage",
    createdAt: "2026-10-01T12:00:01.000Z",
  });
  return parseProjectFile({
    ...project,
    evaluationSuites: [{
      id: "evaluation-suite_triage",
      name: "Triage",
      input: { kind: "decision-request-revision", decisionRequestRevisionId: "decision-revision_triage" },
      execution: {
        target: { connectionRequirementId: HEADLESS_CONNECTION_ID, model: options.model ?? "local-decision", protocol: "systemone" },
        repetitions: options.repetitions ?? 1,
      },
      variants: [{ id: "evaluation-variant_default", name: "Default", overrides: {} }],
      inputBindings: [{ id: "evaluation-input_ticket", name: "ticket", target: { kind: "decision-variable", variableName: "ticket" } }],
      cases: [
        {
          id: "evaluation-case_billing",
          name: "Routes billing",
          values: { "evaluation-input_ticket": "I was charged twice." },
          checks: [
            { checkId: "check_billing", kind: "decision-choice", questionId: "intent", option: "billing" },
            { checkId: "check_major", kind: "decision-score-range", questionId: "severity", min: 1 },
          ],
        },
        ...(options.expectBug
          ? [{
            id: "evaluation-case_crash",
            name: "Routes a crash",
            values: { "evaluation-input_ticket": "The app crashes." },
            checks: [{ checkId: "check_bug", kind: "decision-choice", questionId: "intent", option: "bug" }],
          }]
          : []),
      ],
    }],
  } as unknown as ProjectFile);
}
