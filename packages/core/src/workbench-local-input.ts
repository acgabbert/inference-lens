import type { DecisionInput } from "./decision.ts";
import { resolveDecisionRequest } from "./decision-request.ts";
import type { DecisionRequestDiagnostic } from "./decision-request.ts";
import { parseProjectFile, ProjectValidationError } from "./project.ts";
import type { ExecutionTarget, ProjectConversationItem, ProjectFile } from "./project.ts";
import type {
  LocalChatInput,
  LocalDecisionInput,
  WorkbenchDecisionRequestContent,
  WorkbenchDraftV1,
  WorkbenchScratchV1,
} from "./personal-workbench.ts";
import { randomUUID } from "./random-id.ts";
import { createEntityId } from "./run-kernel/types.ts";
import type {
  ConversationRevisionId,
  DecisionRequestRevisionId,
  InferenceOptions,
  RunConversationIdentity,
  ToolId,
} from "./run-kernel/types.ts";

/**
 * The boundary between personal input and shared definitions
 * (docs/SHARED_ASSETS_LEVEL_TWO_DESIGN.md, "Core operations"): what a local
 * selection runs, under which identity, and the only writers of launch
 * defaults, which never take a local reference (D13).
 */

export interface WorkbenchLocalRecords {
  drafts: readonly WorkbenchDraftV1[];
  scratches: readonly WorkbenchScratchV1[];
}

export interface ResolvedLocalChatInput {
  /** The caller's copy; render it as a saved revision's items are rendered. */
  items: ProjectConversationItem[];
  identity: RunConversationIdentity;
}

export interface ResolveLocalInputOptions {
  /** Suffix of the fresh revision ID a local input runs under. */
  idSuffix?: string;
}

function localDraft(project: ProjectFile, records: WorkbenchLocalRecords, draftId: string, kind: "chat-request" | "decision-request") {
  const draft = records.drafts.find(record => record.draftId === draftId);
  return draft?.projectId === project.projectId && draft.asset.kind === kind ? draft : undefined;
}

function localScratch(project: ProjectFile, records: WorkbenchLocalRecords, scratchId: string, kind: "chat" | "decision") {
  const scratch = records.scratches.find(record => record.scratchId === scratchId);
  return scratch?.projectId === project.projectId && scratch.request.kind === kind ? scratch : undefined;
}

/**
 * A saved revision runs as itself. A request draft runs under its saved
 * conversation and a scratch under its stable local conversation, each with a
 * fresh revision ID, which is never written to the project (I3). Undefined
 * means the reference names nothing runnable here.
 */
export function resolveLocalChatInput(
  project: ProjectFile,
  records: WorkbenchLocalRecords,
  input: LocalChatInput,
  { idSuffix = randomUUID() }: ResolveLocalInputOptions = {},
): ResolvedLocalChatInput | undefined {
  switch (input.kind) {
    case "saved-conversation-revision": {
      const revision = project.conversationRevisions.find(({ id }) => id === input.revisionId);
      return revision && {
        items: structuredClone(revision.items),
        identity: { conversationId: revision.conversationId, conversationRevisionId: revision.id },
      };
    }
    case "draft": {
      const draft = localDraft(project, records, input.draftId, "chat-request");
      if (!draft || !("items" in draft.edited)) return undefined;
      return {
        items: structuredClone(draft.edited.items),
        identity: { conversationId: draft.asset.id as RunConversationIdentity["conversationId"], conversationRevisionId: createEntityId("revision", idSuffix) },
      };
    }
    case "scratch": {
      const scratch = localScratch(project, records, input.scratchId, "chat");
      if (scratch?.request.kind !== "chat") return undefined;
      return {
        items: structuredClone(scratch.request.items),
        identity: { conversationId: scratch.localConversationId, conversationRevisionId: createEntityId("revision", idSuffix) },
      };
    }
  }
}

