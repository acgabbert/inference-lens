"use client";

import { useEffect, useRef, useState } from "react";
import {
  appendPromptTemplateRevision,
  createBranchRevision,
  createPromptTemplate,
  detachPromptTemplateUse,
  findPromptTemplateUsages,
  insertPromptTemplateUse,
  projectDraft,
  removePromptTemplateUse,
  renamePromptTemplate,
  resolveProjectRevision,
  setPromptTemplateRecommendedTarget,
  updateProjectDraft,
  updatePromptTemplateUseToLatest,
  updatePromptTemplateUseValues,
} from "../packages/core/src/project";
import type {
  ProjectConversationItem,
  ProjectFile,
  PromptTemplateContent,
  PromptTemplateRecommendedTarget,
  TemplateRunOverrides,
  ToolMock,
} from "../packages/core/src/project";
import {
  importExternalPromptCandidate,
  importExternalPromptTemplateCandidate,
} from "../packages/core/src/external-prompt-project";
import type { ExternalPromptCandidate } from "../packages/core/src/external-prompt-import";
import { createEntityId } from "../packages/core/src/run-kernel";
import type {
  ConversationMessage,
  ConversationRevisionId,
  MessageId,
  PromptTemplateId,
  PromptTemplateRevisionId,
  PromptTemplateUseId,
  ToolDefinition,
  ToolId,
} from "../packages/core/src/run-kernel";
import { randomUUID } from "../packages/core/src/random-id";
import { discoverTemplateVariables } from "../packages/core/src/template-engine";
import type { ConfirmationDialogRequest } from "./confirmation-dialog.client";
import {
  pendingBranchMessagesAfterItemUpdate,
  projectTemplateWorkbenchView,
} from "./project-template-workbench.client";
import { removeDraftMessage } from "./use-request-draft.client";

export interface ProjectTemplatesImportNotice {
  name: string;
  variableCount: number;
  template: boolean;
}

/** Stable render snapshots and narrowly named cross-owner commands. */
export interface UseProjectTemplatesInput {
  projectFile: ProjectFile | null;
  projectDirty: boolean;
  messages: ConversationMessage[];
  model: string;
  temperature: number;
  serializedTools(): ToolDefinition[];
  toolMocks: ToolMock[];
  enabledToolIds: ToolId[];
  branchParentRevisionId?: ConversationRevisionId;
  ensureProjectDocument(): ProjectFile;
  adoptProjectMutation(project: ProjectFile): void;
  replaceProjectDraft(draft: ReturnType<typeof projectDraft>): void;
  markProjectError(message: string | undefined): void;
  resetMessages(messages: ConversationMessage[]): void;
  addDraftMessage(): void;
  updateDraftMessage(id: MessageId, patch: { content?: ConversationMessage["content"]; role?: ConversationMessage["role"] }): void;
  removeDraftMessage(id: MessageId): void;
  clearPendingBranch(): void;
  requestConfirmation(request: ConfirmationDialogRequest): void;
  onImportApplied(): void;
}

export interface ProjectTemplatesHandle {
  templateWorkbench: ReturnType<typeof projectTemplateWorkbenchView>;
  activeProjectRevision?: ProjectFile["conversationRevisions"][number];
  activeConnectionRequirement?: ProjectFile["connectionRequirements"][number];
  templateUsageCounts: Map<PromptTemplateId, number>;
  templateRunOverrides: TemplateRunOverrides;
  importNotice?: ProjectTemplatesImportNotice;
  createProjectTemplate(name: string, content: PromptTemplateContent): PromptTemplateId;
  saveProjectTemplate(templateId: PromptTemplateId, name: string, content: PromptTemplateContent, defaults: Record<string, string>, recommendedTarget?: PromptTemplateRecommendedTarget): PromptTemplateRevisionId;
  insertProjectTemplate(templateId: PromptTemplateId, role: "system" | "user" | "assistant", itemIndex: number): void;
  updateTemplateUseValues(templateUseId: PromptTemplateUseId, values: Record<string, string>): void;
  saveTemplateUseRunValue(templateUseId: PromptTemplateUseId, values: Record<string, string>, useOverrides: Record<string, string>): void;
  updateTemplateUseOverride(templateUseId: PromptTemplateUseId, values: Record<string, string>): void;
  updateTemplateUseToLatestRevision(templateUseId: PromptTemplateUseId): void;
  detachTemplateUse(templateUseId: PromptTemplateUseId): void;
  removeTemplateUse(templateUseId: PromptTemplateUseId): void;
  addComposerMessage(): void;
  updateComposerMessage(id: MessageId, patch: { content?: ConversationMessage["content"]; role?: ConversationMessage["role"] }): void;
  removeComposerMessage(id: MessageId): void;
  importN8nPrompt(candidate: ExternalPromptCandidate, mode: "resolved-snapshot" | "reusable-template", options: { recommendModel: boolean }): Promise<void>;
  clearImportNotice(): void;
  clearTransientOverrides(): void;
  markExecutedRevision(revisionId: ConversationRevisionId): void;
}

