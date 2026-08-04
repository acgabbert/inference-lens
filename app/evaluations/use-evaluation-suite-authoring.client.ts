"use client";

import { useMemo, useState } from "react";
import type { CheckDefinition } from "../../packages/core/src/checks";
import {
  addEvaluationCase,
  addEvaluationCheck,
  addEvaluationInput,
  createEvaluationSuite,
  createRevisionFromSavedPrompt,
  evaluationBindingCandidates,
  evaluationSuitePreflight,
  removeEvaluationCase,
  removeEvaluationCheck,
  removeEvaluationInput,
  removeEvaluationSuite,
  renameEvaluationInput,
  renameEvaluationSuite,
  savedPromptCandidates,
  updateEvaluationCase,
  updateEvaluationCheck,
  updateEvaluationSuiteExecution,
  updateEvaluationSuiteInput,
} from "../../packages/core/src/evaluation-suite-authoring";
import type {
  NewEvaluationCheck,
  SavedPromptCandidate,
} from "../../packages/core/src/evaluation-suite-authoring";
import { describeConversationRevisions } from "../../packages/core/src/conversation-revision-description";
import type { ConversationRevisionDescriptor } from "../../packages/core/src/conversation-revision-description";
import { resolveEvaluationCase } from "../../packages/core/src/evaluation-case-resolution";
import type { EvaluationCaseResolution } from "../../packages/core/src/evaluation-case-resolution";
import { ProjectValidationError } from "../../packages/core/src/project";
import type { EvaluationSuite, ProjectFile } from "../../packages/core/src/project";
import type {
  CheckId,
  ConversationRevisionId,
  EvaluationCaseId,
  EvaluationInputBindingId,
  EvaluationSuiteId,
  PromptTemplateId,
  ToolId,
} from "../../packages/core/src/run-kernel";
import { normalizedTurnCeiling } from "../../packages/core/src/turn-ceiling";
import type { ConfirmationDialogRequest } from "../confirmation-dialog.client";

/** A concise, dismissible confirmation that a project mutation landed. */
export interface EvaluationAuthoringNotice {
  kind: "saved-prompt-revision";
  templateName: string;
  messageCount: number;
  variableCount: number;
}

export interface EvaluationSuiteAuthoringHandle {
  project: ProjectFile | null;
  suiteId?: EvaluationSuiteId;
  revisionId?: ConversationRevisionId;
  selectedCaseIds: ReadonlySet<EvaluationCaseId>;
  focusedCaseId?: EvaluationCaseId;
  repetitions: number;
  candidates: ReturnType<typeof evaluationBindingCandidates>;
  diagnostics: ReturnType<typeof evaluationSuitePreflight>;
  error?: EvaluationSuiteAuthoringError;
  /** Every revision, described against the selected suite's exact bindings. */
  revisionChoices: ConversationRevisionDescriptor[];
  selectedRevision?: ConversationRevisionDescriptor;
  /** The exact resolved input the focused case would snapshot. */
  focusedCaseResolution?: EvaluationCaseResolution;
  savedPromptCandidates: SavedPromptCandidate[];
  savedPromptPickerOpen: boolean;
  savedPromptError?: string;
  notice?: EvaluationAuthoringNotice;
  openSavedPromptPicker(): void;
  closeSavedPromptPicker(): void;
  /**
   * Authors a prompt-only revision from an active saved prompt and selects it
   * for this evaluation. Returns false and reports a local error when the
   * project mutation is rejected.
   */
  startFromSavedPrompt(templateId: PromptTemplateId): boolean;
  dismissNotice(): void;
  selectSuite(id: EvaluationSuiteId): void;
  selectRevision(id: ConversationRevisionId): void;
  setCaseSelected(id: EvaluationCaseId, selected: boolean): void;
  focusCase(id: EvaluationCaseId): void;
  setRepetitions(value: number): void;
  /** Exposes or withdraws one project tool for the selected suite. */
  setToolExposed(id: ToolId, exposed: boolean): void;
  /** Provider turns one repetition may spend; clamped to the supported range. */
  setTurnCeiling(value: number): void;
  updateExecution(execution: EvaluationSuite["execution"]): boolean;
  createSuite(): void;
  renameSuite(name: string): boolean;
  deleteSuite(): void;
  addInput(candidate: ReturnType<typeof evaluationBindingCandidates>[number]): void;
  renameInput(id: EvaluationInputBindingId, name: string): boolean;
  deleteInput(id: EvaluationInputBindingId): void;
  addCase(): void;
  renameCase(id: EvaluationCaseId, name: string): boolean;
  updateCase(id: EvaluationCaseId, patch: Parameters<typeof updateEvaluationCase>[3]): void;
  deleteCase(id: EvaluationCaseId): void;
  addCheck(caseId: EvaluationCaseId, input: NewEvaluationCheck): boolean;
  updateCheck(caseId: EvaluationCaseId, check: CheckDefinition, field: EvaluationCheckAuthoringField): boolean;
  deleteCheck(caseId: EvaluationCaseId, checkId: CheckId): void;
}