export interface ResolvedLocalDecisionInput {
  /** The request as authored, saved or local. */
  content: WorkbenchDecisionRequestContent;
  /** Authored content, with a template-use pin resolved; tokens are kept. */
  decision: DecisionInput;
  /** Supplied assignments only: a pin's defaults under the request's overrides. */
  values: Record<string, string>;
  variables: string[];
  diagnostics: DecisionRequestDiagnostic[];
}

/**
 * The decision equivalent. Decision traces carry no request pin (D12), so it
 * returns no run identity. A template-use pin is resolved against the live
 * project; a local pin that no longer resolves makes the input unavailable.
 */
export function resolveLocalDecisionInput(
  project: ProjectFile,
  records: WorkbenchLocalRecords,
  input: LocalDecisionInput,
): ResolvedLocalDecisionInput | undefined {
  let content: WorkbenchDecisionRequestContent | undefined;
  switch (input.kind) {
    case "saved-decision-request-revision": {
      const revision = project.decisionRequestRevisions.find(({ id }) => id === input.revisionId);
      content = revision && (revision.kind === "inline"
        ? { kind: "inline", decision: revision.decision, values: revision.values }
        : { kind: "template-use", templateId: revision.templateId, templateRevisionId: revision.templateRevisionId, overrides: revision.overrides });
      break;
    }
    case "draft": {
      const draft = localDraft(project, records, input.draftId, "decision-request");
      content = draft && !("items" in draft.edited) && "kind" in draft.edited ? draft.edited as WorkbenchDecisionRequestContent : undefined;
      break;
    }
    case "scratch": {
      const scratch = localScratch(project, records, input.scratchId, "decision");
      content = scratch?.request.kind === "decision" ? scratch.request.content : undefined;
    }
  }
  if (!content) return undefined;
  let decision: DecisionInput;
  let values: Record<string, string>;
  if (content.kind === "inline") {
    decision = content.decision as DecisionInput;
    values = { ...content.values };
  } else {
    const { templateId, templateRevisionId, overrides } = content;
    const template = project.promptTemplates.find(({ id }) => id === templateId);
    const pin = template?.kind === "decision" ? template.revisions.find(({ id }) => id === templateRevisionId) : undefined;
    if (!pin) return undefined;
    decision = pin.decision;
    values = { ...pin.variableDefaults, ...overrides };
  }
  const { variables, diagnostics } = resolveDecisionRequest(decision, values);
  return { content: structuredClone(content), decision: structuredClone(decision), values, variables, diagnostics };
}

export interface ChatLaunchDefaults {
  revisionId: ConversationRevisionId;
  target: ExecutionTarget;
  options: InferenceOptions;
  enabledToolIds: ToolId[];
}

/**
 * "Use as project launch default" for chat (D13): the selected saved request
 * revision, target, options and tools. The environment keeps its own
 * set-default, and the decision pin its own action.
 */
export function setLaunchDefaults(project: ProjectFile, { chat }: { chat: ChatLaunchDefaults }): ProjectFile {
  if (!project.conversationRevisions.some(({ id }) => id === chat.revisionId)) {
    throw new ProjectValidationError([{
      code: "custom", path: ["defaults", "conversationRevisionId"],
      message: "A launch default must name a saved request revision. Save the request first.",
    }]);
  }
  return parseProjectFile({
    ...project,
    defaults: {
      ...project.defaults,
      conversationRevisionId: chat.revisionId,
      target: structuredClone(chat.target),
      options: structuredClone(chat.options),
      enabledToolIds: [...chat.enabledToolIds],
    },
  });
}

/** The decision launch action writes only the decision request pin (D13). */
export function setDecisionLaunchDefault(project: ProjectFile, revisionId: DecisionRequestRevisionId): ProjectFile {
  if (!project.decisionRequestRevisions.some(({ id }) => id === revisionId)) {
    throw new ProjectValidationError([{
      code: "custom", path: ["defaults", "decisionRequestRevisionId"],
      message: "A launch default must name a saved decision request revision. Save the request first.",
    }]);
  }
  return parseProjectFile({ ...project, defaults: { ...project.defaults, decisionRequestRevisionId: revisionId } });
}
