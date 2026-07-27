"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  appendPromptTemplateRevision,
  createPromptTemplate,
  detachPromptTemplateUse,
  findPromptTemplateUsages,
  insertPromptTemplateUse,
  removePromptTemplateUse,
  renamePromptTemplate,
  updatePromptTemplateUseToLatest,
  updatePromptTemplateUseValues,
} from "../../../packages/core/src/project.ts";
import type {
  ProjectConversationItem,
  ProjectFile,
  PromptTemplateContent,
  TemplateRunOverrides,
  ToolMock,
} from "../../../packages/core/src/project.ts";
import { createEntityId } from "../../../packages/core/src/run-kernel/types.ts";
import type {
  ConversationMessage,
  ConversationRevisionId,
  MessageId,
  PromptTemplateId,
  PromptTemplateRevisionId,
  PromptTemplateUseId,
  ToolId,
  ToolDefinition,
} from "../../../packages/core/src/run-kernel/types.ts";
import { discoverTemplateVariables } from "../../../packages/core/src/template-engine.ts";
import type { RichInferenceRequest } from "../../../packages/core/src/types.ts";
import type { ConfirmationDialogRequest } from "../../confirmation-dialog.client";
import {
  nextTemplateRunOverrides,
  projectDraft,
  projectTemplateMutationTarget,
  resolvedTemplateRequestPreview,
  updateAuthoredProjectItems,
} from "./project-template-actions.client";
import {
  projectTemplateWorkbenchView,
} from "./project-template-workbench.client";
import { removeDraftMessage } from "../../use-request-draft.client";

type TemplateRole = "system" | "user" | "assistant";

export interface ProjectTemplatesHandle {
  runOverrides: TemplateRunOverrides;
  confirmation?: ConfirmationDialogRequest;
  templateWorkbench: ReturnType<typeof projectTemplateWorkbenchView>;
  activeProjectRevision?: ProjectFile["conversationRevisions"][number];
  activeProjectResolution?: ReturnType<typeof projectTemplateWorkbenchView>["resolution"];
  usageCounts: ReadonlyMap<PromptTemplateId, number>;
  composerItems: ProjectConversationItem[];
  requestPreview?: ReturnType<typeof resolvedTemplateRequestPreview>;
  markRevisionExecuted(revisionId: ConversationRevisionId): void;
  resetRunOverrides(): void;
  createProjectTemplate(name: string, content: PromptTemplateContent): PromptTemplateId;
  saveProjectTemplate(templateId: PromptTemplateId, name: string, content: PromptTemplateContent, defaults: Record<string, string>): PromptTemplateRevisionId;
  insertProjectTemplate(templateId: PromptTemplateId, role: TemplateRole, itemIndex: number): void;
  updateTemplateUseValues(templateUseId: PromptTemplateUseId, values: Record<string, string>): void;
  updateTemplateUseOverride(templateUseId: PromptTemplateUseId, values: Record<string, string>): void;
  updateTemplateUseToLatestRevision(templateUseId: PromptTemplateUseId): void;
  detachTemplateUseFromProject(templateUseId: PromptTemplateUseId): void;
  removeTemplateUseFromProject(templateUseId: PromptTemplateUseId): void;
  addComposerMessage(): void;
  updateComposerMessage(id: MessageId, patch: { content?: ConversationMessage["content"]; role?: ConversationMessage["role"] }): void;
  removeComposerMessage(id: MessageId): void;
  dismissConfirmation(): void;
}

