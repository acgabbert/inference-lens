/**
 * What the pinned prompts contribute to the next run, derived from the
 * template workbench view: the resolved request preview and the facts run
 * readiness needs about them.
 */

import { buildChatCompletionsRequest } from "../../packages/core/src/openai-compatible.ts";
import type { ProjectFile } from "../../packages/core/src/project.ts";
import { createSingleTurnRunExecution } from "../../packages/core/src/run-kernel/index.ts";
import type {
  ConversationMessage,
  ToolDefinition,
} from "../../packages/core/src/run-kernel/index.ts";
import type { RichInferenceRequest } from "../../packages/core/src/types.ts";
import type { RunReadinessInput } from "../run-readiness.client.ts";
import type { ProjectTemplateWorkbenchView } from "./project-template-workbench.client.ts";

export type TemplateRequestPreview =
  | { body: unknown; messages: ConversationMessage[] }
  | { error: string };

/**
 * The provider request the pinned prompts resolve to, built the same way a
 * run builds it. Absent without a project revision or a resolution.
 */
export function templateRequestPreview(input: {
  project: ProjectFile | null;
  revision?: ProjectFile["conversationRevisions"][number];
  view: ProjectTemplateWorkbenchView;
  request: RichInferenceRequest;
  tools: ToolDefinition[];
}): TemplateRequestPreview | undefined {
  const { project, revision, view } = input;
  if (!project || !revision) return undefined;
  if (view.resolutionError) return { error: view.resolutionError };
  const resolution = view.resolution;
  if (!resolution) return undefined;
  try {
    const request = { ...input.request, messages: resolution.messages };
    const execution = createSingleTurnRunExecution(
      request,
      {
        conversationId: revision.conversationId,
        conversationRevisionId: revision.id,
      },
      "template-preview",
      "1970-01-01T00:00:00.000Z",
      input.tools,
      resolution.templateResolutions,
    );
    return {
      messages: resolution.messages,
      body: buildChatCompletionsRequest({
        runId: execution.runId,
        turnId: execution.turnId,
        exchangeId: execution.exchangeId,
        attempt: execution.attempt,
        input: execution.turnInput,
      }).body,
    };
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : "Could not build request preview.",
    };
  }
}

/** The template facts run readiness reports: resolution, missing values, targets. */
export function templateReadinessInputs(
  project: ProjectFile | null,
  view: ProjectTemplateWorkbenchView,
): Pick<RunReadinessInput, "templateResolutionError" | "templateIssues" | "templateTargets"> {
  return {
    ...(view.resolutionError ? { templateResolutionError: view.resolutionError } : {}),
    templateIssues:
      view.resolution?.diagnostics.map(({ templateUseId, diagnostic }) => ({
        templateUseId,
        ...(diagnostic.code === "missing-template-variable"
          ? { variableName: diagnostic.name }
          : {}),
      })) ?? [],
    templateTargets: view.composerItems.flatMap((item) => {
      if (item.kind !== "template-use") return [];
      const template = project?.promptTemplates.find(
        ({ id }) => id === item.use.templateId,
      );
      const target = template?.recommendedTarget;
      if (!template || !target) return [];
      const requirement = project?.connectionRequirements.find(
        ({ id }) => id === target.connectionRequirementId,
      );
      return [
        {
          templateName: template.name,
          connectionRequirementId: target.connectionRequirementId,
          connectionRequirementName: requirement?.name ?? target.connectionRequirementId,
          model: target.model,
        },
      ];
    }),
  };
}
