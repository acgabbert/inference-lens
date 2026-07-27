import {
  createBranchRevision,
  prepareProjectRevisionRun,
  sameConversationMessages,
} from "../packages/core/src/project.ts";
import type {
  ProjectFile,
  ProjectTemplateDiagnostic,
  TemplateRunOverrides,
} from "../packages/core/src/project.ts";
import type { ProviderCapabilities, RichInferenceRequest } from "../packages/core/src/types.ts";
import {
  createEntityId,
  createResolvedRunInput,
} from "../packages/core/src/run-kernel/index.ts";
import type {
  ConversationId,
  ConversationRevisionId,
  MessageId,
  ResolvedRunInput,
  RunConversationIdentity,
  RunId,
  RunTrace,
  ToolDefinition,
} from "../packages/core/src/run-kernel/index.ts";

/** The subset of a page-level pending branch that run preparation needs. */
export interface PendingRunBranch {
  parentRunId: RunId;
  parentConversationRevisionId?: ConversationRevisionId;
  branchMessageId: MessageId;
}

export interface PrepareWorkbenchRunInput {
  request: RichInferenceRequest;
  resolvedTools: ToolDefinition[];
  requestTools: ToolDefinition[];
  activeCapabilities: ProviderCapabilities;
  activeProfile: { id: string; name: string };
  projectFile?: ProjectFile;
  mappedProfileId?: string;
  runOverrides: TemplateRunOverrides;
  branchContext?: PendingRunBranch;
  /** The ad hoc conversation id remembered across runs with no active project. */
  adHocConversationId: ConversationId | null;
}

export type PrepareWorkbenchRunResult =
  | {
      ok: true;
      input: ResolvedRunInput;
      request: RichInferenceRequest;
      projectMutation?: ProjectFile;
      branchedFrom?: RunTrace["branchedFrom"];
      executedRevisionId?: ConversationRevisionId;
      consumesPendingBranch: boolean;
      adHocConversationId?: ConversationId;
    }
  | {
      ok: false;
      message: string;
      errorKind?: "tools-disabled";
    };

function templateRunErrorMessage(
  diagnostics: ProjectTemplateDiagnostic[],
): string {
  const first = diagnostics[0];
  if (!first) return "Resolve the template diagnostics before running.";
  const remaining = diagnostics.length - 1;
  return `Cannot run template use "${first.templateUseId}": ${first.diagnostic.message}${
    remaining > 0 ? ` (${remaining} more ${remaining === 1 ? "issue" : "issues"})` : ""
  }`;
}

function validateSelectedTools(tools: ToolDefinition[]): string | undefined {
  const names = new Set<string>();
  for (const tool of tools) {
    if (!tool.name.trim()) return "Every attached tool needs a name.";
    if (names.has(tool.name)) {
      return `More than one attached tool is named "${tool.name}".`;
    }
    names.add(tool.name);
  }
  return undefined;
}

/**
 * Mirrors the page's ad hoc (no active project) conversation identity: the
 * first run mints a conversation id and every later run in the same session
 * reuses it, while each run gets its own fresh revision id.
 */
function resolveCurrentIdentity(
  projectFile: ProjectFile | undefined,
  adHocConversationId: ConversationId | null,
): { identity: RunConversationIdentity; adHocConversationId?: ConversationId } {
  const revision = projectFile?.conversationRevisions.find(
    ({ id }) => id === projectFile.defaults.conversationRevisionId,
  );
  if (revision) {
    return {
      identity: {
        conversationId: revision.conversationId,
        conversationRevisionId: revision.id,
      },
    };
  }
  const conversationId =
    adHocConversationId ?? createEntityId("conversation", crypto.randomUUID());
  return {
    identity: {
      conversationId,
      conversationRevisionId: createEntityId("revision", crypto.randomUUID()),
    },
    adHocConversationId: conversationId,
  };
}

/**
 * Validates and resolves everything a run needs before any transport or
 * `RunCoordinator` exists. A failed result leaves the caller's project,
 * pending branch, and template state untouched — the caller applies
 * `projectMutation`, `executedRevisionId`, and `consumesPendingBranch`
 * explicitly only after `ok` is true.
 */
