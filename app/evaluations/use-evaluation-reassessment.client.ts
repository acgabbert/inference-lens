"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { CheckDefinition } from "../../packages/core/src/checks.ts";
import {
  EvaluationAssessmentError,
  createEvaluationAssessment,
  evaluationAssessmentCriteria,
} from "../../packages/core/src/evaluation-assessment.ts";
import type { EvaluationAssessmentV1 } from "../../packages/core/src/evaluation-assessment.ts";
import { diffEvaluationOutcomes } from "../../packages/core/src/evaluation-outcome-diff.ts";
import type { EvaluationOutcomeDiff } from "../../packages/core/src/evaluation-outcome-diff.ts";
import {
  currentSuiteCriteria,
  planSuiteAdoption,
} from "../../packages/core/src/evaluation-reassessment.ts";
import type { SuiteCriteriaCase } from "../../packages/core/src/evaluation-reassessment.ts";
import { updateEvaluationCheck } from "../../packages/core/src/evaluation-suite-authoring.ts";
import {
  evaluationParsedExperimentAggregate,
  parseExperimentPlanFile,
} from "../../packages/core/src/experiment.ts";
import type { EvaluationCriteriaOverride } from "../../packages/core/src/experiment.ts";
import type { ProjectFile } from "../../packages/core/src/project.ts";
import { randomUUID } from "../../packages/core/src/random-id.ts";
import { validateSafeRegex } from "../../packages/core/src/safe-regex.ts";
import { createEntityId } from "../../packages/core/src/run-kernel/types.ts";
import type {
  CheckId,
  EvaluationAssessmentId,
  EvaluationCaseId,
} from "../../packages/core/src/run-kernel/types.ts";
import {
  listEvaluationAssessmentsWorkspace,
  saveEvaluationAssessmentWorkspace,
} from "../project-workspace.client.ts";
import type { EvaluationExecution } from "./use-evaluation-execution-session.client.ts";

/**
 * Which reading of a finished execution is on screen.
 *
 * "As run" is not one interpretation among equals: it is the only one derived
 * from the execution's own snapshotted checks, and it is what the author saw
 * when the batch finished. Every other entry re-derives outcomes from evidence
 * that has not moved, which is why the selector is explicit and why the surface
 * says so persistently while a non-default one is chosen.
 */
export type EvaluationInterpretationId =
  | { kind: "as-run" }
  | { kind: "current-criteria" }
  | { kind: "assessment"; assessmentId: EvaluationAssessmentId };

export interface EvaluationInterpretation {
  /** Stable string form, so a `<select>` can carry it without a parser. */
  value: string;
  id: EvaluationInterpretationId;
  name: string;
  /** Undefined for As run: the plan's own checks are the absence of an override. */
  criteria?: EvaluationCriteriaOverride;
  /** Never-persisted readings say so wherever they are offered. */
  preview: boolean;
}

/** One regex check the drawer can correct, joined to the case it belongs to. */
export interface ReassessmentRegexCheck {
  caseId: EvaluationCaseId;
  caseName: string;
  checkId: CheckId;
  label?: string;
  pattern: string;
  flags: string;
  negate: boolean;
  /** Set when this build refuses the drafted pattern; scoring is held back. */
  error?: string;
}

/** A check the drawer carries through unchanged, listed so nothing looks lost. */
export interface ReassessmentCarriedCheck {
  caseId: EvaluationCaseId;
  caseName: string;
  checkId: CheckId;
  label?: string;
  kind: CheckDefinition["kind"];
}

export interface EvaluationReassessmentHandle {
  /** Absent while the execution is live, unsaved, or not an evaluation. */
  available: boolean;
  interpretations: EvaluationInterpretation[];
  selected: EvaluationInterpretation;
  select(value: string): void;
  /** What the results surface scores under. Undefined means As run. */
  criteria?: EvaluationCriteriaOverride;
  /** Reading the saved reassessments, and anything that went wrong doing it. */
  loading: boolean;
  error?: string;
  dismissError(): void;
  notice?: string;
  dismissNotice(): void;
  /** How the authored suite today lines up with what this execution ran. */
  suiteDrift: SuiteCriteriaCase[];

