import type { CheckDefinition } from "./checks.ts";
import type { EvaluationCaseSnapshot } from "./experiment.ts";
import { stableJsonValue } from "./stable-json.ts";
import type { CheckId, EvaluationCaseId } from "./run-kernel/types.ts";

/**
 * Aligns two evaluation suite snapshots by stable identity.
 *
 * This is deliberately a pure function of two authored snapshots and nothing
 * else: no run states, no results, no execution settings. Two features need
 * exactly this question answered — baseline versus candidate comparison, and
 * reassessing a saved output against replacement criteria — and they must not
 * each grow their own subtly different notion of "the same case".
 *
 * Run evidence is not part of alignment. Whether an aligned case has a trace
 * belongs to whoever holds the execution, which is why `missing-trace` is a
 * repetition classification on the aggregate rather than an alignment status.
 */

/** How one side's case or check relates to the other side's. */
export type SuiteAlignmentStatus = "aligned" | "incompatible" | "added" | "removed";

/**
 * Why two snapshots of the same identity cannot be compared outcome for
 * outcome. Reported rather than collapsed into a boolean: "the checks changed"
 * and "the input values changed" invalidate a comparison for different reasons
 * and an author fixes them differently.
 */
export type SuiteAlignmentReason =
  | "values-changed"
  | "reference-answer-changed"
  | "checks-changed";

export interface AlignedCheck {
  checkId: CheckId;
  /** The candidate's label where it exists, else the baseline's. */
  label?: string;
  kind: CheckDefinition["kind"];
  status: SuiteAlignmentStatus;
}

export interface AlignedCase {
  caseId: EvaluationCaseId;
  /** The candidate's name where it exists, else the baseline's. */
  name: string;
  status: SuiteAlignmentStatus;
  /** Empty unless `status` is `"incompatible"`. */
  reasons: SuiteAlignmentReason[];
  checks: AlignedCheck[];
}

export interface SuiteAlignmentCounts {
  aligned: number;
  incompatible: number;
  added: number;
  removed: number;
}

export interface SuiteAlignment {
  /** Baseline order first, then cases only the candidate has. */
  cases: AlignedCase[];
  counts: SuiteAlignmentCounts;
}

/** The subset of a suite snapshot alignment reads. */
export interface AlignableSuiteSnapshot {
  cases: readonly EvaluationCaseSnapshot[];
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableJsonValue(left)) === JSON.stringify(stableJsonValue(right));
}

/**
 * A check is compatible when its definition is byte-identical under stable key
 * ordering. A renamed label is a changed definition: the label is what an
 * author reads in a comparison, so silently aligning two differently labelled
 * checks would attribute one check's result to another check's name.
 */
function alignChecks(
  baseline: readonly CheckDefinition[] | undefined,
  candidate: readonly CheckDefinition[] | undefined,
): AlignedCheck[] {
  const baselineChecks = new Map((baseline ?? []).map((check) => [check.checkId, check]));
  const candidateChecks = new Map((candidate ?? []).map((check) => [check.checkId, check]));
  const aligned: AlignedCheck[] = [];

  for (const [checkId, baselineCheck] of baselineChecks) {
    const candidateCheck = candidateChecks.get(checkId);
    if (!candidateCheck) {
      aligned.push({
        checkId,
        ...(baselineCheck.label === undefined ? {} : { label: baselineCheck.label }),
        kind: baselineCheck.kind,
        status: "removed",
      });
      continue;
    }
    aligned.push({
      checkId,
      ...(candidateCheck.label === undefined ? {} : { label: candidateCheck.label }),
      kind: candidateCheck.kind,
      status: sameJson(baselineCheck, candidateCheck) ? "aligned" : "incompatible",
    });
  }
  for (const [checkId, candidateCheck] of candidateChecks) {
    if (baselineChecks.has(checkId)) continue;
    aligned.push({
      checkId,
      ...(candidateCheck.label === undefined ? {} : { label: candidateCheck.label }),
      kind: candidateCheck.kind,
      status: "added",
    });
  }
  return aligned;
}

function caseReasons(
  baseline: EvaluationCaseSnapshot,
  candidate: EvaluationCaseSnapshot,
  checks: readonly AlignedCheck[],
): SuiteAlignmentReason[] {
  const reasons: SuiteAlignmentReason[] = [];
  if (!sameJson(baseline.values, candidate.values)) reasons.push("values-changed");
  if (baseline.referenceAnswer !== candidate.referenceAnswer) {
    reasons.push("reference-answer-changed");
  }
  if (checks.some(({ status }) => status !== "aligned")) reasons.push("checks-changed");
  return reasons;
}

export function alignSuiteSnapshots(
  baseline: AlignableSuiteSnapshot,
  candidate: AlignableSuiteSnapshot,
): SuiteAlignment {
  const baselineCases = new Map(baseline.cases.map((item) => [item.caseId, item]));
  const candidateCases = new Map(candidate.cases.map((item) => [item.caseId, item]));
  const cases: AlignedCase[] = [];

  for (const [caseId, baselineCase] of baselineCases) {
    const candidateCase = candidateCases.get(caseId);
    if (!candidateCase) {
      cases.push({
        caseId,
        name: baselineCase.name,
        status: "removed",
        reasons: [],
        checks: alignChecks(baselineCase.checks, undefined),
      });
      continue;
    }
    const checks = alignChecks(baselineCase.checks, candidateCase.checks);
    const reasons = caseReasons(baselineCase, candidateCase, checks);
    cases.push({
      caseId,
      name: candidateCase.name,
      status: reasons.length > 0 ? "incompatible" : "aligned",
      reasons,
      checks,
    });
  }
  for (const [caseId, candidateCase] of candidateCases) {
    if (baselineCases.has(caseId)) continue;
    cases.push({
      caseId,
      name: candidateCase.name,
      status: "added",
      reasons: [],
      checks: alignChecks(undefined, candidateCase.checks),
    });
  }

  const counts: SuiteAlignmentCounts = { aligned: 0, incompatible: 0, added: 0, removed: 0 };
  for (const item of cases) counts[item.status] += 1;
  return { cases, counts };
}
