"use client";

import { useMemo, useState } from "react";
import type { CheckDefinition, CheckKind } from "../../packages/core/src/checks";
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
  error?: string;
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
  addCheck(caseId: EvaluationCaseId, kind: CheckKind): void;
  updateCheck(caseId: EvaluationCaseId, check: CheckDefinition): void;
  deleteCheck(caseId: EvaluationCaseId, checkId: CheckId): void;
}

export function useEvaluationSuiteAuthoring(
  project: ProjectFile | null,
  adoptProjectMutation: (project: ProjectFile) => void,
  requestConfirmation?: (request: ConfirmationDialogRequest) => void,
): EvaluationSuiteAuthoringHandle {
  const [suiteId, setSuiteId] = useState<EvaluationSuiteId>();
  const [revisionId, setRevisionId] = useState<ConversationRevisionId>();
  const [selectedCaseIds, setSelectedCaseIds] = useState<Set<EvaluationCaseId>>(new Set());
  const [focusedCaseId, setFocusedCaseId] = useState<EvaluationCaseId>();
  const [repetitions, setRepetitionsState] = useState(1);
  const [error, setError] = useState<string>();

  const effectiveSuiteId = project?.evaluationSuites.some(({ id }) => id === suiteId)
    ? suiteId
    : project?.evaluationSuites[0]?.id;
  const effectiveRevisionId = project?.conversationRevisions.some(({ id }) => id === revisionId)
    ? revisionId
    : project?.defaults.conversationRevisionId;
  const suite = project?.evaluationSuites.find(({ id }) => id === effectiveSuiteId);
  const validCaseIds = new Set(suite?.cases.map(({ id }) => id) ?? []);
  const effectiveSelectedCaseIds = new Set(
    [...selectedCaseIds].filter((id) => validCaseIds.has(id)),
  );
  const effectiveFocusedCaseId = focusedCaseId && validCaseIds.has(focusedCaseId)
    ? focusedCaseId
    : suite?.cases[0]?.id;

  function commit(update: (current: ProjectFile) => ProjectFile): void {
    if (!project) return;
    try {
      adoptProjectMutation(update(project));
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update the evaluation suite.");
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
    selectSuite(id) { setSuiteId(id); setFocusedCaseId(undefined); setSelectedCaseIds(new Set()); },
    selectRevision: setRevisionId,
    setCaseSelected(id, selected) {
      setSelectedCaseIds((current) => {
        const next = new Set(current);
        if (selected) next.add(id); else next.delete(id);
        return next;
      });
    },
    focusCase: setFocusedCaseId,
    setRepetitions(value) { setRepetitionsState(Math.max(1, Math.min(100, Math.floor(value) || 1))); },
    createSuite() {
      if (!project) return;
      const created = createEvaluationSuite(project);
      adoptProjectMutation(created.project);
      setSuiteId(created.suiteId);
      setSelectedCaseIds(new Set());
      setFocusedCaseId(undefined);
      setError(undefined);
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
        setSelectedCaseIds((current) => new Set(current).add(added.caseId));
        setError(undefined);
      } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not add the case."); }
    },
    updateCase(id, patch) { if (effectiveSuiteId) commit((current) => updateEvaluationCase(current, effectiveSuiteId, id, patch)); },
    deleteCase(id) {
      if (!effectiveSuiteId) return;
      const evaluationCase = suite?.cases.find(({ id: candidateId }) => candidateId === id);
      const remove = () => commit((current) => removeEvaluationCase(current, effectiveSuiteId, id));
      confirmOrRun({ title: `Delete “${evaluationCase?.name ?? "case"}”?`, description: "Its values, reference answer, and deterministic checks will be removed.", confirmLabel: "Delete case", destructive: true }, remove);
    },
    addCheck(caseId, kind) { if (effectiveSuiteId) commit((current) => addEvaluationCheck(current, effectiveSuiteId, caseId, kind)); },
    updateCheck(caseId, check) { if (effectiveSuiteId) commit((current) => updateEvaluationCheck(current, effectiveSuiteId, caseId, check)); },
    deleteCheck(caseId, checkId) { if (effectiveSuiteId) commit((current) => removeEvaluationCheck(current, effectiveSuiteId, caseId, checkId)); },
  };
}