export type EvaluationSuiteAuthoringErrorTarget =
  | { kind: "check"; caseId: EvaluationCaseId; checkId: CheckId; field: EvaluationCheckAuthoringField }
  | { kind: "add-check"; caseId: EvaluationCaseId }
  | { kind: "suite-name" }
  | { kind: "input-name"; inputId: EvaluationInputBindingId }
  | { kind: "case-name"; caseId: EvaluationCaseId }
  | { kind: "editor" };

export type EvaluationCheckAuthoringField =
  | "label"
  | "expected-text"
  | "pattern"
  | "flags"
  | "case-sensitive"
  | "trim-whitespace"
  | "negate"
  | "top-level"
  | "limit";

export interface EvaluationSuiteAuthoringError {
  message: string;
  target: EvaluationSuiteAuthoringErrorTarget;
}

interface ScopedCaseSelection {
  projectId: ProjectFile["projectId"];
  suiteId: EvaluationSuiteId;
  caseIds: ReadonlySet<EvaluationCaseId>;
}

interface ScopedAuthoringError extends EvaluationSuiteAuthoringError {
  projectId: ProjectFile["projectId"];
  suiteId: EvaluationSuiteId;
}

/**
 * Authoring a revision is a project-level mutation that does not require a
 * suite, so its error and its success notice are scoped to the project rather
 * than to the selected suite.
 */
interface ScopedProjectMessage {
  projectId: ProjectFile["projectId"];
  message: string;
}

interface ScopedNotice {
  projectId: ProjectFile["projectId"];
  notice: EvaluationAuthoringNotice;
}

function mutationErrorMessage(cause: unknown): string {
  if (cause instanceof ProjectValidationError) {
    return cause.issues[0]?.message ?? "The evaluation suite change is invalid.";
  }
  return cause instanceof Error ? cause.message : "Could not update the evaluation suite.";
}

export interface UseEvaluationSuiteAuthoringInput {
  project: ProjectFile | null;
  adoptProjectMutation(project: ProjectFile): void;
  requestConfirmation?(request: ConfirmationDialogRequest): void;
  /**
   * Fires when authoring points at a different suite, revision, or case, so
   * the route can release a finished execution that no longer describes what
   * the editor is showing. Selection changes only — editing a field the
   * current target already owns is not a re-target.
   */
  onRetarget?(): void;
}

