import type { ProviderCapabilities, RichInferenceRequest } from "../../packages/core/src/types.ts";
import {
  createBranchRevision,
  prepareProjectRevisionRun,
  sameConversationMessages,
} from "../../packages/core/src/project.ts";
import type {
  ProjectFile,
  ProjectTemplateDiagnostic,
  TemplateRunOverrides,
} from "../../packages/core/src/project.ts";
import { createEntityId, createResolvedRunInput } from "../../packages/core/src/run-kernel/index.ts";
import type {
  ConversationId,
  ConversationRevisionId,
  MessageId,
  ResolvedRunInput,
  RunConversationIdentity,
  RunId,
  RunTrace,
  ToolDefinition,
} from "../../packages/core/src/run-kernel/index.ts";
import { randomUUID } from "../../packages/core/src/random-id.ts";

/** A pending branch is input to preparation, never a command it may consume. */
export interface WorkbenchBranchContext {
  parentRunId: RunId;
  parentConversationRevisionId?: ConversationRevisionId;
  branchMessageId: MessageId;
}

export interface PrepareWorkbenchRunInput {
  request: RichInferenceRequest;
  project?: ProjectFile;
  projectTools: readonly ToolDefinition[];
  requestTools: readonly ToolDefinition[];
  capabilities: ProviderCapabilities;
  profileName: string;
  branchContext?: WorkbenchBranchContext;
  templateRunOverrides: TemplateRunOverrides;
  adHocConversationId?: ConversationId;
}

export type PrepareWorkbenchRunResult =
  | {
      ok: true;
      input: ResolvedRunInput;
      projectMutation?: ProjectFile;
      branchedFrom?: RunTrace["branchedFrom"];
      executedRevisionId?: ConversationRevisionId;
      consumesPendingBranch: boolean;
      /** Remember only after success so a failed ad-hoc preparation is inert. */
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

function adHocIdentity(adHocConversationId?: ConversationId): {
  identity: RunConversationIdentity;
  rememberedConversationId: ConversationId;
} {
  const conversationId =
    adHocConversationId ?? createEntityId("conversation", randomUUID());
  return {
    identity: {
      conversationId,
      conversationRevisionId: createEntityId("revision", randomUUID()),
    },
    rememberedConversationId: conversationId,
  };
}

/**
 * Resolves a workbench run from immutable snapshots. It never writes a project
 * or consumes a pending branch; callers commit the returned effects together.
 */
export function prepareWorkbenchRun(
  snapshots: PrepareWorkbenchRunInput,
): PrepareWorkbenchRunResult {
  const selectedTools = [...snapshots.projectTools, ...snapshots.requestTools];
  const names = new Set<string>();
  for (const tool of selectedTools) {
    if (!tool.name.trim()) {
      return { ok: false, message: "Every attached tool needs a name." };
    }
    if (names.has(tool.name)) {
      return {
        ok: false,
        message: `More than one attached tool is named "${tool.name}".`,
      };
    }
    names.add(tool.name);
  }
  if (selectedTools.length > 0 && !snapshots.capabilities.tools) {
    return {
      ok: false,
      errorKind: "tools-disabled",
      message: `This request includes ${selectedTools.length} selected ${
        selectedTools.length === 1 ? "tool" : "tools"
      }, but profile "${snapshots.profileName || "Untitled profile"}" does not allow tool calling.`,
    };
  }

  let projectForRun = snapshots.project;
  let identity: RunConversationIdentity;
  let projectMutation: ProjectFile | undefined;
  let branchedFrom: RunTrace["branchedFrom"] | undefined;
  let rememberedConversationId: ConversationId | undefined;

  if (snapshots.branchContext) {
    if (snapshots.project) {
      const parentRevisionId = snapshots.branchContext.parentConversationRevisionId;
      if (!parentRevisionId) {
        return {
          ok: false,
          message: "This branch context is missing its parent revision. Start the branch again from its source run.",
        };
      }
      const parent = snapshots.project.conversationRevisions.find(
        ({ id }) => id === parentRevisionId,
      );
      if (!parent) {
        return { ok: false, message: "The parent revision is no longer in this project." };
      }
      try {
        projectMutation = createBranchRevision(snapshots.project, {
          conversationId: parent.conversationId,
          parentRevisionId: parent.id,
          messages: snapshots.request.messages,
          runOverrides: snapshots.templateRunOverrides,
        });
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : "Could not create the branch revision.",
        };
      }
      projectForRun = projectMutation;
      const revision = projectMutation.conversationRevisions.at(-1)!;
      identity = {
        conversationId: revision.conversationId,
        conversationRevisionId: revision.id,
      };
    } else {
      const adHoc = adHocIdentity(snapshots.adHocConversationId);
      identity = adHoc.identity;
      rememberedConversationId = adHoc.rememberedConversationId;
    }
    branchedFrom = {
      runId: snapshots.branchContext.parentRunId,
      parentConversationRevisionId: snapshots.branchContext.parentConversationRevisionId,
      messageId: snapshots.branchContext.branchMessageId,
    };
  } else if (snapshots.project) {
    const revision = snapshots.project.conversationRevisions.find(
      ({ id }) => id === snapshots.project!.defaults.conversationRevisionId,
    );
    if (!revision) {
      return { ok: false, message: "The active project conversation revision no longer exists." };
    }
    identity = {
      conversationId: revision.conversationId,
      conversationRevisionId: revision.id,
    };
  } else {
    const adHoc = adHocIdentity(snapshots.adHocConversationId);
    identity = adHoc.identity;
    rememberedConversationId = adHoc.rememberedConversationId;
  }

  let request = snapshots.request;
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
    let prepared: ReturnType<typeof prepareProjectRevisionRun>;
    try {
      prepared = prepareProjectRevisionRun(
        projectForRun,
        revision,
        snapshots.templateRunOverrides,
      );
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Could not resolve template uses for this run.",
      };
    }
    if (!prepared.ok) {
      return { ok: false, message: templateRunErrorMessage(prepared.diagnostics) };
    }
    const hasTemplateUses = revision.items.some((item) => item.kind === "template-use");
    if (hasTemplateUses && !sameConversationMessages(request.messages, prepared.messages)) {
      return {
        ok: false,
        message: "This template-backed conversation differs from its generated messages. Detach the template use before editing generated text.",
      };
    }
    if (hasTemplateUses) request = { ...request, messages: prepared.messages };
    templateResolutions = prepared.templateResolutions;
  }

  return {
    ok: true,
    input: createResolvedRunInput(request, identity, selectedTools, templateResolutions),
    ...(projectMutation ? { projectMutation } : {}),
    ...(branchedFrom ? { branchedFrom } : {}),
    ...(projectForRun ? { executedRevisionId: identity.conversationRevisionId } : {}),
    consumesPendingBranch: Boolean(snapshots.branchContext),
    ...(rememberedConversationId ? { adHocConversationId: rememberedConversationId } : {}),
  };
}
