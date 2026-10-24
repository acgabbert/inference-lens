"use client";

import { useState } from "react";
import type { DecisionInput, DecisionQuestionType } from "../../packages/core/src/decision";
import {
  addDecisionOption,
  addDecisionQuestion,
  changeDecisionQuestionType,
  createDecisionDraft,
  moveDecisionOption,
  moveDecisionQuestion,
  removeDecisionOption,
  removeDecisionQuestion,
  setDecisionJsonText,
  showDecisionFormView,
  showDecisionJsonView,
  updateDecisionOption,
  updateDecisionQuestion,
  validateDecisionDraft,
} from "./decision-draft";
import type { DecisionDraft, DecisionDraftProblem, DecisionOptionRow, DecisionQuestionRow } from "./decision-draft";

export interface DecisionDraftHandle {
  draft: DecisionDraft;
  /** Why the last view switch was refused; cleared by the next edit or switch. */
  viewProblems: DecisionDraftProblem[];
  /** Derived from the draft as it is now; never a retained last-valid input (D18). */
  validated(): { input: DecisionInput } | { problems: DecisionDraftProblem[] };
  showJson(): void;
  showForm(): void;
  setStateText(text: string): void;
  setStateMode(mode: DecisionDraft["state"]["mode"]): void;
  setJsonText(text: string): void;
  addQuestion(): void;
  removeQuestion(rowId: string): void;
  moveQuestion(rowId: string, toIndex: number): void;
  updateQuestion(rowId: string, patch: Partial<Pick<DecisionQuestionRow, "id" | "instructions" | "noul">>): void;
  changeType(rowId: string, type: DecisionQuestionType): void;
  addOption(rowId: string): void;
  updateOption(rowId: string, optionRowId: string, patch: Partial<Pick<DecisionOptionRow, "label" | "description">>): void;
  removeOption(rowId: string, optionRowId: string): void;
  moveOption(rowId: string, optionRowId: string, toIndex: number): void;
}

/**
 * The decision kind's editor draft (D18, D29). Held above any conditional pane
 * mount, so switching kinds or views never loses it (D17).
 */
export function useDecisionDraft(): DecisionDraftHandle {
  const [draft, setDraft] = useState<DecisionDraft>(() => createDecisionDraft());
  const [viewProblems, setViewProblems] = useState<DecisionDraftProblem[]>([]);

  function edit(update: (current: DecisionDraft) => DecisionDraft): void {
    setViewProblems([]);
    setDraft(update);
  }

  return {
    draft,
    viewProblems,
    validated: () => validateDecisionDraft(draft),
    showJson() {
      const result = showDecisionJsonView(draft);
      if ("problems" in result) { setViewProblems(result.problems); return; }
      setViewProblems([]);
      setDraft(result.draft);
    },
    showForm() {
      const result = showDecisionFormView(draft);
      setViewProblems("problems" in result ? result.problems : []);
      setDraft(result.draft);
    },
    setStateText: (text) => edit((current) => ({ ...current, state: { ...current.state, text } })),
    setStateMode: (mode) => edit((current) => ({ ...current, state: { ...current.state, mode } })),
    setJsonText: (text) => edit((current) => setDecisionJsonText(current, text)),
    addQuestion: () => edit((current) => addDecisionQuestion(current)),
    removeQuestion: (rowId) => edit((current) => removeDecisionQuestion(current, rowId)),
    moveQuestion: (rowId, toIndex) => edit((current) => moveDecisionQuestion(current, rowId, toIndex)),
    updateQuestion: (rowId, patch) => edit((current) => updateDecisionQuestion(current, rowId, patch)),
    changeType: (rowId, type) => edit((current) => changeDecisionQuestionType(current, rowId, type)),
    addOption: (rowId) => edit((current) => addDecisionOption(current, rowId)),
    updateOption: (rowId, optionRowId, patch) => edit((current) => updateDecisionOption(current, rowId, optionRowId, patch)),
    removeOption: (rowId, optionRowId) => edit((current) => removeDecisionOption(current, rowId, optionRowId)),
    moveOption: (rowId, optionRowId, toIndex) => edit((current) => moveDecisionOption(current, rowId, optionRowId, toIndex)),
  };
}
