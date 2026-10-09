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

/** Writes a project folder the way the app lays one out, minus any history. */
export async function writeHeadlessProjectFolder(project: ProjectFile): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "inference-lens-headless-"));
  const directory = path.join(root, "fixture.inference-lens");
  await mkdir(directory);
  await writeFile(path.join(directory, "project.json"), serializeProjectFile(project));
  return directory;
}
