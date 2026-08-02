import { z } from "zod";

import { runMetrics } from "./run-metrics.ts";
import type { AttemptUsageCoverage } from "./run-metrics.ts";
import { finalAssistantOutput, outputCharacterCount } from "./run-output.ts";
import {
  executeSafeRegex,
  SAFE_REGEX_SYNTAX,
  validateSafeRegex,
} from "./safe-regex.ts";
import type {
  CheckId,
  EntityId,
  EntityIdKind,
  JsonValue,
  RunState,
} from "./run-kernel/types.ts";

/**
 * The version of the deterministic-check vocabulary itself. Check definitions
 * do not carry their own version field: they are always embedded in a
 * versioned container (the project document, or an evaluation execution
 * artifact), and that container's schema version is what a parser negotiates.
 * Adding, removing, or changing the meaning of a kind requires bumping this
 * constant and the version of every container that stores checks.
 */
export const CHECK_SCHEMA_VERSION = 2;

export class CheckValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckValidationError";
  }
}

/**
 * The whole vocabulary, in one place, so that anything which must cover every
 * kind — an authoring picker, an exhaustiveness test — enumerates it rather
 * than repeating a list that silently falls behind the union.
 */
export const CHECK_KINDS = [
  "exact-match",
  "contains",
  "regex",
  "valid-json",
  "max-output-characters",
  "max-duration-ms",
  "max-total-tokens",
] as const;

export type CheckKind = (typeof CHECK_KINDS)[number];

export type CheckJsonTopLevel = "any" | "object" | "array";

interface CheckDefinitionBase {
  checkId: CheckId;
  /** Optional authored name. It never affects evaluation. */
  label?: string;
}

/**
 * Kinds whose predicate is a statement about the shape of the answer accept
 * `negate`, which asserts the opposite: "does not contain", "does not match",
 * "is not JSON". Threshold kinds do not, because their bound direction is
 * already part of the kind name and a negated maximum is not an assertion
 * anyone means to write.
 */
interface NegatableCheckBase extends CheckDefinitionBase {
  negate?: boolean;
}

/**
 * Comparison is strict by default: the canonical output is compared exactly as
 * the provider produced it. Loosening it is always explicit and stored, so a
 * suite states what it actually compared. Case folding uses locale-independent
 * lower-casing so the same definition and the same output always agree.
 */
export interface TextComparisonOptions {
  /** Defaults to `true`. */
  caseSensitive?: boolean;
  /** Trims leading and trailing whitespace from both sides. Defaults to `false`. */
  trimWhitespace?: boolean;
}

export interface ExactMatchCheck extends NegatableCheckBase, TextComparisonOptions {
  kind: "exact-match";
  value: string;
}

export interface ContainsCheck extends NegatableCheckBase, TextComparisonOptions {
  kind: "contains";
  value: string;
}

export interface RegexCheck extends NegatableCheckBase {
  kind: "regex";
  syntax: "re2";
  pattern: string;
  /** Any unique subset of `i`, `m`, and `s`. Unicode semantics are implicit. */
  flags?: string;
}

export interface ValidJsonCheck extends NegatableCheckBase {
  kind: "valid-json";
  /** Defaults to `"any"`. */
  topLevel?: CheckJsonTopLevel;
}

export interface MaxOutputCharactersCheck extends CheckDefinitionBase {
  kind: "max-output-characters";
  limit: number;
}

export interface MaxDurationCheck extends CheckDefinitionBase {
  kind: "max-duration-ms";
  limit: number;
}

export interface MaxTotalTokensCheck extends CheckDefinitionBase {
  kind: "max-total-tokens";
  limit: number;
}

export type CheckDefinition =
  | ExactMatchCheck
  | ContainsCheck
  | RegexCheck
  | ValidJsonCheck
  | MaxOutputCharactersCheck
  | MaxDurationCheck
  | MaxTotalTokensCheck;

