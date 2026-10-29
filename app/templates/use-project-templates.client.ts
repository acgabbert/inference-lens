"use client";

import { useEffect, useRef, useState } from "react";
import {
  archivePromptTemplate,
  appendPromptTemplateRevision,
  createPromptTemplate,
  detachPromptTemplateUse,
  findPromptTemplateUsages,
  insertPromptTemplateUse,
  projectDraft,
  removePromptTemplateUse,
  renamePromptTemplate,
  renamePromptTemplateRevision,
  restorePromptTemplate,
  setPromptTemplateRecommendedTarget,
  updateProjectDraft,
  updatePromptTemplateDraft,
  updatePromptTemplateUseRevision,
  updatePromptTemplateUseValues,
} from "../../packages/core/src/project";
import type {
  ProjectConversationItem,
  ProjectFile,
  ChatPromptTemplate,
  PromptTemplate,
  PromptTemplateMessages,
  PromptTemplateRecommendedTarget,
  TemplateResolutionContext,
  TemplateRunOverrides,
  ToolMock,
} from "../../packages/core/src/project";
import {
  importExternalPromptCandidate,
  importExternalPromptTemplateCandidate,
} from "../../packages/core/src/external-prompt-project";
import type { ExternalPromptCandidate } from "../../packages/core/src/external-prompt-import";
import { createEntityId } from "../../packages/core/src/run-kernel";
import type {
  ConversationMessage,
  ConversationRevisionId,
  EnvironmentId,
  MessageId,
  PromptTemplateId,
  PromptTemplateRevisionId,
  PromptTemplateUseId,
  ToolDefinition,
  ToolId,
} from "../../packages/core/src/run-kernel";
import type { DecisionInput } from "../../packages/core/src/decision";
import { createDecisionPromptTemplate, appendDecisionPromptTemplateRevision, updateDecisionPromptTemplateDraft } from "../../packages/core/src/decision-template";
import { materializeSessionDecisionTemplate } from "./decision-session-template";
import {
  useDecisionTemplateEditorMemory,
  type DecisionTemplateEditorMemoryStore,
} from "./decision-template-editor-memory.client";
import { randomUUID } from "../../packages/core/src/random-id";
import type { ConfirmationDialogRequest } from "../confirmation-dialog.client";
import {
  pendingBranchMessagesAfterItemUpdate,
  projectTemplateWorkbenchView,
} from "./project-template-workbench.client";
import {
  projectForTemplateMutation,
  templateRunOverridesAfterRevisionUpdate,
  templateRunOverridesAfterSave,
  templateRunOverridesAfterUpdate,
} from "./project-template-policy";
import { usePromptModelWarnings, type PromptModelWarnings } from "./use-prompt-model-warnings.client";
import { removeDraftMessage } from "../request/use-request-draft.client";

/** What an external prompt import landed, reported once when it lands. */
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
  temperature?: number;
  serializedTools(): ToolDefinition[];
  toolMocks: ToolMock[];
  enabledToolIds: ToolId[];
  branchParentRevisionId?: ConversationRevisionId;
  /** The session's environment choice; looked up in whichever project is rendered. */
  environmentId?: EnvironmentId;
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
  /**
   * Announces a completed import. The outcome used to be held here as
   * `importNotice` and rendered by the request composer, which meant a
   * confirmation that needed no decision sat in the composer's layout until it
   * was dismissed. It is a toast now, so this hook reports the event and keeps
   * no state about it.
   */
  onImported(notice: ProjectTemplatesImportNotice): void;
  onSessionPromptNeedsProject(message: string): void;
}