export function prepareWorkbenchRun(
  input: PrepareWorkbenchRunInput,
): PrepareWorkbenchRunResult {
  if (input.projectFile && !input.mappedProfileId) {
    return {
      ok: false,
      message: "Map this project's connection to a local profile before running.",
    };
  }

  const selectedTools = [...input.resolvedTools, ...input.requestTools];
  const toolError = validateSelectedTools(selectedTools);
  if (toolError) return { ok: false, message: toolError };

  if (selectedTools.length > 0 && !input.activeCapabilities.tools) {
    return {
      ok: false,
      errorKind: "tools-disabled",
      message: `This request includes ${selectedTools.length} selected ${
        selectedTools.length === 1 ? "tool" : "tools"
      }, but profile "${input.activeProfile.name || "Untitled profile"}" does not allow tool calling.`,
    };
  }

  let request = input.request;
  let projectForRun = input.projectFile;
  let identity: RunConversationIdentity;
  let branchedFrom: RunTrace["branchedFrom"];
  let projectMutation: ProjectFile | undefined;
  let adHocConversationId: ConversationId | undefined;
  const consumesPendingBranch = Boolean(input.branchContext);

  if (input.branchContext) {
    const branchContext = input.branchContext;
    if (input.projectFile) {
      if (!branchContext.parentConversationRevisionId) {
        return {
          ok: false,
          message:
            "This branch context is missing its parent revision. Start the branch again from its source run.",
        };
      }
      const parent = input.projectFile.conversationRevisions.find(
        ({ id }) => id === branchContext.parentConversationRevisionId,
      );
      if (!parent) {
        return { ok: false, message: "The parent revision is no longer in this project." };
      }
      let branchedProject: ProjectFile;
      try {
        branchedProject = createBranchRevision(input.projectFile, {
          conversationId: parent.conversationId,
          parentRevisionId: parent.id,
          messages: request.messages,
          runOverrides: input.runOverrides,
        });
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : "Could not create the branch revision.",
        };
      }
      const revision = branchedProject.conversationRevisions.at(-1)!;
      projectMutation = branchedProject;
      projectForRun = branchedProject;
      identity = {
        conversationId: revision.conversationId,
        conversationRevisionId: revision.id,
      };
    } else {
      const resolved = resolveCurrentIdentity(undefined, input.adHocConversationId);
      identity = resolved.identity;
      adHocConversationId = resolved.adHocConversationId;
    }
    branchedFrom = {
      runId: branchContext.parentRunId,
      parentConversationRevisionId: branchContext.parentConversationRevisionId,
      messageId: branchContext.branchMessageId,
    };
  } else {
    const resolved = resolveCurrentIdentity(input.projectFile, input.adHocConversationId);
    identity = resolved.identity;
    adHocConversationId = resolved.adHocConversationId;
  }

  let templateResolutions: ResolvedRunInput["templateResolutions"] = [];
  if (
    projectForRun &&
    identity.conversationRevisionId === projectForRun.defaults.conversationRevisionId
  ) {
    const revision = projectForRun.conversationRevisions.find(
      ({ id }) => id === identity.conversationRevisionId,
    );
    if (!revision) {
      return { ok: false, message: "The active project conversation revision no longer exists." };
    }
    const prepared = prepareProjectRevisionRun(projectForRun, revision, input.runOverrides);
    if (!prepared.ok) {
      return { ok: false, message: templateRunErrorMessage(prepared.diagnostics) };
    }
    const hasTemplateUses = revision.items.some((item) => item.kind === "template-use");
    if (hasTemplateUses && !sameConversationMessages(request.messages, prepared.messages)) {
      return {
        ok: false,
        message:
          "This template-backed conversation differs from its generated messages. Detach the template use before editing generated text.",
      };
    }
    if (hasTemplateUses) {
      request = { ...request, messages: prepared.messages };
    }
    templateResolutions = prepared.templateResolutions;
  }

  const resolvedInput = createResolvedRunInput(request, identity, selectedTools, templateResolutions);
  resolvedInput.target.profileId = createEntityId("profile", input.activeProfile.id);

  return {
    ok: true,
    input: resolvedInput,
    request,
    projectMutation,
    branchedFrom,
    executedRevisionId: projectForRun ? identity.conversationRevisionId : undefined,
    consumesPendingBranch,
    adHocConversationId,
  };
}