/**
 * The outcome of one check against one run.
 *
 * `failed` is an assertion failure: the run produced an answer and the answer
 * did not satisfy the check. `not-evaluated` means the check could not be
 * decided at all — the run failed, was cancelled, produced no answer, or the
 * provider never reported the quantity being bounded. Collapsing the second
 * into the first would report provider instability as a quality regression.
 *
 * `evidence` carries measurements only: counts, positions, observed values,
 * and booleans. It never copies model output. A consumer that needs the text
 * opens the referenced run.
 */
export type CheckOutcome =
  | { status: "passed"; evidence?: JsonValue }
  | { status: "failed"; message: string; evidence?: JsonValue }
  | { status: "not-evaluated"; reason: string };

export interface CheckResult {
  checkId: CheckId;
  kind: CheckKind;
  outcome: CheckOutcome;
}

export interface CheckOutcomeSummary {
  total: number;
  passed: number;
  failed: number;
  notEvaluated: number;
}

/**
 * Everything the check vocabulary is allowed to read about a run, projected
 * once. Absence is preserved: a field is missing because the run or the
 * provider did not supply the evidence, never because it was defaulted to
 * zero.
 */
export interface RunCheckSubject {
  /** Set when the run itself cannot support any assertion. */
  unavailable?: string;
  /** The canonical final assistant output of a completed run. */
  output?: string;
  totalDurationMs?: number;
  totalTokenCoverage?: AttemptUsageCoverage;
  reportedTotalTokens?: number;
}

function entityId<Kind extends EntityIdKind>(
  kind: Kind,
): z.ZodType<EntityId<Kind>> {
  return z
    .string()
    .regex(
      new RegExp(`^${kind}_[A-Za-z0-9][A-Za-z0-9._-]*$`),
      `Expected a safe ${kind} identifier.`,
    ) as z.ZodType<EntityId<Kind>>;
}

const definitionBase = {
  checkId: entityId("check"),
  label: z.string().optional(),
};

const negatableBase = { ...definitionBase, negate: z.boolean().optional() };

const textComparison = {
  caseSensitive: z.boolean().optional(),
  trimWhitespace: z.boolean().optional(),
};

const limit = z.number().int().nonnegative();

export const checkDefinitionSchema: z.ZodType<CheckDefinition> = z
  .discriminatedUnion("kind", [
    z
      .object({
        ...negatableBase,
        ...textComparison,
        kind: z.literal("exact-match"),
        value: z.string(),
      })
      .strict(),
    z
      .object({
        ...negatableBase,
        ...textComparison,
        kind: z.literal("contains"),
        value: z.string(),
      })
      .strict(),
    z
      .object({
        ...negatableBase,
        kind: z.literal("regex"),
        syntax: z.literal(SAFE_REGEX_SYNTAX, {
          error: `Safe regex syntax must be ${SAFE_REGEX_SYNTAX}.`,
        }),
        pattern: z.string(),
        flags: z.string().optional(),
      })
      .strict(),
    z
      .object({
        ...negatableBase,
        kind: z.literal("valid-json"),
        topLevel: z.enum(["any", "object", "array"]).optional(),
      })
      .strict(),
    z
      .object({ ...definitionBase, kind: z.literal("max-output-characters"), limit })
      .strict(),
    z
      .object({ ...definitionBase, kind: z.literal("max-duration-ms"), limit })
      .strict(),
    z
      .object({ ...definitionBase, kind: z.literal("max-total-tokens"), limit })
      .strict(),
  ])
  .superRefine((definition, context) => {
    if (definition.kind !== "regex") return;
    const issue = validateSafeRegex(definition);
    if (issue) {
      context.addIssue({
        code: "custom",
        path: [issue.field],
        message: issue.message,
      });
    }
  }) as z.ZodType<CheckDefinition>;

/**
 * Portable project authoring permits one intentionally incomplete state: an
 * empty regex pattern. Preflight blocks it before an executable plan is
 * created, while every non-empty pattern still receives the exact runtime
 * Safe regex validation here.
 */