export interface ProjectTemplatesHandle {
  modelWarnings: PromptModelWarnings;
  libraryTemplates: PromptTemplate[];
  decisionEditorMemory: DecisionTemplateEditorMemoryStore;
  createDecisionTemplate(name: string, decision: DecisionInput, defaults?: Record<string, string>): PromptTemplateId;
  /** Stages Compose content as a session-only prompt, even in an open project. */
  captureDecisionTemplate(name: string, decision: DecisionInput, defaults: Record<string, string>): PromptTemplateId;
  updateDecisionTemplateDraft(
    templateId: PromptTemplateId,
    sourceRevisionId: PromptTemplateRevisionId,
    decision: DecisionInput,
    defaults: Record<string, string>,
    revisionName?: string,
  ): void;
  saveDecisionTemplate(
    templateId: PromptTemplateId,
    name: string,
    decision: DecisionInput,
    defaults: Record<string, string>,
    revisionName?: string,
  ): PromptTemplateRevisionId | undefined;
  /**
   * Saves like `saveDecisionTemplate` and also returns the saved project, so a
   * use can pin the new revision before the route renders it.
   */
  saveDecisionTemplateForUse(
    templateId: PromptTemplateId,
    name: string,
    decision: DecisionInput,
    defaults: Record<string, string>,
    revisionName?: string,
  ): { project: ProjectFile; revisionId: PromptTemplateRevisionId } | undefined;
  sessionTemplateIds: ReadonlySet<PromptTemplateId>;
  templateWorkbench: ReturnType<typeof projectTemplateWorkbenchView>;
  activeProjectRevision?: ProjectFile["conversationRevisions"][number];
  activeConnectionRequirement?: ProjectFile["connectionRequirements"][number];
  templateUsageCounts: Map<PromptTemplateId, number>;
  templateRunOverrides: TemplateRunOverrides;
  /** What the composer's messages are rendered with; a run must prepare with it. */
  resolutionContext: TemplateResolutionContext;
  /**
   * Re-renders the composer for a new environment selection, or for new
   * content of the selected one, adopting `project` when it is given. The
   * caller changes the selection in the same event.
   */
  applyEnvironment(environmentId: EnvironmentId | undefined, project?: ProjectFile): void;
  createProjectTemplate(name: string, messages: PromptTemplateMessages): PromptTemplateId;
  updateProjectTemplateDraft(templateId: PromptTemplateId, sourceRevisionId: PromptTemplateRevisionId, messages: PromptTemplateMessages, defaults: Record<string, string>, revisionName?: string): void;
  updateProjectTemplateRecommendedTarget(templateId: PromptTemplateId, recommendedTarget?: PromptTemplateRecommendedTarget): void;
  saveProjectTemplate(templateId: PromptTemplateId, name: string, messages: PromptTemplateMessages, defaults: Record<string, string>, recommendedTarget?: PromptTemplateRecommendedTarget, revisionName?: string): PromptTemplateRevisionId | undefined;
  saveAndInsertProjectTemplate(templateId: PromptTemplateId, name: string, messages: PromptTemplateMessages, defaults: Record<string, string>, recommendedTarget: PromptTemplateRecommendedTarget | undefined, revisionName: string | undefined, itemIndex: number): PromptTemplateRevisionId | undefined;
  /** Commits only the label, without touching revision content. Returns false (and leaves the project untouched) for a blank name. */
  renameProjectTemplate(templateId: PromptTemplateId, name: string): boolean;
  /** Relabels a saved revision without touching its content; a blank name clears the label. */
  renameProjectTemplateRevision(templateId: PromptTemplateId, revisionId: PromptTemplateRevisionId, name: string): void;
  archiveProjectTemplate(templateId: PromptTemplateId, onArchived?: () => void): void;
  restoreProjectTemplate(templateId: PromptTemplateId): void;
  insertProjectTemplate(
    templateId: PromptTemplateId,
    templateRevisionId: PromptTemplateRevisionId,
    itemIndex: number,
    replaceEmptyDraft?: boolean,
  ): void;
  updateTemplateUseValues(templateUseId: PromptTemplateUseId, values: Record<string, string>): void;
  saveTemplateUseRunValue(templateUseId: PromptTemplateUseId, values: Record<string, string>, useOverrides: Record<string, string>): void;
  updateTemplateUseOverride(templateUseId: PromptTemplateUseId, values: Record<string, string>): void;
  /** Re-pins a use to any revision of its template; callers review the switch first. */
  setTemplateUseRevision(templateUseId: PromptTemplateUseId, templateRevisionId: PromptTemplateRevisionId): void;
  detachTemplateUse(templateUseId: PromptTemplateUseId): void;
  removeTemplateUse(templateUseId: PromptTemplateUseId): void;
  addComposerMessage(): void;
  updateComposerMessage(id: MessageId, patch: { content?: ConversationMessage["content"]; role?: ConversationMessage["role"] }): void;
  removeComposerMessage(id: MessageId): void;
  importN8nPrompt(candidate: ExternalPromptCandidate, mode: "resolved-snapshot" | "reusable-template", options: { recommendModel: boolean }): Promise<void>;
  clearTransientOverrides(): void;
  markExecutedRevision(revisionId: ConversationRevisionId): void;
}

