import { z } from "zod";

import { CHECK_SCHEMA_VERSION, checkDefinitionSchema } from "./checks.ts";
import type { CheckDefinition } from "./checks.ts";
import { EVALUATION_ASSESSMENT_FILE_SUFFIX } from "./experiment.ts";
import type { EvaluationCriteriaOverride, ExperimentPlanV4 } from "./experiment.ts";
import { stableJsonValue } from "./stable-json.ts";
import type {
  EntityId,
  EntityIdKind,
  EvaluationAssessmentId,
  EvaluationCaseId,
  ExperimentId,
} from "./run-kernel/types.ts";

/**
 * A saved reassessment: one named interpretation of an execution that already
 * happened, expressed as replacement criteria over evidence that never moves.
 *
 * Check outcomes are not persisted anywhere — `evaluationParsedExperimentAggregate`
 * re-derives them from (plan checks, traces) on every open. An assessment is
 * therefore nothing but a substitute for the first of those two arguments, and
 * saving one cannot disturb the execution's own "As run" reading.
 *
 * It carries criteria and nothing else. Target, response mode, inference
 * options, repetitions, tools, input revision, and case values are all
 * execution or evidence; reinterpreting them would be a new run, not a
 * reinterpretation of this one.
 */

export const EVALUATION_ASSESSMENT_SCHEMA_VERSION = 1;
export const EVALUATION_ASSESSMENT_NAME_MAX_LENGTH = 80;

export interface EvaluationAssessmentCase {
  caseId: EvaluationCaseId;
  /**
   * Replaces this case's check set wholesale. A check whose `checkId` is
   * unchanged but whose definition differs is a replacement; an unfamiliar
   * `checkId` is an addition. Cases the assessment omits keep the execution's
   * own checks, so correcting one case never blanks the others.
   */
  checks: CheckDefinition[];
}

export interface EvaluationAssessmentV1 {
  schemaVersion: 1;
  assessmentId: EvaluationAssessmentId;
  experimentId: ExperimentId;
  name: string;
  createdAt: string;
  /**
   * Pinned as a literal, exactly as the plan pins it. A reassessment cannot
   * use a check kind the execution's vocabulary lacked, because the
   * execution's own artifact would not parse under this build.
   */
  checkSchemaVersion: typeof CHECK_SCHEMA_VERSION;
  scoringPolicy: "strict";
  cases: EvaluationAssessmentCase[];
}

export class EvaluationAssessmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluationAssessmentError";
  }
}

function entityId<Kind extends EntityIdKind>(kind: Kind): z.ZodType<EntityId<Kind>> {
  return z
    .string()
    .regex(
      new RegExp(`^${kind}_[A-Za-z0-9][A-Za-z0-9._-]*$`),
      `Expected a safe ${kind} identifier.`,
    ) as z.ZodType<EntityId<Kind>>;
}

const assessmentCaseSchema = z
  .object({
    caseId: entityId("evaluation-case"),
    // `.min(1)` mirrors `evaluationCaseSnapshotSchema`: strict scoring over an
    // empty check set has no meaning, and the authoring preflight already
    // refuses one.
    checks: z.array(checkDefinitionSchema).min(1),
  })
  .strict();

const assessmentSchema = z
  .object({
    schemaVersion: z.literal(EVALUATION_ASSESSMENT_SCHEMA_VERSION),
    assessmentId: entityId("evaluation-assessment"),
    experimentId: entityId("experiment"),
    name: z.string().trim().min(1).max(EVALUATION_ASSESSMENT_NAME_MAX_LENGTH),
    createdAt: z.string().datetime(),
    checkSchemaVersion: z.literal(CHECK_SCHEMA_VERSION),
    scoringPolicy: z.literal("strict"),
    cases: z.array(assessmentCaseSchema).min(1),
  })
  .strict() as z.ZodType<EvaluationAssessmentV1>;

/** Kept only to diagnose a stale artifact clearly instead of as a field error. */
const unsupportedAssessmentVersionSchema = z
  .object({ schemaVersion: z.number().int() })
  .passthrough();

function parseWith<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new EvaluationAssessmentError(
      issue
        ? `Invalid ${label} at ${issue.path.join(".") || "root"}: ${issue.message}`
        : `${label} is invalid.`,
    );
  }
  return parsed.data;
}

export function evaluationAssessmentFileName(assessmentId: EvaluationAssessmentId): string {
  const parsed = parseWith(entityId("evaluation-assessment"), assessmentId, "assessment ID");
  return `${parsed}${EVALUATION_ASSESSMENT_FILE_SUFFIX}`;
}