export function useEvaluationSuiteAuthoring({
  project,
  adoptProjectMutation,
  requestConfirmation,
  onRetarget,
}: UseEvaluationSuiteAuthoringInput): EvaluationSuiteAuthoringHandle {
  const [suiteId, setSuiteId] = useState<EvaluationSuiteId>();
  // Undefined means "every case", so opening a saved suite previews the run the
  // author actually described rather than an empty selection they must repair.
  // It narrows to an explicit set the first time a checkbox is touched.
  const [selection, setSelection] = useState<ScopedCaseSelection>();
  const [focusedCaseId, setFocusedCaseId] = useState<EvaluationCaseId>();
  const [storedError, setStoredError] = useState<ScopedAuthoringError>();
  const [savedPromptPickerOpen, setSavedPromptPickerOpen] = useState(false);
  const [storedPromptError, setStoredPromptError] = useState<ScopedProjectMessage>();
  const [storedNotice, setStoredNotice] = useState<ScopedNotice>();

  const effectiveSuiteId = project?.evaluationSuites.some(({ id }) => id === suiteId)
    ? suiteId
    : project?.evaluationSuites[0]?.id;
  const suite = project?.evaluationSuites.find(({ id }) => id === effectiveSuiteId);
  const effectiveRevisionId = suite?.input.conversationRevisionId;
  const validCaseIds = new Set(suite?.cases.map(({ id }) => id) ?? []);
  const explicitSelection = selection &&
    selection.projectId === project?.projectId &&
    selection.suiteId === effectiveSuiteId
    ? selection.caseIds
    : undefined;
  const effectiveSelectedCaseIds = explicitSelection
    ? new Set([...explicitSelection].filter((id) => validCaseIds.has(id)))
    : validCaseIds;
  const effectiveFocusedCaseId = focusedCaseId && validCaseIds.has(focusedCaseId)
    ? focusedCaseId
    : suite?.cases[0]?.id;

  const error = storedError &&
    storedError.projectId === project?.projectId &&
    storedError.suiteId === effectiveSuiteId
    ? storedError
    : undefined;

  function commit(
    update: (current: ProjectFile) => ProjectFile,
    target: EvaluationSuiteAuthoringErrorTarget = { kind: "editor" },
  ): boolean {
    if (!project || !effectiveSuiteId) return false;
    try {
      adoptProjectMutation(update(project));
      setStoredError(undefined);
      return true;
    } catch (cause) {
      setStoredError({
        projectId: project.projectId,
        suiteId: effectiveSuiteId,
        target,
        message: mutationErrorMessage(cause),
      });
      return false;
    }
  }

  function confirmOrRun(
    request: Omit<ConfirmationDialogRequest, "onConfirm">,
    run: () => void,
  ): void {
    if (requestConfirmation) requestConfirmation({ ...request, onConfirm: run });
    else run();
  }

  const candidates = project && effectiveRevisionId
    ? evaluationBindingCandidates(project, effectiveRevisionId)
    : [];
  const diagnostics = project && effectiveSuiteId && effectiveRevisionId
    ? evaluationSuitePreflight(project, effectiveSuiteId, effectiveRevisionId, [...effectiveSelectedCaseIds])
    : [];

  const revisionChoices = useMemo(
    () => (project ? describeConversationRevisions(project, suite) : []),
    [project, suite],
  );
  const selectedRevision = revisionChoices.find(({ revisionId }) => revisionId === effectiveRevisionId);
  const promptCandidates = useMemo(
    () => (project ? savedPromptCandidates(project) : []),
    [project],
  );

  const focusedCase = suite?.cases.find(({ id }) => id === effectiveFocusedCaseId);
  const selectedRevisionDocument = project?.conversationRevisions.find(
    ({ id }) => id === effectiveRevisionId,
  );
  const focusedCaseResolution = project && suite && selectedRevisionDocument && focusedCase
    ? resolveEvaluationCase(project, selectedRevisionDocument, suite, focusedCase)
    : undefined;

  // Both are discarded when the project changes, so a message never survives
  // into a document it does not describe.
  const savedPromptError = storedPromptError && storedPromptError.projectId === project?.projectId
    ? storedPromptError.message
    : undefined;
  const notice = storedNotice && storedNotice.projectId === project?.projectId
    ? storedNotice.notice
    : undefined;

  function startFromSavedPrompt(templateId: PromptTemplateId): boolean {
    if (!project || !effectiveSuiteId || !effectiveRevisionId) return false;
    const candidate = promptCandidates.find(({ templateId: id }) => id === templateId);
    try {
      const created = createRevisionFromSavedPrompt(project, {
        parentRevisionId: effectiveRevisionId,
        templateId,
      });
      const updated = updateEvaluationSuiteInput(
        created.project,
        effectiveSuiteId,
        created.conversationRevisionId,
      );
      adoptProjectMutation(updated);
      setStoredPromptError(undefined);
      setSavedPromptPickerOpen(false);
      setStoredNotice({
        projectId: project.projectId,
        notice: {
          kind: "saved-prompt-revision",
          templateName: candidate?.name ?? "Saved prompt",
          messageCount: candidate?.messageCount ?? 0,
          variableCount: candidate?.variables.length ?? 0,
        },
      });
      return true;
    } catch (cause) {
      setStoredPromptError({ projectId: project.projectId, message: mutationErrorMessage(cause) });
      return false;
    }
  }

  return {
    project,
    ...(effectiveSuiteId ? { suiteId: effectiveSuiteId } : {}),
    ...(effectiveRevisionId ? { revisionId: effectiveRevisionId } : {}),
    selectedCaseIds: effectiveSelectedCaseIds,
    ...(effectiveFocusedCaseId ? { focusedCaseId: effectiveFocusedCaseId } : {}),
    repetitions: suite?.execution.repetitions ?? 1,
    candidates,
    diagnostics,
    ...(error ? { error } : {}),
    revisionChoices,
    ...(selectedRevision ? { selectedRevision } : {}),
    ...(focusedCaseResolution ? { focusedCaseResolution } : {}),
    savedPromptCandidates: promptCandidates,
    savedPromptPickerOpen,
    ...(savedPromptError ? { savedPromptError } : {}),
    ...(notice ? { notice } : {}),
    openSavedPromptPicker() { setStoredPromptError(undefined); setSavedPromptPickerOpen(true); },
    closeSavedPromptPicker() { setSavedPromptPickerOpen(false); setStoredPromptError(undefined); },
    startFromSavedPrompt,
    dismissNotice() { setStoredNotice(undefined); },
    selectSuite(id) {
      if (id !== effectiveSuiteId) onRetarget?.();
      setSuiteId(id); setFocusedCaseId(undefined); setSelection(undefined); setStoredError(undefined);
    },
    selectRevision(id) {
      if (!effectiveSuiteId) return;
      if (id !== effectiveRevisionId) onRetarget?.();
      commit((current) => updateEvaluationSuiteInput(current, effectiveSuiteId, id));
      setStoredNotice(undefined);
    },
    setCaseSelected(id, selected) {
      if (!project || !effectiveSuiteId) return;
      setSelection((current) => {
        const currentIds = current?.projectId === project.projectId && current.suiteId === effectiveSuiteId
          ? current.caseIds
          : validCaseIds;
        const next = new Set(currentIds);
        if (selected) next.add(id); else next.delete(id);
        return { projectId: project.projectId, suiteId: effectiveSuiteId, caseIds: next };
      });
    },
    focusCase(id) {
      if (id !== effectiveFocusedCaseId) onRetarget?.();
      setFocusedCaseId(id);
    },
    setRepetitions(value) {
      if (!suite || !effectiveSuiteId) return;
      commit((current) => updateEvaluationSuiteExecution(current, effectiveSuiteId, {
        ...suite.execution,
        repetitions: value,
      }));
    },
    setToolExposed(id, exposed) {
      if (!suite || !effectiveSuiteId) return;
      const current = suite.execution.toolIds;
      if (exposed === current.includes(id)) return;
      commit((project) => updateEvaluationSuiteExecution(project, effectiveSuiteId, {
        ...suite.execution,
        toolIds: exposed
          ? [...current, id]
          : current.filter((toolId) => toolId !== id),
      }));
    },
    setTurnCeiling(value) {
      if (!suite || !effectiveSuiteId) return;
      commit((project) => updateEvaluationSuiteExecution(project, effectiveSuiteId, {
        ...suite.execution,
        turnCeiling: normalizedTurnCeiling(value),
      }));
    },
    updateExecution(execution) {
      return effectiveSuiteId
        ? commit((current) => updateEvaluationSuiteExecution(current, effectiveSuiteId, execution))
        : false;
    },
    createSuite() {
      if (!project) return;
      onRetarget?.();
      const created = createEvaluationSuite(project);
      adoptProjectMutation(created.project);
      setSuiteId(created.suiteId);
      setSelection(undefined);
      setFocusedCaseId(undefined);
      setStoredError(undefined);
    },
    renameSuite(name) {
      return effectiveSuiteId
        ? commit((current) => renameEvaluationSuite(current, effectiveSuiteId, name), { kind: "suite-name" })
        : false;
    },
    deleteSuite() {
      if (!effectiveSuiteId) return;
      const remove = () => {
        onRetarget?.();
        commit((current) => removeEvaluationSuite(current, effectiveSuiteId));
      };
      confirmOrRun({ title: `Delete “${suite?.name ?? "evaluation suite"}”?`, description: "Its cases, input bindings, and checks will be removed from the portable project.", confirmLabel: "Delete suite", destructive: true }, remove);
    },
    addInput(candidate) {
      if (effectiveSuiteId && candidate) commit((current) => addEvaluationInput(current, effectiveSuiteId, candidate).project);
    },
    renameInput(id, name) {
      return effectiveSuiteId
        ? commit((current) => renameEvaluationInput(current, effectiveSuiteId, id, name), { kind: "input-name", inputId: id })
        : false;
    },
    deleteInput(id) {
      if (!effectiveSuiteId) return;
      const binding = suite?.inputBindings.find(({ id: candidateId }) => candidateId === id);
      const remove = () => commit((current) => removeEvaluationInput(current, effectiveSuiteId, id));
      confirmOrRun({ title: `Remove “${binding?.name ?? "input"}”?`, description: "This removes the column and its value from every case in the suite.", confirmLabel: "Remove input", destructive: true }, remove);
    },
    addCase() {
      if (!effectiveSuiteId || !project) return;
      try {
        const added = addEvaluationCase(project, effectiveSuiteId);
        adoptProjectMutation(added.project);
        setFocusedCaseId(added.caseId);
        // A whole-suite selection already includes the new case.
        setSelection((current) => current && current.projectId === project.projectId && current.suiteId === effectiveSuiteId
          ? { ...current, caseIds: new Set(current.caseIds).add(added.caseId) }
          : current);
        setStoredError(undefined);
      } catch (cause) {
        setStoredError({ projectId: project.projectId, suiteId: effectiveSuiteId, target: { kind: "editor" }, message: mutationErrorMessage(cause) });
      }
    },
    renameCase(id, name) {
      return effectiveSuiteId
        ? commit((current) => updateEvaluationCase(current, effectiveSuiteId, id, { name }), { kind: "case-name", caseId: id })
        : false;
    },
    updateCase(id, patch) { if (effectiveSuiteId) commit((current) => updateEvaluationCase(current, effectiveSuiteId, id, patch)); },
    deleteCase(id) {
      if (!effectiveSuiteId) return;
      const evaluationCase = suite?.cases.find(({ id: candidateId }) => candidateId === id);
      const remove = () => commit((current) => removeEvaluationCase(current, effectiveSuiteId, id));
      confirmOrRun({ title: `Delete “${evaluationCase?.name ?? "case"}”?`, description: "Its values, reference answer, and deterministic checks will be removed.", confirmLabel: "Delete case", destructive: true }, remove);
    },
    addCheck(caseId, input) {
      return effectiveSuiteId
        ? commit((current) => addEvaluationCheck(current, effectiveSuiteId, caseId, input), { kind: "add-check", caseId })
        : false;
    },
    updateCheck(caseId, check, field) {
      return effectiveSuiteId
        ? commit((current) => updateEvaluationCheck(current, effectiveSuiteId, caseId, check), { kind: "check", caseId, checkId: check.checkId, field })
        : false;
    },
    deleteCheck(caseId, checkId) { if (effectiveSuiteId) commit((current) => removeEvaluationCheck(current, effectiveSuiteId, caseId, checkId)); },
  };
}