/** Owns project-template state and immutable authored-conversation mutations. */
export function useProjectTemplates(input: {
  projectFile: ProjectFile | null;
  projectDirty: boolean;
  branchParentRevisionId?: ConversationRevisionId;
  ensureProjectDocument(): ProjectFile;
  adoptProjectMutation(project: ProjectFile): void;
  replaceProjectDraft(draft: ReturnType<typeof projectDraft>): void;
  messages: ConversationMessage[];
  tools: ToolDefinition[];
  toolMocks: ToolMock[];
  enabledToolIds: ToolId[];
  serializedTools(): ToolDefinition[];
  resolvedTools(): ToolDefinition[];
  requestTools: ToolDefinition[];
  currentRequest(): RichInferenceRequest;
  addDraftMessage(): void;
  updateDraftMessage(id: MessageId, patch: { content?: ConversationMessage["content"]; role?: ConversationMessage["role"] }): void;
  removeDraftMessage(id: MessageId): void;
}): ProjectTemplatesHandle {
  const [runOverrides, setRunOverrides] = useState<TemplateRunOverrides>({});
  const [confirmation, setConfirmation] = useState<ConfirmationDialogRequest>();
  const executedRevisionIdsRef = useRef(new Set<ConversationRevisionId>());

  useEffect(() => {
    if (input.projectFile && !input.projectDirty) {
      executedRevisionIdsRef.current.add(input.projectFile.defaults.conversationRevisionId);
    }
  }, [input.projectDirty, input.projectFile]);

  const activeProjectRevision = input.projectFile?.conversationRevisions.find(
    ({ id }) => id === input.projectFile!.defaults.conversationRevisionId,
  );
  const templateWorkbench = useMemo(
    () => projectTemplateWorkbenchView({
      project: input.projectFile,
      messages: input.messages,
      runOverrides,
      branchParentRevisionId: input.branchParentRevisionId,
    }),
    [input.branchParentRevisionId, input.messages, input.projectFile, runOverrides],
  );
  const usageCounts = useMemo(() => {
    const counts = new Map<PromptTemplateId, number>();
    input.projectFile?.promptTemplates.forEach((template) => {
      counts.set(template.id, findPromptTemplateUsages(input.projectFile!, template.id).length);
    });
    return counts;
  }, [input.projectFile]);
  const requestPreview = useMemo(() => {
    if (!input.projectFile || !activeProjectRevision) return undefined;
    if (templateWorkbench.resolutionError) return { error: templateWorkbench.resolutionError };
    if (!templateWorkbench.resolution) return undefined;
    return resolvedTemplateRequestPreview({
      request: input.currentRequest(),
      resolution: templateWorkbench.resolution,
      conversationId: activeProjectRevision.conversationId,
      conversationRevisionId: activeProjectRevision.id,
      tools: [...input.resolvedTools(), ...input.requestTools],
    });
  }, [activeProjectRevision, input, templateWorkbench.resolution, templateWorkbench.resolutionError]);

  function adoptAuthoredProject(project: ProjectFile, overrides = runOverrides): void {
    input.adoptProjectMutation(project);
    input.replaceProjectDraft(projectDraft(project, overrides));
  }

  function mutationTarget() {
    return projectTemplateMutationTarget({
      project: input.ensureProjectDocument(),
      runOverrides,
      executedRevisionIds: executedRevisionIdsRef.current,
    });
  }

  function mutateAuthoredItems(update: (items: ProjectConversationItem[]) => ProjectConversationItem[]): void {
    const target = mutationTarget();
    const revision = target.project.conversationRevisions.find(({ id }) => id === target.revisionId)!;
    const project = updateAuthoredProjectItems({
      project: target.project,
      revisionId: target.revisionId,
      draft: {
        messages: input.messages,
        model: input.currentRequest().model,
        temperature: input.currentRequest().temperature,
        tools: input.serializedTools(),
        toolMocks: input.toolMocks,
        enabledToolIds: input.enabledToolIds,
      },
      items: update(structuredClone(revision.items)),
    });
    adoptAuthoredProject(project);
  }

  return {
    runOverrides,
    confirmation,
    templateWorkbench,
    activeProjectRevision,
    activeProjectResolution: templateWorkbench.resolution,
    usageCounts,
    composerItems: templateWorkbench.composerItems,
    requestPreview,
    markRevisionExecuted(revisionId) {
      executedRevisionIdsRef.current.add(revisionId);
    },
    resetRunOverrides() { setRunOverrides({}); },
    createProjectTemplate(name, content) {
      const suffix = crypto.randomUUID();
      const project = createPromptTemplate(input.ensureProjectDocument(), {
        name, content, idSuffix: suffix, revisionIdSuffix: `${suffix}-1`,
      });
      adoptAuthoredProject(project);
      return createEntityId("template", suffix);
    },
    saveProjectTemplate(templateId, name, content, defaults) {
      let project = renamePromptTemplate(input.ensureProjectDocument(), templateId, name);
      project = appendPromptTemplateRevision(project, { templateId, content, variableDefaults: defaults });
      adoptAuthoredProject(project);
      return project.promptTemplates.find(({ id }) => id === templateId)!.currentRevisionId;
    },
    insertProjectTemplate(templateId, role, itemIndex) {
      const target = mutationTarget();
      adoptAuthoredProject(insertPromptTemplateUse(target.project, {
        conversationRevisionId: target.revisionId, templateId, fragmentRole: role, itemIndex,
      }));
    },
    updateTemplateUseValues(templateUseId, values) {
      const target = mutationTarget();
      adoptAuthoredProject(updatePromptTemplateUseValues(target.project, {
        conversationRevisionId: target.revisionId, templateUseId, values,
      }));
    },
    updateTemplateUseOverride(templateUseId, values) {
      const overrides = nextTemplateRunOverrides(runOverrides, templateUseId, values);
      setRunOverrides(overrides);
      if (input.projectFile) input.replaceProjectDraft(projectDraft(input.projectFile, overrides));
    },
    updateTemplateUseToLatestRevision(templateUseId) {
      const project = input.ensureProjectDocument();
      const revision = project.conversationRevisions.find(({ id }) => id === project.defaults.conversationRevisionId)!;
      const item = revision.items.find((candidate) => candidate.kind === "template-use" && candidate.use.id === templateUseId);
      if (!item || item.kind !== "template-use") return;
      const template = project.promptTemplates.find(({ id }) => id === item.use.templateId)!;
      const pinned = template.revisions.find(({ id }) => id === item.use.templateRevisionId)!;
      const latest = template.revisions.find(({ id }) => id === template.currentRevisionId)!;
      const describe = (content: PromptTemplateContent) => content.kind === "fragment" ? content.text : content.messages.map(({ role, content: text }) => `${role}: ${text}`).join("\n");
      setConfirmation({
        title: `Update "${template.name}"?`,
        description: "The use will pin the latest immutable revision. Assignments for removed variables and its run-only overrides will be cleared.",
        confirmLabel: "Update to latest",
        details: [
          { label: "From", value: pinned.id }, { label: "To", value: latest.id },
          { label: "Variables", value: `${discoverTemplateVariables(pinned.content).variables.map(({ name }) => name).join(", ") || "none"} → ${discoverTemplateVariables(latest.content).variables.map(({ name }) => name).join(", ") || "none"}` },
          { label: "Current content", value: describe(pinned.content) }, { label: "Latest content", value: describe(latest.content) },
        ],
        onConfirm: () => {
          const target = mutationTarget();
          const extraIds = Array.from({ length: Math.max(0, (latest.content.kind === "fragment" ? 1 : latest.content.messages.length) - item.use.outputMessageIds.length) }, () => crypto.randomUUID());
          const next = updatePromptTemplateUseToLatest(target.project, {
            conversationRevisionId: target.revisionId, templateUseId, newOutputMessageIdSuffixes: extraIds,
            ...(latest.content.kind === "fragment" ? { fragmentRole: item.use.fragmentRole ?? "user" } : {}),
          });
          const overrides = nextTemplateRunOverrides(runOverrides, templateUseId);
          setRunOverrides(overrides);
          adoptAuthoredProject(next, overrides);
        },
      });
    },
    detachTemplateUseFromProject(templateUseId) {
      setConfirmation({
        title: "Detach this template use?", description: "Its currently resolved values, including run-only overrides, will become ordinary literal messages with the same message IDs.", confirmLabel: "Detach",
        onConfirm: () => {
          const target = mutationTarget();
          const next = detachPromptTemplateUse(target.project, { conversationRevisionId: target.revisionId, templateUseId, runOverrides });
          const overrides = nextTemplateRunOverrides(runOverrides, templateUseId);
          setRunOverrides(overrides);
          adoptAuthoredProject(next, overrides);
        },
      });
    },
    removeTemplateUseFromProject(templateUseId) {
      setConfirmation({
        title: "Remove this template use?", description: "The pinned use and all messages it generates will be removed from this conversation revision.", confirmLabel: "Remove use", destructive: true,
        onConfirm: () => {
          const target = mutationTarget();
          const next = removePromptTemplateUse(target.project, target.revisionId, templateUseId);
          const overrides = nextTemplateRunOverrides(runOverrides, templateUseId);
          setRunOverrides(overrides);
          adoptAuthoredProject(next, overrides);
        },
      });
    },
    addComposerMessage() {
      if (!input.projectFile) return input.addDraftMessage();
      mutateAuthoredItems((items) => [...items, { kind: "message", message: { id: createEntityId("message", crypto.randomUUID()), role: "user", content: [{ type: "text", text: "" }] } }]);
    },
    updateComposerMessage(id, patch) {
      if (!input.projectFile) return input.updateDraftMessage(id, patch);
      mutateAuthoredItems((items) => items.map((item) => {
        if (item.kind !== "message" || item.message.id !== id) return item;
        const message = item.message;
        const content = patch.content ?? message.content;
        if (message.role === "tool" || (message.role === "assistant" && message.toolCalls?.length)) return { kind: "message", message: { ...message, content } };
        return { kind: "message", message: { id: message.id, role: patch.role ?? message.role, content } as ConversationMessage };
      }));
    },
    removeComposerMessage(id) {
      if (!input.projectFile) return input.removeDraftMessage(id);
      const remaining = new Set(removeDraftMessage(input.messages, id).map((message) => message.id));
      mutateAuthoredItems((items) => items.filter((item) => item.kind === "template-use" || remaining.has(item.message.id)));
    },
    dismissConfirmation() { setConfirmation(undefined); },
  };
}
