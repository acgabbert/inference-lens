"use client";

import { useMemo, useState } from "react";
import type { CheckDefinition } from "../../packages/core/src/checks";
import {
  addEvaluationCase,
  addEvaluationCheck,
  addEvaluationInput,
  createEvaluationSuite,
  evaluationBindingCandidates,
  evaluationSuitePreflight,
  removeEvaluationCase,
  removeEvaluationCheck,
  removeEvaluationInput,
  removeEvaluationSuite,
  renameEvaluationInput,
  renameEvaluationSuite,
  updateEvaluationCase,
  updateEvaluationCheck,
} from "../../packages/core/src/evaluation-suite-authoring";
import type { NewEvaluationCheck } from "../../packages/core/src/evaluation-suite-authoring";
import { ProjectValidationError } from "../../packages/core/src/project";
import type { ProjectFile } from "../../packages/core/src/project";
import type {
  CheckId,
  ConversationRevisionId,
  EvaluationCaseId,
  EvaluationInputBindingId,
  EvaluationSuiteId,
} from "../../packages/core/src/run-kernel";
import type { ConfirmationDialogRequest } from "../confirmation-dialog.client";

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
  selectSuite(id: EvaluationSuiteId): void;
  selectRevision(id: ConversationRevisionId): void;
  setCaseSelected(id: EvaluationCaseId, selected: boolean): void;
  focusCase(id: EvaluationCaseId): void;
  setRepetitions(value: number): void;
  createSuite(): void;
  renameSuite(name: string): void;
  deleteSuite(): void;
  addInput(candidate: ReturnType<typeof evaluationBindingCandidates>[number]): void;
  renameInput(id: EvaluationInputBindingId, name: string): void;
  deleteInput(id: EvaluationInputBindingId): void;
  addCase(): void;
  updateCase(id: EvaluationCaseId, patch: Parameters<typeof updateEvaluationCase>[3]): void;
  deleteCase(id: EvaluationCaseId): void;
  addCheck(caseId: EvaluationCaseId, input: NewEvaluationCheck): boolean;
  updateCheck(caseId: EvaluationCaseId, check: CheckDefinition, field: EvaluationCheckAuthoringField): boolean;
  deleteCheck(caseId: EvaluationCaseId, checkId: CheckId): void;
}

export type EvaluationSuiteAuthoringErrorTarget =
  | { kind: "check"; caseId: EvaluationCaseId; checkId: CheckId; field: EvaluationCheckAuthoringField }
  | { kind: "add-check"; caseId: EvaluationCaseId }
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

function mutationErrorMessage(cause: unknown): string {
  if (cause instanceof ProjectValidationError) {
    return cause.issues[0]?.message ?? "The evaluation suite change is invalid.";
  }
  return cause instanceof Error ? cause.message : "Could not update the evaluation suite.";
}

export function useEvaluationSuiteAuthoring(
  project: ProjectFile | null,
  adoptProjectMutation: (project: ProjectFile) => void,
  requestConfirmation?: (request: ConfirmationDialogRequest) => void,
): EvaluationSuiteAuthoringHandle {
  const [suiteId, setSuiteId] = useState<EvaluationSuiteId>();
  const [revisionId, setRevisionId] = useState<ConversationRevisionId>();
  // Undefined means "every case", so opening a saved suite previews the run the
  // author actually described rather than an empty selection they must repair.
  // It narrows to an explicit set the first time a checkbox is touched.
  const [selection, setSelection] = useState<ScopedCaseSelection>();
  const [focusedCaseId, setFocusedCaseId] = useState<EvaluationCaseId>();
  const [repetitions, setRepetitionsState] = useState(1);
  const [storedError, setStoredError] = useState<ScopedAuthoringError>();

  const effectiveSuiteId = project?.evaluationSuites.some(({ id }) => id === suiteId)
    ? suiteId
    : project?.evaluationSuites[0]?.id;
  const effectiveRevisionId = project?.conversationRevisions.some(({ id }) => id === revisionId)
    ? revisionId
    : project?.defaults.conversationRevisionId;
  const suite = project?.evaluationSuites.find(({ id }) => id === effectiveSuiteId);
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

  const candidates = useMemo(
    () => project && effectiveRevisionId
      ? evaluationBindingCandidates(project, effectiveRevisionId)
      : [],
    [effectiveRevisionId, project],
  );
  const diagnostics = project && effectiveSuiteId && effectiveRevisionId
    ? evaluationSuitePreflight(project, effectiveSuiteId, effectiveRevisionId, [...effectiveSelectedCaseIds])
    : [];

  return {
    project,
    ...(effectiveSuiteId ? { suiteId: effectiveSuiteId } : {}),
    ...(effectiveRevisionId ? { revisionId: effectiveRevisionId } : {}),
    selectedCaseIds: effectiveSelectedCaseIds,
    ...(effectiveFocusedCaseId ? { focusedCaseId: effectiveFocusedCaseId } : {}),
    repetitions,
    candidates,
    diagnostics,
    ...(error ? { error } : {}),
    selectSuite(id) { setSuiteId(id); setFocusedCaseId(undefined); setSelection(undefined); setStoredError(undefined); },
    selectRevision: setRevisionId,
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
    focusCase: setFocusedCaseId,
    setRepetitions(value) { setRepetitionsState(Math.max(1, Math.min(100, Math.floor(value) || 1))); },
    createSuite() {
      if (!project) return;
      const created = createEvaluationSuite(project);
      adoptProjectMutation(created.project);
      setSuiteId(created.suiteId);
      setSelection(undefined);
      setFocusedCaseId(undefined);
      setStoredError(undefined);
    },
    renameSuite(name) { if (effectiveSuiteId) commit((current) => renameEvaluationSuite(current, effectiveSuiteId, name)); },
    deleteSuite() {
      if (!effectiveSuiteId) return;
      const remove = () => commit((current) => removeEvaluationSuite(current, effectiveSuiteId));
      confirmOrRun({ title: `Delete “${suite?.name ?? "evaluation suite"}”?`, description: "Its cases, input bindings, and checks will be removed from the portable project.", confirmLabel: "Delete suite", destructive: true }, remove);
    },
    addInput(candidate) {
      if (effectiveSuiteId && candidate) commit((current) => addEvaluationInput(current, effectiveSuiteId, candidate).project);
    },
    renameInput(id, name) { if (effectiveSuiteId) commit((current) => renameEvaluationInput(current, effectiveSuiteId, id, name)); },
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