export function useProjectTemplates(input: UseProjectTemplatesInput): ProjectTemplatesHandle {
  const [templateRunOverrides, setTemplateRunOverrides] = useState<TemplateRunOverrides>({});
  const [sessionTemplates, setSessionTemplates] = useState<PromptTemplate[]>([]);
  const decisionEditorMemory = useDecisionTemplateEditorMemory();
  const executedRevisionIdsRef = useRef(new Set<ConversationRevisionId>());
  useEffect(() => {
    if (input.projectFile && !input.projectDirty) {
      executedRevisionIdsRef.current.add(input.projectFile.defaults.conversationRevisionId);
    }
  }, [input.projectDirty, input.projectFile]);

  const activeProjectRevision = input.projectFile?.conversationRevisions.find(
    ({ id }) => id === input.projectFile!.defaults.conversationRevisionId,
  );
  function contextFor(
    project: ProjectFile | null,
    runOverrides: TemplateRunOverrides = templateRunOverrides,
    environmentId: EnvironmentId | undefined = input.environmentId,
  ): TemplateResolutionContext {
    const environment = environmentId
      ? project?.environments.find(({ id }) => id === environmentId)
      : undefined;
    return { runOverrides, ...(environment ? { environment } : {}) };
  }
  const resolutionContext = contextFor(input.projectFile);
  const templateWorkbench = projectTemplateWorkbenchView({
    project: input.projectFile,
    messages: input.messages,
    resolutionContext,
    branchParentRevisionId: input.branchParentRevisionId,
  });
  const modelWarnings = usePromptModelWarnings(input.projectFile?.projectId ?? "session", templateWorkbench.composerItems.flatMap((item) =>
    item.kind === "template-use" ? [{
      id: item.use.id,
      recommendation: input.projectFile?.promptTemplates.find(({ id }) => id === item.use.templateId)?.recommendedTarget,
      selectedModel: input.model,
    }] : [],
  ));
  const activeConnectionRequirement = input.projectFile?.connectionRequirements.find(
    ({ id }) => id === input.projectFile!.defaults.target.connectionRequirementId,
  );
  const templateUsageCounts = new Map<PromptTemplateId, number>();
  input.projectFile?.promptTemplates.forEach((template) => {
    templateUsageCounts.set(template.id, findPromptTemplateUsages(input.projectFile!, template.id).length);
  });
  const sessionTemplateIds = new Set(sessionTemplates.map(({ id }) => id));
  const libraryTemplates = [
    ...(input.projectFile?.promptTemplates ?? []),
    ...sessionTemplates.filter(
      ({ id }) => !input.projectFile?.promptTemplates.some((template) => template.id === id),
    ),
  ];

  function adoptAuthoredProject(project: ProjectFile, overrides = templateRunOverrides): void {
    input.adoptProjectMutation(project);
    input.replaceProjectDraft(projectDraft(project, contextFor(project, overrides)));
  }

  function applyEnvironment(environmentId: EnvironmentId | undefined, project?: ProjectFile): void {
    const current = input.projectFile;
    const next = project ?? current;
    if (!next) return;
    if (input.branchParentRevisionId && current) {
      // A pending branch is not in the document, so its messages are re-read
      // as authored items under the old context and rendered under the new.
      try {
        const messages = pendingBranchMessagesAfterItemUpdate({
          project: current,
          messages: input.messages,
          resolutionContext,
          parentRevisionId: input.branchParentRevisionId,
          update: (items) => items,
          nextResolutionContext: contextFor(next, templateRunOverrides, environmentId),
        });
        if (project) input.adoptProjectMutation(project);
        input.resetMessages(messages);
        input.markProjectError(undefined);
      } catch (error) {
        input.markProjectError(error instanceof Error ? error.message : "Could not render the pending branch with this environment.");
      }
      return;
    }
    if (project) input.adoptProjectMutation(project);
    input.replaceProjectDraft(projectDraft(next, contextFor(next, templateRunOverrides, environmentId)));
  }

  function projectForUseMutation(): { project: ProjectFile; revisionId: ConversationRevisionId } {
    const project = input.ensureProjectDocument();
    return projectForTemplateMutation({
      project,
      executedRevisionIds: executedRevisionIdsRef.current,
      resolutionContext: contextFor(project),
    });
  }

  function createDecisionTemplate(
    name: string,
    decision: DecisionInput,
    defaults: Record<string, string> = {},
    sessionOnly = false,
  ): PromptTemplateId {
    const suffix = randomUUID();
    const id = createEntityId("template", suffix);
    if (input.projectFile && !sessionOnly) {
      adoptAuthoredProject(createDecisionPromptTemplate(input.ensureProjectDocument(), {
        name,
        decision,
        variableDefaults: defaults,
        idSuffix: suffix,
        revisionIdSuffix: `${suffix}-1`,
      }));
      return id;
    }
    const revisionId = createEntityId("template-revision", `${suffix}-1`);
    setSessionTemplates((current) => [
      ...current,
      {
        kind: "decision",
        id,
        name,
        currentRevisionId: revisionId,
        revisions: [{
          id: revisionId,
          createdAt: new Date().toISOString(),
          decision: structuredClone(decision),
          variableDefaults: { ...defaults },
        }],
      },
    ]);
    return id;
  }
  function updateDecisionTemplateDraft(
    templateId: PromptTemplateId,
    sourceRevisionId: PromptTemplateRevisionId,
    decision: DecisionInput,
    defaults: Record<string, string>,
    revisionName?: string,
  ): void {
    if (sessionTemplateIds.has(templateId)) {
      setSessionTemplates((current) => current.map((entry) =>
        entry.id !== templateId || entry.kind !== "decision"
          ? entry
          : {
              ...entry,
              draft: {
                sourceRevisionId,
                decision: structuredClone(decision),
                variableDefaults: { ...defaults },
                revisionName,
              },
            },
      ));
      return;
    }
    adoptAuthoredProject(updateDecisionPromptTemplateDraft(input.ensureProjectDocument(), {
      templateId,
      sourceRevisionId,
      decision,
      variableDefaults: defaults,
      revisionName,
    }));
  }
  function saveDecisionTemplateForUse(
    templateId: PromptTemplateId,
    name: string,
    decision: DecisionInput,
    defaults: Record<string, string>,
    revisionName?: string,
  ): { project: ProjectFile; revisionId: PromptTemplateRevisionId } | undefined {
    let project: ProjectFile;
    try {
      project = input.ensureProjectDocument();
    } catch {
      return reportSessionProjectRequirement();
    }
    const sessionTemplate = sessionTemplates.find((entry) => entry.id === templateId);
    if (sessionTemplate?.kind === "decision") {
      project = materializeSessionDecisionTemplate(project, sessionTemplate, {
        name,
        decision,
        variableDefaults: defaults,
        revisionName,
      });
      finishSessionTemplate(templateId);
    } else {
      project = renamePromptTemplate(project, templateId, name.trim());
      project = appendDecisionPromptTemplateRevision(project, {
        templateId,
        decision,
        variableDefaults: defaults,
        name: revisionName,
      });
    }
    adoptAuthoredProject(project);
    decisionEditorMemory.delete(templateId);
    return { project, revisionId: project.promptTemplates.find(({ id }) => id === templateId)!.currentRevisionId };
  }
  function createProjectTemplate(name: string, messages: PromptTemplateMessages): PromptTemplateId {
    const suffix = randomUUID();
    if (!input.projectFile) {
      const id = createEntityId("template", suffix);
      const revisionId = createEntityId("template-revision", `${suffix}-1`);
      setSessionTemplates((current) => [
        ...current,
        {
          id,
          kind: "chat",
          name,
          currentRevisionId: revisionId,
          revisions: [{
            id: revisionId,
            createdAt: new Date().toISOString(),
            messages: structuredClone(messages),
            variableDefaults: {},
          }],
        },
      ]);
      return id;
    }
    adoptAuthoredProject(createPromptTemplate(input.ensureProjectDocument(), { name, messages, idSuffix: suffix, revisionIdSuffix: `${suffix}-1` }));
    return createEntityId("template", suffix);
  }
  function updateProjectTemplateDraft(templateId: PromptTemplateId, sourceRevisionId: PromptTemplateRevisionId, messages: PromptTemplateMessages, defaults: Record<string, string>, revisionName?: string): void {
    if (sessionTemplateIds.has(templateId)) {
      setSessionTemplates((current) => current.map((template) =>
        template.id !== templateId || template.kind !== "chat"
          ? template
          : {
              ...template,
              revisions: template.revisions.map((revision) =>
                revision.id !== sourceRevisionId
                  ? revision
                  : {
                      ...revision,
                      ...(revisionName ? { name: revisionName } : { name: undefined }),
                      messages: structuredClone(messages),
                      variableDefaults: { ...defaults },
                    },
              ),
            },
      ));
      return;
    }
    adoptAuthoredProject(updatePromptTemplateDraft(input.ensureProjectDocument(), {
      templateId,
      sourceRevisionId,
      revisionName,
      messages,
      variableDefaults: defaults,
    }));
  }
  function updateProjectTemplateRecommendedTarget(templateId: PromptTemplateId, recommendedTarget?: PromptTemplateRecommendedTarget): void {
    if (sessionTemplateIds.has(templateId)) {
      setSessionTemplates((current) => current.map((template) =>
        template.id === templateId
          ? {
              ...template,
              ...(recommendedTarget
                ? { recommendedTarget }
                : { recommendedTarget: undefined }),
            }
          : template,
      ));
      return;
    }
    adoptAuthoredProject(setPromptTemplateRecommendedTarget(input.ensureProjectDocument(), templateId, recommendedTarget));
  }
  function reportSessionProjectRequirement(): undefined {
    const message = "Set a valid endpoint and model to save this prompt to a project. Your session draft is still here.";
    input.markProjectError(message);
    input.onSessionPromptNeedsProject(message);
    return undefined;
  }
  function materializeSessionTemplate(
    templateId: PromptTemplateId,
    name: string,
    messages: PromptTemplateMessages,
    defaults: Record<string, string>,
    recommendedTarget?: PromptTemplateRecommendedTarget,
    revisionName?: string,
  ): { project: ProjectFile; revisionId: PromptTemplateRevisionId } | undefined {
    const sessionTemplate = sessionTemplates.find((entry): entry is ChatPromptTemplate => entry.id === templateId && entry.kind === "chat");
    if (!sessionTemplate) return undefined;
    let project: ProjectFile;
    try {
      project = input.ensureProjectDocument();
    } catch {
      return reportSessionProjectRequirement();
    }
    const suffix = templateId.replace(/^template_/, "");
    const revisionSuffix = sessionTemplate.currentRevisionId.replace(/^template-revision_/, "");
    project = createPromptTemplate(project, {
      name,
      messages,
      variableDefaults: defaults,
      recommendedTarget,
      idSuffix: suffix,
      revisionIdSuffix: revisionSuffix,
    });
    if (revisionName) {
      project = {
        ...project,
        promptTemplates: project.promptTemplates.map((template) =>
          template.id === templateId && template.kind === "chat"
            ? {
                ...template,
                revisions: template.revisions.map((revision) =>
                  revision.id === sessionTemplate.currentRevisionId
                    ? { ...revision, name: revisionName }
                    : revision,
                ),
              }
            : template,
        ),
      };
    }
    return { project, revisionId: sessionTemplate.currentRevisionId };
  }
  function finishSessionTemplate(templateId: PromptTemplateId): void {
    setSessionTemplates((current) => current.filter(({ id }) => id !== templateId));
  }
  function saveProjectTemplate(templateId: PromptTemplateId, name: string, messages: PromptTemplateMessages, defaults: Record<string, string>, recommendedTarget?: PromptTemplateRecommendedTarget, revisionName?: string): PromptTemplateRevisionId | undefined {
    if (sessionTemplateIds.has(templateId)) {
      const materialized = materializeSessionTemplate(
        templateId,
        name,
        messages,
        defaults,
        recommendedTarget,
        revisionName,
      );
      if (!materialized) return undefined;
      adoptAuthoredProject(materialized.project);
      finishSessionTemplate(templateId);
      return materialized.revisionId;
    }
    let next = renamePromptTemplate(input.ensureProjectDocument(), templateId, name);
    next = setPromptTemplateRecommendedTarget(next, templateId, recommendedTarget);
    next = appendPromptTemplateRevision(next, { templateId, messages, variableDefaults: defaults, name: revisionName });
    adoptAuthoredProject(next);
    return next.promptTemplates.find(({ id }) => id === templateId)!.currentRevisionId;
  }
  function saveAndInsertProjectTemplate(templateId: PromptTemplateId, name: string, messages: PromptTemplateMessages, defaults: Record<string, string>, recommendedTarget: PromptTemplateRecommendedTarget | undefined, revisionName: string | undefined, itemIndex: number): PromptTemplateRevisionId | undefined {
    if (sessionTemplateIds.has(templateId)) {
      const materialized = materializeSessionTemplate(
        templateId,
        name,
        messages,
        defaults,
        recommendedTarget,
        revisionName,
      );
      if (!materialized) return undefined;
      const revision = materialized.project.conversationRevisions.find(
        ({ id }) => id === materialized.project.defaults.conversationRevisionId,
      )!;
      const next = insertPromptTemplateUse(materialized.project, {
        conversationRevisionId: revision.id,
        templateId,
        itemIndex,
      });
      adoptAuthoredProject(next);
      finishSessionTemplate(templateId);
      return materialized.revisionId;
    }
    const { project, revisionId: conversationRevisionId } = projectForUseMutation();
    let next = renamePromptTemplate(project, templateId, name);
    next = setPromptTemplateRecommendedTarget(next, templateId, recommendedTarget);
    next = appendPromptTemplateRevision(next, {
      templateId,
      messages,
      variableDefaults: defaults,
      name: revisionName,
    });
    const templateRevisionId = next.promptTemplates.find(
      ({ id }) => id === templateId,
    )!.currentRevisionId;
    next = insertPromptTemplateUse(next, {
      conversationRevisionId,
      templateId,
      itemIndex,
    });
    adoptAuthoredProject(next);
    return templateRevisionId;
  }
  // Renaming is committed on its own, decoupled from "Save template", so that
  // editing just the name (the most common one-field edit) persists without
  // requiring the explicit save affordance that also mints a new revision.
  function renameProjectTemplate(templateId: PromptTemplateId, name: string): boolean {
    const trimmed = name.trim();
    if (!trimmed) return false;
    if (sessionTemplateIds.has(templateId)) {
      setSessionTemplates((current) => current.map((template) =>
        template.id === templateId ? { ...template, name: trimmed } : template,
      ));
      return true;
    }
    const project = input.ensureProjectDocument();
    const template = project.promptTemplates.find(({ id }) => id === templateId);
    if (!template || template.name === trimmed) return true;
    adoptAuthoredProject(renamePromptTemplate(project, templateId, trimmed));
    return true;
  }
  function renameProjectTemplateRevision(
    templateId: PromptTemplateId,
    revisionId: PromptTemplateRevisionId,
    name: string,
  ): void {
    // Session prompts expose no saved revisions to relabel.
    if (sessionTemplateIds.has(templateId)) return;
    const project = input.ensureProjectDocument();
    const next = renamePromptTemplateRevision(project, templateId, revisionId, name);
    if (next !== project) adoptAuthoredProject(next);
  }
  function archiveProjectTemplate(templateId: PromptTemplateId, onArchived?: () => void): void {
    const project = input.ensureProjectDocument();
    const template = project.promptTemplates.find(({ id }) => id === templateId);
    if (!template || template.archivedAt) return;
    const usageCount = findPromptTemplateUsages(project, templateId).length;
    input.requestConfirmation({
      title: `Archive "${template.name}"?`,
      description: "It will move to Archived and cannot be added to new requests. Existing pinned uses and saved traces will keep working.",
      confirmLabel: "Archive template",
      details: [
        { label: "Revisions retained", value: String(template.revisions.length) },
        { label: "Existing uses retained", value: String(usageCount) },
      ],
      onConfirm() {
        adoptAuthoredProject(archivePromptTemplate(input.ensureProjectDocument(), templateId));
        onArchived?.();
      },
    });
  }
  function restoreProjectTemplate(templateId: PromptTemplateId): void {
    adoptAuthoredProject(restorePromptTemplate(input.ensureProjectDocument(), templateId));
  }
  function insertProjectTemplate(
    templateId: PromptTemplateId,
    templateRevisionId: PromptTemplateRevisionId,
    itemIndex: number,
    replaceEmptyDraft = false,
  ): void {
    const { project, revisionId } = projectForUseMutation();
    adoptAuthoredProject(insertPromptTemplateUse(project, {
      conversationRevisionId: revisionId,
      templateId,
      templateRevisionId,
      itemIndex,
      replaceEmptyDraft,
    }));
  }
  function updateTemplateUseValues(templateUseId: PromptTemplateUseId, values: Record<string, string>): void {
    const { project, revisionId } = projectForUseMutation();
    adoptAuthoredProject(updatePromptTemplateUseValues(project, { conversationRevisionId: revisionId, templateUseId, values }));
  }
  function updateTemplateUseOverride(templateUseId: PromptTemplateUseId, values: Record<string, string>): void {
    const overrides = templateRunOverridesAfterUpdate(templateRunOverrides, templateUseId, values);
    setTemplateRunOverrides(overrides);
    if (input.projectFile) input.replaceProjectDraft(projectDraft(input.projectFile, contextFor(input.projectFile, overrides)));
  }
  function saveTemplateUseRunValue(templateUseId: PromptTemplateUseId, values: Record<string, string>, useOverrides: Record<string, string>): void {
    const { project, revisionId } = projectForUseMutation();
    const next = updatePromptTemplateUseValues(project, { conversationRevisionId: revisionId, templateUseId, values });
    const overrides = templateRunOverridesAfterSave(templateRunOverrides, templateUseId, useOverrides);
    setTemplateRunOverrides(overrides);
    adoptAuthoredProject(next, overrides);
  }
  function mutateAuthoredItems(update: (items: ProjectConversationItem[]) => ProjectConversationItem[]): void {
    if (input.branchParentRevisionId) {
      if (!input.projectFile) return;
      try { input.resetMessages(pendingBranchMessagesAfterItemUpdate({ project: input.projectFile, messages: input.messages, resolutionContext, parentRevisionId: input.branchParentRevisionId, update })); input.markProjectError(undefined); }
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
  function setTemplateUseRevision(templateUseId: PromptTemplateUseId, templateRevisionId: PromptTemplateRevisionId): void {
    const { project, revisionId } = projectForUseMutation();
    const item = project.conversationRevisions.find(({ id }) => id === revisionId)!.items.find((candidate) => candidate.kind === "template-use" && candidate.use.id === templateUseId);
    if (!item || item.kind !== "template-use") return;
    const template = project.promptTemplates.find(({ id }) => id === item.use.templateId)!;
    if (template.kind !== "chat") return;
    const target = template.revisions.find(({ id }) => id === templateRevisionId);
    if (!target) return;
    const count = target.messages.length;
    const next = updatePromptTemplateUseRevision(project, { conversationRevisionId: revisionId, templateUseId, templateRevisionId, newOutputMessageIdSuffixes: Array.from({ length: Math.max(0, count - item.use.outputMessageIds.length) }, () => randomUUID()) });
    const overrides = templateRunOverridesAfterRevisionUpdate(templateRunOverrides, templateUseId, target.messages);
    setTemplateRunOverrides(overrides);
    adoptAuthoredProject(next, overrides);
  }
  function detachTemplateUse(templateUseId: PromptTemplateUseId): void {
    input.requestConfirmation({
      title: "Detach this template use?",
      description: "Its currently resolved values, including run-only overrides, will become ordinary literal messages with the same message IDs.",
      confirmLabel: "Detach",
      onConfirm() {
        try {
          const { project, revisionId } = projectForUseMutation();
          const next = detachPromptTemplateUse(project, {
            conversationRevisionId: revisionId,
            templateUseId,
            resolutionContext: contextFor(project),
          });
          const overrides = { ...templateRunOverrides };
          delete overrides[templateUseId];
          setTemplateRunOverrides(overrides);
          adoptAuthoredProject(next, overrides);
        } catch (error) {
          input.markProjectError(
            error instanceof Error
              ? error.message
              : "Could not detach this template use.",
          );
        }
      },
    });
  }
  function removeTemplateUse(templateUseId: PromptTemplateUseId): void { input.requestConfirmation({ title: "Remove this template use?", description: "The pinned use and all messages it generates will be removed from this conversation revision.", confirmLabel: "Remove use", destructive: true, onConfirm() { const { project, revisionId } = projectForUseMutation(); const next = removePromptTemplateUse(project, revisionId, templateUseId); const overrides = { ...templateRunOverrides }; delete overrides[templateUseId]; setTemplateRunOverrides(overrides); adoptAuthoredProject(next, overrides); } }); }
  async function importN8nPrompt(candidate: ExternalPromptCandidate, mode: "resolved-snapshot" | "reusable-template", { recommendModel }: { recommendModel: boolean }): Promise<void> {
    const imported = mode === "reusable-template" ? await importExternalPromptTemplateCandidate(input.ensureProjectDocument(), candidate, { recommendModel }) : await importExternalPromptCandidate(input.ensureProjectDocument(), candidate);
    input.adoptProjectMutation(imported.project); input.replaceProjectDraft(projectDraft(imported.project, contextFor(imported.project, {}))); setTemplateRunOverrides({}); input.clearPendingBranch(); input.onImportApplied();
    const receipt = imported.project.externalImports.find(({ id }) => id === imported.externalImportId);
    input.onImported({ name: candidate.invocation.name, variableCount: receipt?.projection.kind === "prompt-template" ? receipt.projection.variables.length : 0, template: mode === "reusable-template" });
  }
  return {
    modelWarnings,
    decisionEditorMemory,
    captureDecisionTemplate: (name, decision, defaults) => createDecisionTemplate(name, decision, defaults, true),
    createDecisionTemplate,
    updateDecisionTemplateDraft,
    saveDecisionTemplate: (...args) => saveDecisionTemplateForUse(...args)?.revisionId,
    saveDecisionTemplateForUse,
    libraryTemplates,
    sessionTemplateIds,
    templateWorkbench,
    activeProjectRevision,
    activeConnectionRequirement,
    templateUsageCounts,
    templateRunOverrides,
    resolutionContext,
    applyEnvironment,
    createProjectTemplate,
    updateProjectTemplateDraft,
    updateProjectTemplateRecommendedTarget,
    saveProjectTemplate,
    saveAndInsertProjectTemplate,
    renameProjectTemplate,
    renameProjectTemplateRevision,
    archiveProjectTemplate,
    restoreProjectTemplate,
    insertProjectTemplate,
    updateTemplateUseValues,
    saveTemplateUseRunValue,
    updateTemplateUseOverride,
    setTemplateUseRevision,
    detachTemplateUse,
    removeTemplateUse,
    addComposerMessage,
    updateComposerMessage,
    removeComposerMessage,
    importN8nPrompt,
    clearTransientOverrides: () => { setTemplateRunOverrides({}); decisionEditorMemory.clear(); },
    markExecutedRevision: (id) => executedRevisionIdsRef.current.add(id),
  };

}
