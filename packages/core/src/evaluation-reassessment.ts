import { parseCheckDefinition } from "./checks.ts";
import type { CheckDefinition } from "./checks.ts";
import { alignSuiteSnapshots } from "./evaluation-suite-alignment.ts";
import type { AlignableSuiteSnapshot } from "./evaluation-suite-alignment.ts";
import type {
  EvaluationCriteriaOverride,
  EvaluationExperimentPlanV4,
} from "./experiment.ts";
import type { EvaluationCaseId } from "./run-kernel/types.ts";

/**
 * Joins an execution's own criteria to the criteria authored today.
 *
 * Two directions of drift need different answers and are therefore named
 * separately rather than collapsed into "compatible":
 *
 * - a case the author has since deleted still has evidence, so it keeps the
 *   execution's own checks and is scored exactly as it was run;
 * - a case authored since the execution has no evidence at all, so it is
 *   reported and left unscored rather than counted as a failure.
 *
 * Alignment is `alignSuiteSnapshots`, the same function baseline comparison
 * uses. Two features asking "is this the same case?" must not each grow their
 * own answer.
 */

export type SuiteCriteriaCaseStatus =
  /** Present in both; the authored checks differ from the execution's. */
  | "replaced"
  /** Present in both; the authored checks are byte-identical to the execution's. */
  | "identical"
  /** The execution ran it, the authored suite no longer has it. Keeps its own checks. */
  | "absent-from-suite"
  /** Authored since the execution ran. No evidence, so it cannot be scored. */
  | "absent-from-execution"
  /** Authored checks this build cannot score, e.g. an unfinished regex pattern. */
  | "unusable";

export interface SuiteCriteriaCase {
  caseId: EvaluationCaseId;
  name: string;
  status: SuiteCriteriaCaseStatus;
  /** Present only when `status` is `"unusable"`. */
  reason?: string;
}

export interface SuiteCriteriaProjection {
  /** Replacement checks for the cases the authored suite can actually re-score. */
  criteria: EvaluationCriteriaOverride;
  /** Execution order first, then cases only the authored suite has. */
  cases: SuiteCriteriaCase[];
}

/**
 * Projects the currently authored suite into a never-persisted preview
 * interpretation of a past execution.
 *
 * An authored check is admitted only if it parses under the strict artifact
 * schema. Authoring tolerates one intentionally incomplete state — an empty
 * regex pattern — and scoring history under a half-written check would report
 * an outcome the author never asked a question to get.
 */
export function currentSuiteCriteria(
  plan: EvaluationExperimentPlanV4,
  suite: AlignableSuiteSnapshot | undefined,
): SuiteCriteriaProjection {
  const criteria = new Map<EvaluationCaseId, readonly CheckDefinition[]>();
  if (!suite) {
    return {
      criteria,
      cases: plan.suite.cases.map(({ caseId, name }) => ({
        caseId,
        name,
        status: "absent-from-suite" as const,
      })),
    };
  }

  const authored = new Map(suite.cases.map((item) => [item.caseId, item]));
  const alignment = alignSuiteSnapshots({ cases: plan.suite.cases }, suite);
  const cases: SuiteCriteriaCase[] = [];
  for (const aligned of alignment.cases) {
    if (aligned.status === "removed") {
      cases.push({ caseId: aligned.caseId, name: aligned.name, status: "absent-from-suite" });
      continue;
    }
    if (aligned.status === "added") {
      cases.push({ caseId: aligned.caseId, name: aligned.name, status: "absent-from-execution" });
      continue;
    }
    const checks = authored.get(aligned.caseId)?.checks ?? [];
    const unusable = firstUnusableCheck(checks);
    if (unusable) {
      cases.push({
        caseId: aligned.caseId,
        name: aligned.name,
        status: "unusable",
        reason: unusable,
      });
      continue;
    }
    // `aligned` covers values and the reference answer too, and neither is
    // criteria: a case whose input text changed is still the same question
    // asked of this evidence, and re-scoring it says nothing about the new
    // values. Only the check comparison decides "replaced" here.
    const replaced = aligned.checks.some(({ status }) => status !== "aligned");
    cases.push({
      caseId: aligned.caseId,
      name: aligned.name,
      status: replaced ? "replaced" : "identical",
    });
    if (replaced) criteria.set(aligned.caseId, checks);
  }
  return { criteria, cases };
}

function firstUnusableCheck(checks: readonly CheckDefinition[]): string | undefined {
  if (checks.length === 0) return "The authored case has no checks.";
  for (const check of checks) {
    try {
      parseCheckDefinition(check);
    } catch (error) {
      return error instanceof Error ? error.message : "The authored check cannot be scored.";
    }
  }
  return undefined;
}

export interface SuiteAdoptionCase {
  caseId: EvaluationCaseId;
  name: string;
  checks: readonly CheckDefinition[];
}

export interface SuiteAdoption {
  /** Cases the authored suite still has, with the corrected checks to write. */
  adopt: SuiteAdoptionCase[];
  /** Corrected cases the authored suite no longer has; never recreated. */
  skipped: Array<{ caseId: EvaluationCaseId; name: string }>;
}

/**
 * Works out what adopting a correction into the authored suite would write.
 *
 * Deliberately never creates an authored case. A correction is an
 * interpretation of history; a case the author deleted is a decision about the
 * future, and history has no standing to undo it. Those cases are named in the
 * confirmation instead, so adopting nine of ten corrections is still useful and
 * still honest about the tenth.
 */
export function planSuiteAdoption(
  criteria: EvaluationCriteriaOverride,
  plan: EvaluationExperimentPlanV4,
  suite: AlignableSuiteSnapshot | undefined,
): SuiteAdoption {
  const authored = new Set((suite?.cases ?? []).map(({ caseId }) => caseId));
  const adopt: SuiteAdoptionCase[] = [];
  const skipped: SuiteAdoption["skipped"] = [];
  for (const evaluationCase of plan.suite.cases) {
    const checks = criteria.get(evaluationCase.caseId);
    if (!checks) continue;
    const entry = { caseId: evaluationCase.caseId, name: evaluationCase.name };
    if (authored.has(evaluationCase.caseId)) adopt.push({ ...entry, checks });
    else skipped.push(entry);
  }
  return { adopt, skipped };
}
