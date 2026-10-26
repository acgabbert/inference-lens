"use client";

import { useEffect, useRef, useState } from "react";
import type { DecisionInput, DecisionQuestionType } from "../../packages/core/src/decision";
import { discoverDecisionVariables } from "../../packages/core/src/decision-variables";
import { DECISION_EXAMPLE } from "./decision-example";
import {
  addDecisionOption,
  addDecisionQuestion,
  changeDecisionQuestionType,
  createDecisionDraft,
  decisionDraftFromInput,
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
  /** One value per template variable (D40); key presence is significant. */
  values: Readonly<Record<string, string>>;
  /**
   * The variables the draft uses, in first-use order. While the draft does not
   * validate, the names that already hold a value, so none disappears mid-edit.
   */
  variables: string[];
  /**
   * The user has edited this draft, or it came from a project. An untouched
   * starting draft is never written into a project (D43).
   */
  touched: boolean;
  /** Replaces the draft with a saved request, which counts as touched. */
  adopt(input: DecisionInput, values: Readonly<Record<string, string>>): void;
  /** Back to the untouched starting draft. */
  reset(): void;
  /** Replaces the draft with the worked example; an edit, so it is saved like one. */
  loadExample(): void;
  setValue(name: string, value: string): void;
  /** Removes the value, leaving the variable unfilled rather than empty. */
  clearValue(name: string): void;
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

/** The draft state an editor can set aside and later resume from. */
export interface DecisionDraftSnapshot {
  draft: DecisionDraft;
  values: Record<string, string>;
  touched: boolean;
}

/**
 * The decision kind's editor draft (D18, D29). Held above any conditional pane
 * mount, so switching kinds or views never loses it (D17).
 *
 * A library editor instead resumes from `initial` and hears every committed
 * change through `onSnapshot`, which may be a new function on each render.
 */
export function useDecisionDraft(
  options: {
    onEdited?(): void;
    initial?: DecisionDraftSnapshot;
    onSnapshot?(snapshot: DecisionDraftSnapshot): void;
  } = {},
): DecisionDraftHandle {
  const [draft, setDraft] = useState<DecisionDraft>(() => options.initial?.draft ?? createDecisionDraft());
  const [values, setValues] = useState<Record<string, string>>(options.initial?.values ?? {});
  const [touched, setTouched] = useState(options.initial?.touched ?? false);
  const [viewProblems, setViewProblems] = useState<DecisionDraftProblem[]>([]);

  // Report changes to the draft itself, through whichever callback is
  // current, rather than on every render of the owner.
  const onSnapshotRef = useRef(options.onSnapshot);
  useEffect(() => {
    onSnapshotRef.current = options.onSnapshot;
  });
  useEffect(() => {
    onSnapshotRef.current?.({ draft, values, touched });
  }, [draft, values, touched]);

  function edit(update: (current: DecisionDraft) => DecisionDraft): void {
    setViewProblems([]);
    setDraft(update);
    setTouched(true);
    options.onEdited?.();
  }

  const validated = validateDecisionDraft(draft);
  const variables = "input" in validated
    ? discoverDecisionVariables(validated.input).variables
    : Object.keys(values);

  return {
    draft,
    values,
    variables,
    touched,
    viewProblems,
    validated: () => validated,
    adopt(input, adopted) {
      setViewProblems([]);
      setDraft(decisionDraftFromInput(input));
      setValues({ ...adopted });
      setTouched(true);
    },
    reset() {
      setViewProblems([]);
      setDraft(createDecisionDraft());
      setValues({});
      setTouched(false);
    },
    loadExample() {
      setValues({});
      edit(() => decisionDraftFromInput(DECISION_EXAMPLE));
    },
    clearValue(name) {
      setValues((current) => {
        const next = { ...current };
        delete next[name];
        return next;
      });
      setTouched(true);
      options.onEdited?.();
    },
    setValue(name, value) {
      setValues((current) => ({ ...current, [name]: value }));
      setTouched(true);
      options.onEdited?.();
    },
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