export function useProjectTemplates(input: UseProjectTemplatesInput): ProjectTemplatesHandle {
  const [templateRunOverrides, setTemplateRunOverrides] = useState<TemplateRunOverrides>({});
  const [importNotice, setImportNotice] = useState<ProjectTemplatesImportNotice>();
  const executedRevisionIdsRef = useRef(new Set<ConversationRevisionId>());
  useEffect(() => {
    if (input.projectFile && !input.projectDirty) {
      executedRevisionIdsRef.current.add(input.projectFile.defaults.conversationRevisionId);
    }
  }, [input.projectDirty, input.projectFile]);

  const activeProjectRevision = input.projectFile?.conversationRevisions.find(
    ({ id }) => id === input.projectFile!.defaults.conversationRevisionId,
  );
  const templateWorkbench = projectTemplateWorkbenchView({
    project: input.projectFile,
    messages: input.messages,
    runOverrides: templateRunOverrides,
    branchParentRevisionId: input.branchParentRevisionId,
  });
  const activeConnectionRequirement = input.projectFile?.connectionRequirements.find(
    ({ id }) => id === input.projectFile!.defaults.target.connectionRequirementId,
  );
  const templateUsageCounts = new Map<PromptTemplateId, number>();
  input.projectFile?.promptTemplates.forEach((template) => {
    templateUsageCounts.set(template.id, findPromptTemplateUsages(input.projectFile!, template.id).length);
  });

  function adoptAuthoredProject(project: ProjectFile, overrides = templateRunOverrides): void {
    input.adoptProjectMutation(project);
    input.replaceProjectDraft(projectDraft(project, overrides));
  }

  function projectForUseMutation(): { project: ProjectFile; revisionId: ConversationRevisionId } {
    let project = input.ensureProjectDocument();
    let revision = project.conversationRevisions.find(({ id }) => id === project.defaults.conversationRevisionId)!;
    if (executedRevisionIdsRef.current.has(revision.id)) {
      project = createBranchRevision(project, {
        conversationId: revision.conversationId,
        parentRevisionId: revision.id,
        messages: resolveProjectRevision(project, revision, templateRunOverrides).messages,
        items: structuredClone(revision.items),
      });
      revision = project.conversationRevisions.find(({ id }) => id === project.defaults.conversationRevisionId)!;
    }
    return { project, revisionId: revision.id };
  }

  function createProjectTemplate(name: string, content: PromptTemplateContent): PromptTemplateId {
    const suffix = randomUUID();
    adoptAuthoredProject(createPromptTemplate(input.ensureProjectDocument(), { name, content, idSuffix: suffix, revisionIdSuffix: `${suffix}-1` }));
    return createEntityId("template", suffix);
  }
  function saveProjectTemplate(templateId: PromptTemplateId, name: string, content: PromptTemplateContent, defaults: Record<string, string>, recommendedTarget?: PromptTemplateRecommendedTarget): PromptTemplateRevisionId {
    let next = renamePromptTemplate(input.ensureProjectDocument(), templateId, name);
    next = setPromptTemplateRecommendedTarget(next, templateId, recommendedTarget);
    next = appendPromptTemplateRevision(next, { templateId, content, variableDefaults: defaults });
    adoptAuthoredProject(next);
    return next.promptTemplates.find(({ id }) => id === templateId)!.currentRevisionId;
  }
  function insertProjectTemplate(templateId: PromptTemplateId, role: "system" | "user" | "assistant", itemIndex: number): void {
    const { project, revisionId } = projectForUseMutation();
    adoptAuthoredProject(insertPromptTemplateUse(project, { conversationRevisionId: revisionId, templateId, fragmentRole: role, itemIndex }));
  }
  function updateTemplateUseValues(templateUseId: PromptTemplateUseId, values: Record<string, string>): void {
    const { project, revisionId } = projectForUseMutation();
    adoptAuthoredProject(updatePromptTemplateUseValues(project, { conversationRevisionId: revisionId, templateUseId, values }));
  }
  function updateTemplateUseOverride(templateUseId: PromptTemplateUseId, values: Record<string, string>): void {
    const overrides = { ...templateRunOverrides, [templateUseId]: values };
    setTemplateRunOverrides(overrides);
    if (input.projectFile) input.replaceProjectDraft(projectDraft(input.projectFile, overrides));
  }
  function saveTemplateUseRunValue(templateUseId: PromptTemplateUseId, values: Record<string, string>, useOverrides: Record<string, string>): void {
    const { project, revisionId } = projectForUseMutation();
    const next = updatePromptTemplateUseValues(project, { conversationRevisionId: revisionId, templateUseId, values });
    const overrides = { ...templateRunOverrides };
    if (Object.keys(useOverrides).length) overrides[templateUseId] = useOverrides;
    else delete overrides[templateUseId];
    setTemplateRunOverrides(overrides);
    adoptAuthoredProject(next, overrides);
  }
  function mutateAuthoredItems(update: (items: ProjectConversationItem[]) => ProjectConversationItem[]): void {
    if (input.branchParentRevisionId) {
      if (!input.projectFile) return;
      try { input.resetMessages(pendingBranchMessagesAfterItemUpdate({ project: input.projectFile, messages: input.messages, runOverrides: templateRunOverrides, parentRevisionId: input.branchParentRevisionId, update })); input.markProjectError(undefined); }
      catch (error) { input.markProjectError(error instanceof Error ? error.message : "Could not update the pending branch."); }
      return;
    }
    const { project, revisionId } = projectForUseMutation();
    const revision = project.conversationRevisions.find(({ id }) => id === revisionId)!;
    adoptAuthoredProject(updateProjectDraft(project, { messages: input.messages, items: update(structuredClone(revision.items)), model: input.model, temperature: input.temperature, tools: input.serializedTools(), toolMocks: input.toolMocks, enabledToolIds: input.enabledToolIds }));
  }
  function addComposerMessage(): void {
    if (!input.projectFile) return input.addDraftMessage();
    mutateAuthoredItems((items) => [...items, { kind: "message", message: { id: createEntityId("message", randomUUID()), role: "user", content: [{ type: "text", text: "" }] } }]);
  }
  function updateComposerMessage(id: MessageId, patch: { content?: ConversationMessage["content"]; role?: ConversationMessage["role"] }): void {
    if (!input.projectFile) return input.updateDraftMessage(id, patch);
    mutateAuthoredItems((items) => items.map((item) => {
      if (item.kind !== "message" || item.message.id !== id) return item;
      const message = item.message; const content = patch.content ?? message.content;
      if (message.role === "tool" || (message.role === "assistant" && message.toolCalls?.length)) return { ...item, message: { ...message, content } };
      return { ...item, message: { id: message.id, role: patch.role ?? message.role, content } as ConversationMessage };
    }));
  }
  function removeComposerMessage(id: MessageId): void {
    if (!input.projectFile) return input.removeDraftMessage(id);
    const remainingIds = new Set(removeDraftMessage(input.messages, id).map((message) => message.id));
    mutateAuthoredItems((items) => items.filter((item) => item.kind === "template-use" || remainingIds.has(item.message.id)));
  }
  function updateTemplateUseToLatestRevision(templateUseId: PromptTemplateUseId): void {
    const currentProject = input.ensureProjectDocument(); const currentRevision = currentProject.conversationRevisions.find(({ id }) => id === currentProject.defaults.conversationRevisionId)!;
    const item = currentRevision.items.find((candidate) => candidate.kind === "template-use" && candidate.use.id === templateUseId);
    if (!item || item.kind !== "template-use") return;
    const template = currentProject.promptTemplates.find(({ id }) => id === item.use.templateId)!;
    const pinned = template.revisions.find(({ id }) => id === item.use.templateRevisionId)!; const latest = template.revisions.find(({ id }) => id === template.currentRevisionId)!;
    const vars = (content: PromptTemplateContent) => discoverTemplateVariables(content).variables.map(({ name }) => name).join(", ") || "none";
    const describe = (content: PromptTemplateContent) => content.kind === "fragment" ? content.text : content.messages.map(({ role, content: text }) => `${role}: ${text}`).join("\n");
    input.requestConfirmation({ title: `Update "${template.name}"?`, description: "The use will pin the latest immutable revision. Assignments for removed variables and its run-only overrides will be cleared.", confirmLabel: "Update to latest", details: [{ label: "From", value: pinned.id }, { label: "To", value: latest.id }, { label: "Variables", value: `${vars(pinned.content)} → ${vars(latest.content)}` }, { label: "Current content", value: describe(pinned.content) }, { label: "Latest content", value: describe(latest.content) }], onConfirm() { const { project, revisionId } = projectForUseMutation(); const count = latest.content.kind === "fragment" ? 1 : latest.content.messages.length; const next = updatePromptTemplateUseToLatest(project, { conversationRevisionId: revisionId, templateUseId, newOutputMessageIdSuffixes: Array.from({ length: Math.max(0, count - item.use.outputMessageIds.length) }, () => randomUUID()), ...(latest.content.kind === "fragment" ? { fragmentRole: item.use.fragmentRole ?? "user" } : {}) }); const overrides = { ...templateRunOverrides }; delete overrides[templateUseId]; setTemplateRunOverrides(overrides); adoptAuthoredProject(next, overrides); } });
  }
  function detachTemplateUse(templateUseId: PromptTemplateUseId): void { input.requestConfirmation({ title: "Detach this template use?", description: "Its currently resolved values, including run-only overrides, will become ordinary literal messages with the same message IDs.", confirmLabel: "Detach", onConfirm() { const { project, revisionId } = projectForUseMutation(); const next = detachPromptTemplateUse(project, { conversationRevisionId: revisionId, templateUseId, runOverrides: templateRunOverrides }); const overrides = { ...templateRunOverrides }; delete overrides[templateUseId]; setTemplateRunOverrides(overrides); adoptAuthoredProject(next, overrides); } }); }
  function removeTemplateUse(templateUseId: PromptTemplateUseId): void { input.requestConfirmation({ title: "Remove this template use?", description: "The pinned use and all messages it generates will be removed from this conversation revision.", confirmLabel: "Remove use", destructive: true, onConfirm() { const { project, revisionId } = projectForUseMutation(); const next = removePromptTemplateUse(project, revisionId, templateUseId); const overrides = { ...templateRunOverrides }; delete overrides[templateUseId]; setTemplateRunOverrides(overrides); adoptAuthoredProject(next, overrides); } }); }
  async function importN8nPrompt(candidate: ExternalPromptCandidate, mode: "resolved-snapshot" | "reusable-template", { recommendModel }: { recommendModel: boolean }): Promise<void> {
    const imported = mode === "reusable-template" ? await importExternalPromptTemplateCandidate(input.ensureProjectDocument(), candidate, { recommendModel }) : await importExternalPromptCandidate(input.ensureProjectDocument(), candidate);
    input.adoptProjectMutation(imported.project); input.replaceProjectDraft(projectDraft(imported.project)); setTemplateRunOverrides({}); input.clearPendingBranch(); input.onImportApplied();
    const receipt = imported.project.externalImports.find(({ id }) => id === imported.externalImportId);
    setImportNotice({ name: candidate.invocation.name, variableCount: receipt?.projection.kind === "prompt-template" ? receipt.projection.variables.length : 0, template: mode === "reusable-template" });
  }
  return { templateWorkbench, activeProjectRevision, activeConnectionRequirement, templateUsageCounts, templateRunOverrides, importNotice, createProjectTemplate, saveProjectTemplate, insertProjectTemplate, updateTemplateUseValues, saveTemplateUseRunValue, updateTemplateUseOverride, updateTemplateUseToLatestRevision, detachTemplateUse, removeTemplateUse, addComposerMessage, updateComposerMessage, removeComposerMessage, importN8nPrompt, clearImportNotice: () => setImportNotice(undefined), clearTransientOverrides: () => setTemplateRunOverrides({}), markExecutedRevision: (id) => executedRevisionIdsRef.current.add(id) };
}