export const authoredCheckDefinitionSchema: z.ZodType<CheckDefinition> = z
  .discriminatedUnion("kind", [
    z.object({ ...negatableBase, ...textComparison, kind: z.literal("exact-match"), value: z.string() }).strict(),
    z.object({ ...negatableBase, ...textComparison, kind: z.literal("contains"), value: z.string() }).strict(),
    z.object({
      ...negatableBase,
      kind: z.literal("regex"),
      syntax: z.literal(SAFE_REGEX_SYNTAX, { error: `Safe regex syntax must be ${SAFE_REGEX_SYNTAX}.` }),
      pattern: z.string(),
      flags: z.string().optional(),
    }).strict(),
    z.object({ ...negatableBase, kind: z.literal("valid-json"), topLevel: z.enum(["any", "object", "array"]).optional() }).strict(),
    z.object({ ...definitionBase, kind: z.literal("max-output-characters"), limit }).strict(),
    z.object({ ...definitionBase, kind: z.literal("max-duration-ms"), limit }).strict(),
    z.object({ ...definitionBase, kind: z.literal("max-total-tokens"), limit }).strict(),
  ])
  .superRefine((definition, context) => {
    if (definition.kind !== "regex" || definition.pattern === "") return;
    const issue = validateSafeRegex(definition);
    if (issue) context.addIssue({ code: "custom", path: [issue.field], message: issue.message });
  }) as z.ZodType<CheckDefinition>;

function parseWith<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CheckValidationError(
      issue
        ? `Invalid ${label} at ${issue.path.join(".") || "root"}: ${issue.message}`
        : `${label} is invalid.`,
    );
  }
  return parsed.data;
}

export function parseCheckDefinition(value: unknown): CheckDefinition {
  return parseWith(checkDefinitionSchema, value, "check definition");
}

/** Parses an ordered list and refuses repeated check identities within it. */
export function parseCheckDefinitions(value: unknown): CheckDefinition[] {
  const definitions = parseWith(
    z.array(checkDefinitionSchema),
    value,
    "check definitions",
  );
  const seen = new Set<string>();
  for (const definition of definitions) {
    if (seen.has(definition.checkId)) {
      throw new CheckValidationError(`Checks repeat ${definition.checkId}.`);
    }
    seen.add(definition.checkId);
  }
  return definitions;
}

/**
 * Projects the evidence the check vocabulary may read. Only a completed run
 * can be asserted about: a failed or cancelled run says nothing about whether
 * the request was answered correctly, and reporting its elapsed time as within
 * a duration budget would read as a pass it never earned.
 */
export function runCheckSubject(state: RunState): RunCheckSubject {
  switch (state.status.kind) {
    case "failed":
      return {
        unavailable: `The run failed (${state.status.error.code}) and produced no checkable result.`,
      };
    case "cancelled":
      return { unavailable: "The run was cancelled and produced no checkable result." };
    case "completed":
      break;
    default:
      return { unavailable: "The run has not reached a terminal status." };
  }

  const metrics = runMetrics(state);
  const output = finalAssistantOutput(state);
  const totalTokenCoverage = metrics.usageCoverage.totalTokens;
  const hasCompleteTotalTokenUsage =
    totalTokenCoverage.totalAttempts > 0 &&
    totalTokenCoverage.reportedAttempts === totalTokenCoverage.totalAttempts;
  return {
    ...(output !== undefined ? { output } : {}),
    ...(metrics.totalDurationMs !== undefined
      ? { totalDurationMs: metrics.totalDurationMs }
      : {}),
    totalTokenCoverage,
    ...(hasCompleteTotalTokenUsage && metrics.usage.totalTokens !== undefined
      ? { reportedTotalTokens: metrics.usage.totalTokens }
      : {}),
  };
}

function outcome(evidence: JsonValue | undefined, failure?: string): CheckOutcome {
  const withEvidence = evidence !== undefined ? { evidence } : {};
  return failure === undefined
    ? { status: "passed", ...withEvidence }
    : { status: "failed", message: failure, ...withEvidence };
}

