import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createFilePromptCandidate, importFilePromptCandidates } from "../../../packages/core/src/file-prompt-import.ts";
import {
  createProjectFile,
  insertPromptTemplateUse,
  parseProjectFile,
} from "../../../packages/core/src/project.ts";
import type { ProjectFile } from "../../../packages/core/src/project.ts";
import type { PromptTemplateId } from "../../../packages/core/src/run-kernel/types.ts";
import { linkFilePrompt } from "../../../packages/core/src/source-roots.ts";

export const LINKED_ROOT = "prompts";
export const LINKED_PATH = "flows/agent.md";
export const LINKED_TEXT = "Tell me about {{ $json.topic }}.";

/**
 * The headless fixture's suite, but its one template use is a prompt imported
 * from `flows/agent.md` and linked to the `prompts` source root. The file's
 * `{{ $json.topic }}` projects to `{{topic}}`, which the suite binds per case.
 */
export async function linkedPromptProject(options: {
  endpoint: string;
  text?: string;
  topics?: string[];
}): Promise<{ project: ProjectFile; templateId: PromptTemplateId }> {
  const base = createProjectFile({
    name: "Linked prompt fixture",
    idSuffix: "linked",
    createdAt: "2026-10-01T12:00:00.000Z",
    request: {
      provider: "openai-compatible",
      endpoint: options.endpoint,
      model: "buffered-test-model",
      messages: [{ role: "system", content: "Answer briefly." }],
    },
  });
  const candidate = await createFilePromptCandidate({
    filename: "agent.md",
    text: options.text ?? LINKED_TEXT,
    role: "user",
    plainText: false,
  });
  const imported = await importFilePromptCandidates(base, [candidate]);
  const templateId = imported.templateIds[0]!;
  let project = linkFilePrompt(imported.project, templateId, { rootName: LINKED_ROOT, path: LINKED_PATH });
  const revisionId = project.defaults.conversationRevisionId;
  project = insertPromptTemplateUse(project, {
    conversationRevisionId: revisionId,
    templateId,
    itemIndex: 1,
    idSuffix: "agent-use",
    outputMessageIdSuffixes: ["agent-output"],
  });
  const topics = options.topics ?? ["addition"];
  return {
    templateId,
    project: parseProjectFile({
      ...project,
      evaluationSuites: [{
        id: "evaluation-suite_linked",
        name: "Linked",
        input: { kind: "conversation-revision", conversationRevisionId: revisionId },
        execution: {
          target: { ...project.defaults.target },
          responseMode: "buffered",
          options: {},
          repetitions: 1,
          toolIds: [],
        },
        variants: [{ id: "evaluation-variant_default", name: "Default", overrides: {} }],
        inputBindings: [{
          id: "evaluation-input_topic",
          name: "Topic",
          target: { kind: "template-variable", templateUseId: "template-use_agent-use", variableName: "topic" },
        }],
        cases: topics.map((topic, index) => ({
          id: `evaluation-case_${index + 1}`,
          name: `Topic ${index + 1}`,
          values: { "evaluation-input_topic": topic },
          checks: [{ checkId: `check_${index + 1}`, kind: "contains", value: "2 + 2 = 4" }],
        })),
      }],
    }),
  };
}

/** A source folder holding `files`, keyed by path relative to it. */
export async function writeSourceRoot(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "inference-lens-source-root-"));
  for (const [relative, text] of Object.entries(files)) {
    const target = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text);
  }
  return root;
}