function assertAssessmentReferences(
  assessment: EvaluationAssessmentV1,
  plan: ExperimentPlanV4,
): void {
  if (plan.kind !== "evaluation") {
    throw new EvaluationAssessmentError(
      "Only an evaluation experiment can be reassessed; a repeated-request experiment has no checks.",
    );
  }
  if (assessment.experimentId !== plan.experimentId) {
    throw new EvaluationAssessmentError("Reassessment belongs to a different experiment.");
  }
  // Cases are aligned against the execution's own plan, never against the
  // current authored suite: the evidence is what the execution captured.
  const known = new Set(plan.suite.cases.map((evaluationCase) => evaluationCase.caseId));
  const seenCases = new Set<EvaluationCaseId>();
  assessment.cases.forEach((assessmentCase) => {
    if (!known.has(assessmentCase.caseId)) {
      throw new EvaluationAssessmentError(
        `Reassessment references case ${assessmentCase.caseId}, which the execution did not run.`,
      );
    }
    if (seenCases.has(assessmentCase.caseId)) {
      throw new EvaluationAssessmentError(`Reassessment repeats case ${assessmentCase.caseId}.`);
    }
    seenCases.add(assessmentCase.caseId);

    const seenChecks = new Set<string>();
    assessmentCase.checks.forEach((check) => {
      if (seenChecks.has(check.checkId)) {
        throw new EvaluationAssessmentError(
          `Reassessment repeats check ${check.checkId} in case ${assessmentCase.caseId}.`,
        );
      }
      seenChecks.add(check.checkId);
    });
  });
}

export function parseEvaluationAssessmentFile(
  value: unknown,
  plan: ExperimentPlanV4,
): EvaluationAssessmentV1 {
  const version = unsupportedAssessmentVersionSchema.safeParse(value);
  if (version.success && version.data.schemaVersion !== EVALUATION_ASSESSMENT_SCHEMA_VERSION) {
    throw new EvaluationAssessmentError(
      `Reassessment schema Version ${version.data.schemaVersion} is unsupported; expected Version ${EVALUATION_ASSESSMENT_SCHEMA_VERSION}.`,
    );
  }
  const assessment = parseWith(assessmentSchema, value, "reassessment");
  assertAssessmentReferences(assessment, plan);
  return assessment;
}

export function parseEvaluationAssessmentJson(
  contents: string,
  plan: ExperimentPlanV4,
): EvaluationAssessmentV1 {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new EvaluationAssessmentError("Reassessment is not valid JSON.");
  }
  return parseEvaluationAssessmentFile(value, plan);
}

/**
 * Projects a saved reassessment into the override the scoring aggregate takes.
 *
 * The projection lives here rather than in `experiment.ts` so the aggregate
 * never learns that a storage artifact exists: the same override shape also
 * carries the current-criteria preview, which is deliberately never persisted.
 */
export function evaluationAssessmentCriteria(
  assessment: EvaluationAssessmentV1,
): EvaluationCriteriaOverride {
  return new Map(assessment.cases.map(({ caseId, checks }) => [caseId, checks]));
}

export interface NewEvaluationAssessment {
  assessmentId: EvaluationAssessmentId;
  name: string;
  createdAt: string;
  /** Replacement checks per case; entries matching the plan are dropped. */
  criteria: EvaluationCriteriaOverride;
}

/**
 * Builds the artifact for a correction the author has previewed.
 *
 * Only cases whose checks actually differ from the execution's are carried. A
 * reassessment that restated every case identically would be a full copy of the
 * plan's criteria masquerading as a correction, and re-reading it later could
 * not tell which case the author meant to change. For the same reason a
 * reassessment that changes nothing at all is refused rather than saved empty:
 * "As run" already names that interpretation, and it costs no file.
 */
export function createEvaluationAssessment(
  input: NewEvaluationAssessment,
  plan: ExperimentPlanV4,
): EvaluationAssessmentV1 {
  if (plan.kind !== "evaluation") {
    throw new EvaluationAssessmentError(
      "Only an evaluation experiment can be reassessed; a repeated-request experiment has no checks.",
    );
  }
  const cases: EvaluationAssessmentCase[] = [];
  for (const evaluationCase of plan.suite.cases) {
    const replacement = input.criteria.get(evaluationCase.caseId);
    if (!replacement || sameChecks(replacement, evaluationCase.checks)) continue;
    cases.push({ caseId: evaluationCase.caseId, checks: [...replacement] });
  }
  if (cases.length === 0) {
    throw new EvaluationAssessmentError(
      "This reassessment matches the execution's own criteria, so there is nothing to save.",
    );
  }
  return parseEvaluationAssessmentFile(
    {
      schemaVersion: EVALUATION_ASSESSMENT_SCHEMA_VERSION,
      assessmentId: input.assessmentId,
      experimentId: plan.experimentId,
      name: input.name.trim(),
      createdAt: input.createdAt,
      checkSchemaVersion: CHECK_SCHEMA_VERSION,
      scoringPolicy: "strict",
      cases,
    },
    plan,
  );
}

function sameChecks(left: readonly CheckDefinition[], right: readonly CheckDefinition[]): boolean {
  return JSON.stringify(stableJsonValue(left)) === JSON.stringify(stableJsonValue(right));
}

export function serializeEvaluationAssessment(
  assessment: EvaluationAssessmentV1,
  plan: ExperimentPlanV4,
): string {
  return `${JSON.stringify(stableJsonValue(parseEvaluationAssessmentFile(assessment, plan)), null, 2)}\n`;
}