/**
 * Resolves a predicate against its optional negation. `whenSatisfied` is the
 * failure message for a negated check, so both directions state what was
 * actually asserted instead of reporting "not (…)".
 */
function decide(
  satisfied: boolean,
  negate: boolean | undefined,
  messages: { whenUnsatisfied: string; whenSatisfied: string },
  evidence: JsonValue,
): CheckOutcome {
  if (negate) {
    return outcome(evidence, satisfied ? messages.whenSatisfied : undefined);
  }
  return outcome(evidence, satisfied ? undefined : messages.whenUnsatisfied);
}

function compared(text: string, options: TextComparisonOptions): string {
  const trimmed = options.trimWhitespace ? text.trim() : text;
  return options.caseSensitive === false ? trimmed.toLowerCase() : trimmed;
}

/**
 * Converts a UTF-16 offset to a code-point index, so a position in evidence
 * counts the same characters `outputCharacterCount` does.
 */
function codePointIndex(text: string, utf16Index: number): number {
  return outputCharacterCount(text.slice(0, utf16Index));
}

function firstDifference(left: string, right: string): number | undefined {
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const shared = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < shared; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return index;
  }
  return leftPoints.length === rightPoints.length ? undefined : shared;
}

function jsonTopLevel(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function evaluateOutputCheck(
  definition: ExactMatchCheck | ContainsCheck | RegexCheck | ValidJsonCheck,
  output: string,
): CheckOutcome {
  switch (definition.kind) {
    case "exact-match": {
      const actual = compared(output, definition);
      const expected = compared(definition.value, definition);
      const equal = actual === expected;
      const difference = firstDifference(actual, expected);
      return decide(
        equal,
        definition.negate,
        {
          whenUnsatisfied: "Final assistant output did not equal the expected value.",
          whenSatisfied: "Final assistant output equalled the value it must differ from.",
        },
        {
          equal,
          characters: outputCharacterCount(actual),
          expectedCharacters: outputCharacterCount(expected),
          ...(difference !== undefined ? { firstDifferenceIndex: difference } : {}),
        },
      );
    }
    case "contains": {
      const actual = compared(output, definition);
      const expected = compared(definition.value, definition);
      const at = actual.indexOf(expected);
      return decide(
        at >= 0,
        definition.negate,
        {
          whenUnsatisfied: "Final assistant output did not contain the expected text.",
          whenSatisfied: "Final assistant output contained text it must not contain.",
        },
        {
          found: at >= 0,
          characters: outputCharacterCount(actual),
          expectedCharacters: outputCharacterCount(expected),
          ...(at >= 0 ? { index: codePointIndex(actual, at) } : {}),
        },
      );
    }
    case "regex": {
      const execution = executeSafeRegex(definition, output);
      if (execution.status === "invalid") {
        return {
          status: "not-evaluated",
          reason: execution.issue.message,
        };
      }
      if (execution.status === "input-too-large") {
        return {
          status: "not-evaluated",
          reason: `The final assistant output is ${execution.actual} UTF-16 code units; Safe regex checks support at most ${execution.limit}.`,
        };
      }
      const match = execution.status === "matched" ? execution.match : undefined;
      return decide(
        match !== undefined,
        definition.negate,
        {
          whenUnsatisfied: "Final assistant output did not match the expected pattern.",
          whenSatisfied: "Final assistant output matched a pattern it must not match.",
        },
        {
          matched: match !== undefined,
          characters: outputCharacterCount(output),
          ...(match
            ? {
                index: codePointIndex(output, match.index),
                matchedCharacters: outputCharacterCount(match.text),
              }
            : {}),
        },
      );
    }
    case "valid-json": {
      const required = definition.topLevel ?? "any";
      let parsed: unknown;
      let topLevel: string | undefined;
      try {
        parsed = JSON.parse(output);
        topLevel = jsonTopLevel(parsed);
      } catch {
        // The engine-supplied parse message can quote the output itself, so it
        // is deliberately dropped: evidence carries measurements only.
        topLevel = undefined;
      }
      const satisfied =
        topLevel !== undefined && (required === "any" || topLevel === required);
      const noun = required === "any" ? "valid JSON" : `a valid JSON ${required}`;
      return decide(
        satisfied,
        definition.negate,
        {
          whenUnsatisfied: `Final assistant output is not ${noun}.`,
          whenSatisfied: `Final assistant output is ${noun} but must not be.`,
        },
        {
          valid: topLevel !== undefined,
          characters: outputCharacterCount(output),
          ...(topLevel !== undefined ? { topLevel } : {}),
        },
      );
    }
  }
}

/**
 * Evaluates one check against one run. Pure: no clock, no I/O, and no mutation
 * of the state passed in. The same run state and definition always produce the
 * same outcome.
 */
export function evaluateCheck(
  definition: CheckDefinition,
  subject: RunCheckSubject,
): CheckOutcome {
  if (subject.unavailable) {
    return { status: "not-evaluated", reason: subject.unavailable };
  }

  switch (definition.kind) {
    case "exact-match":
    case "contains":
    case "regex":
    case "valid-json": {
      if (subject.output === undefined) {
        return {
          status: "not-evaluated",
          reason: "The run produced no final assistant output.",
        };
      }
      return evaluateOutputCheck(definition, subject.output);
    }
    case "max-output-characters": {
      if (subject.output === undefined) {
        return {
          status: "not-evaluated",
          reason: "The run produced no final assistant output.",
        };
      }
      const characters = outputCharacterCount(subject.output);
      return outcome(
        { characters, limit: definition.limit },
        characters <= definition.limit
          ? undefined
          : `Final assistant output is ${characters} characters; the maximum is ${definition.limit}.`,
      );
    }
    case "max-duration-ms": {
      if (subject.totalDurationMs === undefined) {
        return {
          status: "not-evaluated",
          reason: "The run recorded no total duration.",
        };
      }
      const durationMs = subject.totalDurationMs;
      return outcome(
        { durationMs, limit: definition.limit },
        durationMs <= definition.limit
          ? undefined
          : `The run took ${durationMs} ms; the maximum is ${definition.limit} ms.`,
      );
    }
    case "max-total-tokens": {
      if (subject.reportedTotalTokens === undefined) {
        const coverage = subject.totalTokenCoverage;
        if (coverage && coverage.reportedAttempts > 0) {
          return {
            status: "not-evaluated",
            reason: `The provider reported total tokens for ${coverage.reportedAttempts} of ${coverage.totalAttempts} attempts.`,
          };
        }
        return {
          status: "not-evaluated",
          reason: "The provider did not report total tokens for this run.",
        };
      }
      const totalTokens = subject.reportedTotalTokens;
      return outcome(
        { totalTokens, limit: definition.limit },
        totalTokens <= definition.limit
          ? undefined
          : `The run reported ${totalTokens} total tokens; the maximum is ${definition.limit}.`,
      );
    }
  }
}

/**
 * Evaluates an ordered list of checks against one run, projecting the run's
 * evidence exactly once. Results retain the authored order of the definitions.
 */
export function evaluateChecks(
  state: RunState,
  definitions: readonly CheckDefinition[],
): CheckResult[] {
  const subject = runCheckSubject(state);
  return definitions.map((definition) => ({
    checkId: definition.checkId,
    kind: definition.kind,
    outcome: evaluateCheck(definition, subject),
  }));
}

/**
 * Counts outcomes without deciding whether the run passed. Whether a
 * `not-evaluated` check blocks a pass is a suite-level scoring rule, and it is
 * deliberately not decided here.
 */
export function checkOutcomeSummary(
  results: readonly CheckResult[],
): CheckOutcomeSummary {
  return {
    total: results.length,
    passed: results.filter(({ outcome }) => outcome.status === "passed").length,
    failed: results.filter(({ outcome }) => outcome.status === "failed").length,
    notEvaluated: results.filter(({ outcome }) => outcome.status === "not-evaluated")
      .length,
  };
}