  editorOpen: boolean;
  openEditor(): void;
  closeEditor(): void;
  /** The regex checks the drawer may correct, in execution case order. */
  regexChecks: ReassessmentRegexCheck[];
  carriedChecks: ReassessmentCarriedCheck[];
  setPattern(caseId: EvaluationCaseId, checkId: CheckId, pattern: string): void;
  setFlag(caseId: EvaluationCaseId, checkId: CheckId, flag: string, on: boolean): void;
  setNegate(caseId: EvaluationCaseId, checkId: CheckId, negate: boolean): void;
  /** What the draft would change about the outcomes already on screen. */
  preview?: EvaluationOutcomeDiff;
  /** True while a drafted pattern this build refuses is holding the preview back. */
  previewBlocked: boolean;
  draftName: string;
  setDraftName(name: string): void;
  saving: boolean;
  /** Writes the reassessment artifact and selects it. */
  save(): Promise<void>;
  /** What adopting the draft into `project.json` would write, and what it would skip. */
  adoption: { adopt: Array<{ caseId: EvaluationCaseId; name: string }>; skipped: Array<{ caseId: EvaluationCaseId; name: string }> };
  adoptIntoSuite(): void;
}

export interface UseEvaluationReassessmentOptions {
  execution?: EvaluationExecution;
  project: ProjectFile | null;
  adoptProjectMutation(project: ProjectFile): void;
  now?(): string;
  createAssessmentId?(): EvaluationAssessmentId;
}

const AS_RUN: EvaluationInterpretation = {
  value: "as-run",
  id: { kind: "as-run" },
  name: "As run",
  preview: false,
};

const CURRENT_CRITERIA_VALUE = "current-criteria";

function message(error: unknown, fallback: string): string {
  if (error instanceof EvaluationAssessmentError) return error.message;
  return error instanceof Error ? error.message : fallback;
}

/**
 * Drops an optional field rather than setting it to `undefined`. The artifact
 * schema is strict and serialization is stable, so `{flags: undefined}` and no
 * `flags` key are two different files for one meaning.
 */
function withoutKey<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function flagsOf(check: CheckDefinition): string {
  return check.kind === "regex" ? check.flags ?? "" : "";
}

/**
 * Owns the interpretation a finished evaluation is read under, the correction
 * being drafted over it, and the two commitments that correction can lead to.
 *
 * It makes no provider calls and has no seam to make one through: every reading
 * it produces is `evaluationParsedExperimentAggregate` over traces already on
 * disk, with one argument substituted.
 */
