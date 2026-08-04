import { z } from "zod";

import { stableJsonValue } from "./stable-json.ts";
import type {
  EntityId,
  EntityIdKind,
  EvaluationBaselineId,
  EvaluationSuiteId,
  ExperimentId,
} from "./run-kernel/types.ts";

/**
 * Named baselines: mutable annotations that pin immutable evaluation
 * executions.
 *
 * These live in their own project-folder file rather than in `project.json`.
 * A pin references an `experimentId` that exists only as an artifact under
 * `experiments/`, so it is meaningful exactly where those artifacts are and
 * would dangle in a single-file project export. Keeping it out of
 * `project.json` also keeps a judgment about evidence from versioning as
 * authored content.
 *
 * Nothing here mutates an experiment. Unpinning removes an annotation and
 * never removes evidence.
 */

export const EVALUATION_BASELINES_FILE_NAME = "evaluation-baselines.json";
export const EVALUATION_BASELINES_SCHEMA_VERSION = 1;
export const EVALUATION_BASELINE_NAME_MAX_LENGTH = 80;

export interface EvaluationBaseline {
  baselineId: EvaluationBaselineId;
  suiteId: EvaluationSuiteId;
  experimentId: ExperimentId;
  name: string;
  pinnedAt: string;
}

export interface EvaluationBaselinesFileV1 {
  schemaVersion: 1;
  baselines: EvaluationBaseline[];
}

export class EvaluationBaselineError extends Error {
  readonly code:
    | "invalid-file"
    | "empty-name"
    | "name-too-long"
    | "duplicate-name"
    | "duplicate-experiment"
    | "unknown-baseline";

  constructor(code: EvaluationBaselineError["code"], message: string) {
    super(message);
    this.name = "EvaluationBaselineError";
    this.code = code;
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

const baselineSchema: z.ZodType<EvaluationBaseline> = z
  .object({
    baselineId: entityId("evaluation-baseline"),
    suiteId: entityId("evaluation-suite"),
    experimentId: entityId("experiment"),
    name: z.string().min(1).max(EVALUATION_BASELINE_NAME_MAX_LENGTH),
    pinnedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

const fileSchema: z.ZodType<EvaluationBaselinesFileV1> = z
  .object({
    schemaVersion: z.literal(EVALUATION_BASELINES_SCHEMA_VERSION),
    baselines: z.array(baselineSchema),
  })
  .strict()
  .superRefine((file, context) => {
    const ids = new Set<string>();
    file.baselines.forEach((baseline, index) => {
      if (ids.has(baseline.baselineId)) {
        context.addIssue({
          code: "custom",
          path: ["baselines", index, "baselineId"],
          message: `Duplicate baseline identifier "${baseline.baselineId}".`,
        });
      }
      ids.add(baseline.baselineId);
    });
  });

export function emptyEvaluationBaselines(): EvaluationBaselinesFileV1 {
  return { schemaVersion: EVALUATION_BASELINES_SCHEMA_VERSION, baselines: [] };
}

/**
 * Throws rather than falling back to empty. A pin the author made is not
 * something to discard silently: the caller reports the damaged file and
 * leaves it alone instead of overwriting it on the next pin.
 */
export function parseEvaluationBaselines(value: unknown): EvaluationBaselinesFileV1 {
  const parsed = fileSchema.safeParse(value);
  if (!parsed.success) {
    throw new EvaluationBaselineError(
      "invalid-file",
      "The evaluation baselines file is not valid.",
    );
  }
  return parsed.data;
}

export function parseEvaluationBaselinesJson(contents: string): EvaluationBaselinesFileV1 {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new EvaluationBaselineError(
      "invalid-file",
      "The evaluation baselines file is not valid JSON.",
    );
  }
  return parseEvaluationBaselines(value);
}

export function serializeEvaluationBaselines(file: EvaluationBaselinesFileV1): string {
  return `${JSON.stringify(stableJsonValue(parseEvaluationBaselines(file)), null, 2)}\n`;
}

/** Baselines pinned for one suite, most recently pinned first. */
export function suiteEvaluationBaselines(
  file: EvaluationBaselinesFileV1,
  suiteId: EvaluationSuiteId,
): EvaluationBaseline[] {
  return file.baselines
    .filter((baseline) => baseline.suiteId === suiteId)
    .sort((left, right) =>
      left.pinnedAt === right.pinnedAt
        ? left.baselineId < right.baselineId
          ? 1
          : -1
        : left.pinnedAt < right.pinnedAt
          ? 1
          : -1,
    );
}

function normalizeName(name: string): string {
  return name.trim().replaceAll(/\s+/gu, " ");
}

function assertNameAvailable(
  file: EvaluationBaselinesFileV1,
  suiteId: EvaluationSuiteId,
  name: string,
  exceptBaselineId?: EvaluationBaselineId,
): string {
  const normalized = normalizeName(name);
  if (!normalized) {
    throw new EvaluationBaselineError("empty-name", "A baseline needs a name.");
  }
  if (normalized.length > EVALUATION_BASELINE_NAME_MAX_LENGTH) {
    throw new EvaluationBaselineError(
      "name-too-long",
      `A baseline name is at most ${EVALUATION_BASELINE_NAME_MAX_LENGTH} characters.`,
    );
  }
  const taken = file.baselines.some(
    (baseline) =>
      baseline.suiteId === suiteId &&
      baseline.baselineId !== exceptBaselineId &&
      baseline.name.toLowerCase() === normalized.toLowerCase(),
  );
  if (taken) {
    throw new EvaluationBaselineError(
      "duplicate-name",
      `This suite already has a baseline named "${normalized}".`,
    );
  }
  return normalized;
}

export interface PinEvaluationBaselineOptions {
  baselineId: EvaluationBaselineId;
  suiteId: EvaluationSuiteId;
  experimentId: ExperimentId;
  name: string;
  pinnedAt: string;
}

export function pinEvaluationBaseline(
  file: EvaluationBaselinesFileV1,
  options: PinEvaluationBaselineOptions,
): EvaluationBaselinesFileV1 {
  const name = assertNameAvailable(file, options.suiteId, options.name);
  // One execution, one name. Two names for the same evidence would make a
  // comparison picker offer the same comparison twice under different labels.
  if (
    file.baselines.some(
      (baseline) =>
        baseline.suiteId === options.suiteId && baseline.experimentId === options.experimentId,
    )
  ) {
    throw new EvaluationBaselineError(
      "duplicate-experiment",
      "This execution is already pinned as a baseline.",
    );
  }
  return {
    ...file,
    baselines: [...file.baselines, { ...options, name }],
  };
}

export function renameEvaluationBaseline(
  file: EvaluationBaselinesFileV1,
  baselineId: EvaluationBaselineId,
  name: string,
): EvaluationBaselinesFileV1 {
  const existing = file.baselines.find((baseline) => baseline.baselineId === baselineId);
  if (!existing) {
    throw new EvaluationBaselineError("unknown-baseline", "That baseline no longer exists.");
  }
  const nextName = assertNameAvailable(file, existing.suiteId, name, baselineId);
  return {
    ...file,
    baselines: file.baselines.map((baseline) =>
      baseline.baselineId === baselineId ? { ...baseline, name: nextName } : baseline,
    ),
  };
}

export function unpinEvaluationBaseline(
  file: EvaluationBaselinesFileV1,
  baselineId: EvaluationBaselineId,
): EvaluationBaselinesFileV1 {
  return {
    ...file,
    baselines: file.baselines.filter((baseline) => baseline.baselineId !== baselineId),
  };
}