export function useEvaluationReassessment({
  execution,
  project,
  adoptProjectMutation,
  now = () => new Date().toISOString(),
  createAssessmentId = () => createEntityId("evaluation-assessment", randomUUID()),
}: UseEvaluationReassessmentOptions): EvaluationReassessmentHandle {
  // Every piece of session state below is stamped with the execution it
  // describes and read back through that stamp, rather than reset by an effect
  // when the execution changes. A reset effect would leave one render in which
  // a name from the previous batch labels this batch's outcomes.
  const [selection, setSelection] = useState<{ experimentId: string; value: string }>();
  const [saved, setSaved] = useState<{ experimentId: string; assessments: EvaluationAssessmentV1[] }>();
  const [storedError, setStoredError] = useState<{ experimentId: string; message: string }>();
  const [storedNotice, setStoredNotice] = useState<{ experimentId: string; message: string }>();
  const [editor, setEditor] = useState<{ experimentId: string }>();
  const [draft, setDraft] = useState<{
    experimentId: string;
    name: string;
    cases: ReadonlyMap<EvaluationCaseId, readonly CheckDefinition[]>;
  }>();
  const [saving, setSaving] = useState(false);

  const experimentId = execution?.plan.experimentId;
  const workspace = execution?.workspace ?? null;
  // A live batch has no settled evidence to reinterpret, and an unsaved one has
  // nowhere to write an interpretation that would outlive the session.
  const available = Boolean(
    execution && execution.result && !execution.live && execution.storage === "durable" && workspace,
  );

  const parsedPlan = useMemo(() => {
    if (!execution) return undefined;
    const plan = parseExperimentPlanFile(execution.plan);
    return plan.kind === "evaluation" ? plan : undefined;
  }, [execution]);

  const authoredSuite = useMemo(() => {
    const suite = parsedPlan
      ? project?.evaluationSuites.find(({ id }) => id === parsedPlan.suite.suiteId)
      : undefined;
    return suite
      ? {
          cases: suite.cases.map((item) => ({
            caseId: item.id,
            name: item.name,
            values: item.values,
            checks: item.checks,
            ...(item.referenceAnswer === undefined ? {} : { referenceAnswer: item.referenceAnswer }),
          })),
        }
      : undefined;
  }, [parsedPlan, project]);

  const projection = useMemo(
    () => (parsedPlan ? currentSuiteCriteria(parsedPlan, authoredSuite) : undefined),
    [parsedPlan, authoredSuite],
  );

  // Saved reassessments are read once per opened execution, and only for one
  // that could have any: listing already returns contents, so this is a single
  // directory read rather than a read per artifact.
  useEffect(() => {
    if (!available || !workspace || !execution || !experimentId) return;
    if (saved?.experimentId === experimentId) return;
    let cancelled = false;
    void listEvaluationAssessmentsWorkspace(workspace, execution.plan)
      .then((loaded) => {
        if (cancelled) return;
        setSaved({ experimentId, assessments: loaded.assessments });
        if (loaded.failures.length > 0) {
          setStoredError({
            experimentId,
            message: `${loaded.failures.length} saved ${loaded.failures.length === 1 ? "reassessment" : "reassessments"} could not be read: ${loaded.failures.map(({ fileName }) => fileName).join(", ")}.`,
          });
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setSaved({ experimentId, assessments: [] });
        setStoredError({ experimentId, message: message(error, "Saved reassessments could not be read.") });
      });
    return () => {
      cancelled = true;
    };
  }, [available, workspace, execution, experimentId, saved?.experimentId]);

  const assessments = useMemo(
    () => (saved && saved.experimentId === experimentId ? saved.assessments : []),
    [saved, experimentId],
  );
  // Derived rather than a flag an effect sets: "we have not read this
  // execution's reassessments yet" is exactly the absence of a stamped result.
  const loading = available && !(saved && saved.experimentId === experimentId);

  const interpretations = useMemo((): EvaluationInterpretation[] => {
    const list: EvaluationInterpretation[] = [AS_RUN];
    if (projection && projection.criteria.size > 0) {
      list.push({
        value: CURRENT_CRITERIA_VALUE,
        id: { kind: "current-criteria" },
        name: "Current criteria (preview)",
        criteria: projection.criteria,
        preview: true,
      });
    }
    for (const assessment of assessments) {
      list.push({
        value: assessment.assessmentId,
        id: { kind: "assessment", assessmentId: assessment.assessmentId },
        name: assessment.name,
        criteria: evaluationAssessmentCriteria(assessment),
        preview: false,
      });
    }
    return list;
  }, [projection, assessments]);

  const selectedValue = selection && selection.experimentId === experimentId
    ? selection.value
    : AS_RUN.value;
  const selected = interpretations.find(({ value }) => value === selectedValue) ?? AS_RUN;
  const editorOpen = Boolean(editor && editor.experimentId === experimentId);

  const baseCriteria = selected.criteria;

  const draftCriteria = useMemo((): EvaluationCriteriaOverride | undefined => {
    if (!draft || draft.experimentId !== experimentId) return undefined;
    return new Map(draft.cases);
  }, [draft, experimentId]);

  const preview = useMemo(() => {
    if (!parsedPlan || !execution || !draftCriteria) return undefined;
    try {
      const baseline = evaluationParsedExperimentAggregate(
        parsedPlan,
        execution.result,
        execution.states,
      );
      const candidate = evaluationParsedExperimentAggregate(
        parsedPlan,
        execution.result,
        execution.states,
        draftCriteria,
      );
      return diffEvaluationOutcomes(baseline, candidate);
    } catch {
      // A drafted pattern this build refuses is reported per check below; the
      // preview simply waits rather than showing a partial re-derivation.
      return undefined;
    }
  }, [parsedPlan, execution, draftCriteria]);

  const regexChecks = useMemo((): ReassessmentRegexCheck[] => {
    if (!parsedPlan || !draftCriteria) return [];
    return parsedPlan.suite.cases.flatMap((evaluationCase) =>
      (draftCriteria.get(evaluationCase.caseId) ?? evaluationCase.checks)
        .filter((check) => check.kind === "regex")
        .map((check) => ({
          caseId: evaluationCase.caseId,
          caseName: evaluationCase.name,
          checkId: check.checkId,
          ...(check.label === undefined ? {} : { label: check.label }),
          pattern: check.kind === "regex" ? check.pattern : "",
          flags: flagsOf(check),
          negate: check.negate ?? false,
          ...(patternError(check) === undefined ? {} : { error: patternError(check) }),
        })),
    );
  }, [parsedPlan, draftCriteria]);

  const carriedChecks = useMemo((): ReassessmentCarriedCheck[] => {
    if (!parsedPlan || !draftCriteria) return [];
    return parsedPlan.suite.cases.flatMap((evaluationCase) =>
      (draftCriteria.get(evaluationCase.caseId) ?? evaluationCase.checks)
        .filter((check) => check.kind !== "regex")
        .map((check) => ({
          caseId: evaluationCase.caseId,
          caseName: evaluationCase.name,
          checkId: check.checkId,
          ...(check.label === undefined ? {} : { label: check.label }),
          kind: check.kind,
        })),
    );
  }, [parsedPlan, draftCriteria]);

  const adoption = useMemo(() => {
    if (!parsedPlan || !draftCriteria) return { adopt: [], skipped: [] };
    const planned = planSuiteAdoption(draftCriteria, parsedPlan, authoredSuite);
    return {
      adopt: planned.adopt.map(({ caseId, name }) => ({ caseId, name })),
      skipped: planned.skipped,
    };
  }, [parsedPlan, draftCriteria, authoredSuite]);

  const editCheck = useCallback((
    caseId: EvaluationCaseId,
    checkId: CheckId,
    edit: (check: CheckDefinition) => CheckDefinition,
  ) => {
    setDraft((current) => {
      if (!current) return current;
      const checks = current.cases.get(caseId);
      if (!checks) return current;
      const next = new Map(current.cases);
      next.set(caseId, checks.map((check) => check.checkId === checkId ? edit(check) : check));
      return { ...current, cases: next };
    });
  }, []);

  const openEditor = useCallback(() => {
    if (!parsedPlan || !experimentId) return;
    // Opening defaults to the current authored criteria where they are usable,
    // and to the execution's own everywhere else: the common correction is one
    // the author has already made in the suite editor.
    const start = new Map<EvaluationCaseId, readonly CheckDefinition[]>();
    for (const evaluationCase of parsedPlan.suite.cases) {
      start.set(
        evaluationCase.caseId,
        baseCriteria?.get(evaluationCase.caseId)
          ?? projection?.criteria.get(evaluationCase.caseId)
          ?? evaluationCase.checks,
      );
    }
    setDraft({ experimentId, name: selected.preview ? "" : selected.name === AS_RUN.name ? "" : selected.name, cases: start });
    setEditor({ experimentId });
  }, [parsedPlan, experimentId, baseCriteria, projection, selected]);

  const draftName = draft && draft.experimentId === experimentId ? draft.name : "";

  const save = useCallback(async () => {
    if (!parsedPlan || !workspace || !draftCriteria || !experimentId) return;
    setSaving(true);
    try {
      const assessmentId = createAssessmentId();
      const assessment = createEvaluationAssessment(
        {
          assessmentId,
          name: draftName.trim() || "Corrected criteria",
          createdAt: now(),
          criteria: draftCriteria,
        },
        parsedPlan,
      );
      await saveEvaluationAssessmentWorkspace(workspace, assessment, parsedPlan);
      setSaved((current) => ({
        experimentId,
        assessments: [...(current?.experimentId === experimentId ? current.assessments : []), assessment],
      }));
      setSelection({ experimentId, value: assessment.assessmentId });
      setEditor(undefined);
      setDraft(undefined);
      setStoredError(undefined);
      setStoredNotice({ experimentId, message: `Saved “${assessment.name}”. The As run reading is unchanged.` });
    } catch (error) {
      setStoredError({ experimentId, message: message(error, "The reassessment could not be saved.") });
    } finally {
      setSaving(false);
    }
  }, [parsedPlan, workspace, draftCriteria, experimentId, draftName, now, createAssessmentId]);

  const adoptIntoSuite = useCallback(() => {
    if (!parsedPlan || !project || !draftCriteria || !experimentId) return;
    const suiteId = parsedPlan.suite.suiteId;
    const planned = planSuiteAdoption(draftCriteria, parsedPlan, authoredSuite);
    if (planned.adopt.length === 0) {
      setStoredError({
        experimentId,
        message: "None of the corrected cases are still in the authored suite, so there is nothing to update.",
      });
      return;
    }
    try {
      let next = project;
      for (const adopted of planned.adopt) {
        for (const check of adopted.checks) {
          next = updateEvaluationCheck(next, suiteId, adopted.caseId, check);
        }
      }
      adoptProjectMutation(next);
      setStoredError(undefined);
      setStoredNotice({
        experimentId,
        message: planned.skipped.length === 0
          ? `Updated ${planned.adopt.length} ${planned.adopt.length === 1 ? "case" : "cases"} in the authored suite.`
          : `Updated ${planned.adopt.length} ${planned.adopt.length === 1 ? "case" : "cases"}. ${planned.skipped.map(({ name }) => `“${name}”`).join(", ")} ${planned.skipped.length === 1 ? "is" : "are"} no longer in the suite and ${planned.skipped.length === 1 ? "was" : "were"} not recreated.`,
      });
    } catch (error) {
      setStoredError({ experimentId, message: message(error, "The authored suite could not be updated.") });
    }
  }, [parsedPlan, project, draftCriteria, experimentId, authoredSuite, adoptProjectMutation]);

  const scoped = <T extends { experimentId: string }>(value: T | undefined): T | undefined =>
    value && value.experimentId === experimentId ? value : undefined;

  return {
    available,
    interpretations,
    selected,
    select(value) {
      if (experimentId) setSelection({ experimentId, value });
    },
    ...(baseCriteria ? { criteria: baseCriteria } : {}),
    loading,
    ...(scoped(storedError) ? { error: scoped(storedError)!.message } : {}),
    dismissError() { setStoredError(undefined); },
    ...(scoped(storedNotice) ? { notice: scoped(storedNotice)!.message } : {}),
    dismissNotice() { setStoredNotice(undefined); },
    suiteDrift: projection?.cases ?? [],
    editorOpen,
    openEditor,
    closeEditor() { setEditor(undefined); setDraft(undefined); },
    regexChecks,
    carriedChecks,
    setPattern(caseId, checkId, pattern) {
      editCheck(caseId, checkId, (check) => check.kind === "regex" ? { ...check, pattern } : check);
    },
    setFlag(caseId, checkId, flag, on) {
      editCheck(caseId, checkId, (check) => {
        if (check.kind !== "regex") return check;
        const flags = new Set((check.flags ?? "").split(""));
        if (on) flags.add(flag); else flags.delete(flag);
        const next = [...flags].sort().join("");
        const rest = withoutKey(check, "flags");
        return next ? { ...rest, flags: next } : rest;
      });
    },
    setNegate(caseId, checkId, negate) {
      editCheck(caseId, checkId, (check) => {
        if (check.kind !== "regex") return check;
        const rest = withoutKey(check, "negate");
        return negate ? { ...rest, negate: true } : rest;
      });
    },
    ...(preview ? { preview } : {}),
    previewBlocked: preview === undefined && regexChecks.some(({ error }) => error !== undefined),
    draftName,
    setDraftName(name) {
      setDraft((current) => current ? { ...current, name } : current);
    },
    saving,
    save,
    adoption,
    adoptIntoSuite,
  };
}

/**
 * Validated through the same Safe regex path scoring uses, not a second
 * approximation of it: a pattern the drawer accepts and the engine then refuses
 * would produce a preview that cannot be saved.
 */
function patternError(check: CheckDefinition): string | undefined {
  if (check.kind !== "regex") return undefined;
  return validateSafeRegex(check)?.message;
}
