import { z } from "zod";

import { parseJsonInput, type JsonInputPolicy } from "./json-input.ts";
import { evaluateJsonSchema } from "./json-schema/evaluator.ts";
import { formatSchemaIssue } from "./json-schema/diagnostics.ts";
export { formatSchemaIssue } from "./json-schema/diagnostics.ts";
import { MAX_SCHEMA_OUTPUT_CODE_UNITS, SCHEMA_CHECK_LIMITS } from "./json-schema/limits.ts";
import { preflightJsonSchema } from "./json-schema/preflight.ts";
import { runMetrics } from "./run-metrics.ts";
import type { AttemptUsageCoverage } from "./run-metrics.ts";
import { finalAssistantOutput, outputCharacterCount, toolCallsInRun } from "./run-output.ts";
import type { ToolCallEvidence } from "./run-output.ts";
import {
  executeSafeRegex,
  SAFE_REGEX_SYNTAX,
  validateSafeRegex,
} from "./safe-regex.ts";
import type { DecisionAnswer, DecisionRun } from "./decision.ts";
import type {
  CheckId,
  EntityId,
  EntityIdKind,
  JsonObject,
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
export const CHECK_SCHEMA_VERSION = 5;

/** Vocabulary versions a container may declare; each still means what it meant. */
export const SUPPORTED_CHECK_SCHEMA_VERSIONS = [3, 4, 5] as const;
export type CheckSchemaVersion = (typeof SUPPORTED_CHECK_SCHEMA_VERSIONS)[number];

/**
 * Why `definition` cannot appear in a container that declares `version`, or
 * undefined when it can. Version 4 added JSON Schema checks and JSON input
 * policies, and version 5 the decision kinds; an older container must reject
 * them rather than acquire them.
 */
export function checkVocabularyIssue(
  definition: CheckDefinition,
  version: CheckSchemaVersion,
): string | undefined {
  if (version < 5 && isDecisionCheckKind(definition.kind)) {
    return `This check requires check vocabulary version 5; the container declares version ${version}.`;
  }
  if (version >= 4) return undefined;
  if (definition.kind === "json-schema" || (definition.kind === "valid-json" && definition.inputPolicy !== undefined)) {
    return `This check requires check vocabulary version 4; the container declares version ${version}.`;
  }
  return undefined;
}

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
  "json-schema",
  "max-output-characters",
  "max-duration-ms",
  "max-total-tokens",
  "called-tool",
  "did-not-call-tool",
  "tool-call-count",
  "tool-call-arguments",
  "decision-choice",
  "decision-option-probability",
  "decision-score-range",
  "decision-noul",
  "decision-confidence",
] as const;

export type CheckKind = (typeof CHECK_KINDS)[number];

/** Kinds that read only what both run kinds report: wall time and usage. */
export const SHARED_CHECK_KINDS = ["max-duration-ms", "max-total-tokens"] as const satisfies readonly CheckKind[];

/** Kinds that read a decision run's answers. Each names one question id (D34). */
export const DECISION_CHECK_KINDS = [
  "decision-choice",
  "decision-option-probability",
  "decision-score-range",
  "decision-noul",
  "decision-confidence",
] as const satisfies readonly CheckKind[];

export type DecisionCheckKind = (typeof DECISION_CHECK_KINDS)[number];

/** Kinds that read a chat run's output or tool calls. */
export const CHAT_CHECK_KINDS = CHECK_KINDS.filter(
  (kind): kind is Exclude<CheckKind, DecisionCheckKind | (typeof SHARED_CHECK_KINDS)[number]> =>
    !(DECISION_CHECK_KINDS as readonly string[]).includes(kind) && !(SHARED_CHECK_KINDS as readonly string[]).includes(kind),
);

export function isDecisionCheckKind(kind: CheckKind): kind is DecisionCheckKind {
  return (DECISION_CHECK_KINDS as readonly string[]).includes(kind);
}

/**
 * D34 gives each run kind only the checks that read its evidence; shared kinds
 * fit both. Authoring offers only those, so this refuses a hand-edited project
 * or plan the same way.
 */
export function checkRunKindIssue(kind: CheckKind, runKind: "chat" | "decision"): string | undefined {
  if ((SHARED_CHECK_KINDS as readonly string[]).includes(kind)) return undefined;
  const decision = isDecisionCheckKind(kind);
  if (runKind === "decision" && !decision) {
    return `"${kind}" checks read a chat run's output or tool calls; a decision suite cannot hold them.`;
  }
  if (runKind === "chat" && decision) {
    return `"${kind}" checks read a decision run's answers; a chat suite cannot hold them.`;
  }
  return undefined;
}

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
  /** Where the JSON may sit in the answer. Defaults to `"strict"`: the whole answer. */
  inputPolicy?: JsonInputPolicy;
}

/**
 * Validates the answer's JSON payload against an authored schema in IF's
 * draft-07 profile (docs/JSON_SCHEMA_PREFLIGHT.md). The schema describes the
 * payload directly. Not negatable: "does not satisfy this schema" would make
 * invalid JSON pass, and nobody means to assert that.
 */
export interface JsonSchemaCheck extends CheckDefinitionBase {
  kind: "json-schema";
  dialect: "draft-07";
  schema: JsonObject | boolean;
  /** Defaults to `"strict"`. */
  inputPolicy?: JsonInputPolicy;
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

/**
 * Tool-call kinds match any turn of the run (D13): a call anywhere in the
 * trace satisfies them, not only the last turn. `toolName` matches
 * `ToolCall.name` exactly, the same provider-visible name an executor binds
 * to — not a project `ToolId`, which a check definition never references.
 */
export interface CalledToolCheck extends CheckDefinitionBase {
  kind: "called-tool";
  toolName: string;
}

export interface DidNotCallToolCheck extends CheckDefinitionBase {
  kind: "did-not-call-tool";
  toolName: string;
}

export type ToolCallCountComparator = "exact" | "at-least" | "at-most";

export interface ToolCallCountCheck extends CheckDefinitionBase {
  kind: "tool-call-count";
  /** Omitted counts every tool call in the run, regardless of name. */
  toolName?: string;
  count: number;
  comparator: ToolCallCountComparator;
}

/**
 * Matches when some call to `toolName` has parsed JSON-object arguments that
 * are a superset of `argumentsSubset` (D13): every key in `argumentsSubset`
 * must be present with an equal value, recursively for nested objects. Arrays
 * compare by deep equality — arbitrary partial array matching is ambiguous.
 * A call whose arguments never resolved to a JSON object cannot match.
 */
export interface ToolCallArgumentsCheck extends CheckDefinitionBase {
  kind: "tool-call-arguments";
  toolName: string;
  argumentsSubset: JsonObject;
}

/**
 * Decision kinds (D34). Each names one question id. Probability and
 * confidence values are in [0, 1]. A question id the pinned revision lacks, or
 * a question of the wrong type for the kind, is a preflight diagnostic; at
 * evaluation it reads as `not-evaluated`.
 */
export interface DecisionChoiceCheck extends NegatableCheckBase {
  kind: "decision-choice";
  questionId: string;
  option: string;
}

export type DecisionBoundComparator = "at-least" | "at-most";

/** For a score question, `option` is the level number as a string. */
export interface DecisionOptionProbabilityCheck extends CheckDefinitionBase {
  kind: "decision-option-probability";
  questionId: string;
  option: string;
  comparator: DecisionBoundComparator;
  value: number;
}

/** Inclusive bounds on the fractional score; at least one is present. */
export interface DecisionScoreRangeCheck extends CheckDefinitionBase {
  kind: "decision-score-range";
  questionId: string;
  min?: number;
  max?: number;
}

/** Bounds P(true). */
export interface DecisionNoulCheck extends CheckDefinitionBase {
  kind: "decision-noul";
  questionId: string;
  comparator: DecisionBoundComparator;
  value: number;
}

/** Choice and score only; an answer without confidence is `not-evaluated`. */
export interface DecisionConfidenceCheck extends CheckDefinitionBase {
  kind: "decision-confidence";
  questionId: string;
  atLeast: number;
}

export type DecisionCheckDefinition =
  | DecisionChoiceCheck
  | DecisionOptionProbabilityCheck
  | DecisionScoreRangeCheck
  | DecisionNoulCheck
  | DecisionConfidenceCheck;

export type CheckDefinition =
  | ExactMatchCheck
  | ContainsCheck
  | RegexCheck
  | ValidJsonCheck
  | JsonSchemaCheck
  | MaxOutputCharactersCheck
  | MaxDurationCheck
  | MaxTotalTokensCheck
  | CalledToolCheck
  | DidNotCallToolCheck
  | ToolCallCountCheck
  | ToolCallArgumentsCheck
  | DecisionCheckDefinition;

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
  /**
   * The canonical tool-call projection, always set for a completed run — an
   * empty array means "no tool calls happened" and is real evidence, unlike
   * this struct's other optional fields, whose absence means the provider
   * never reported the quantity at all.
   */
  toolCalls?: ToolCallEvidence[];
}

/**
 * Everything the check vocabulary may read about a decision run (D48),
 * projected once. Absence is preserved as for `RunCheckSubject`: usage the
 * provider never reported stays absent rather than reading as zero.
 */
export interface DecisionCheckSubject {
  kind: "decision";
  /** Set when the run itself cannot support any assertion. */
  unavailable?: string;
  /** The completed attempt's normalized answers, keyed by question id. */
  answers?: Record<string, DecisionAnswer>;
  /** Wall time from the run's start to its end, retries included. */
  totalDurationMs?: number;
  totalTokenCoverage?: AttemptUsageCoverage;
  reportedTotalTokens?: number;
}

/**
 * What one check is evaluated against. A chat subject carries no `kind`, which
 * kept every existing caller unchanged when decision subjects arrived.
 */
export type CheckSubject = (RunCheckSubject & { kind?: "chat" }) | DecisionCheckSubject;

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

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
const jsonObjectSchema = z.record(z.string(), jsonValueSchema) as z.ZodType<JsonObject>;

const toolCallCountComparator = z.enum(["exact", "at-least", "at-most"]);

const inputPolicy = z.enum(["strict", "surrounding-fence", "first-json-fence"]).optional();
const jsonSchemaShape = {
  ...definitionBase,
  kind: z.literal("json-schema"),
  dialect: z.literal("draft-07"),
  schema: z.union([z.boolean(), jsonObjectSchema]),
  inputPolicy,
};

/** A runnable schema check must pass preflight; authored drafts need not. */
function refineRunnableSchema(definition: CheckDefinition, context: z.RefinementCtx): void {
  if (definition.kind !== "json-schema") return;
  const preflight = preflightJsonSchema(definition.schema, SCHEMA_CHECK_LIMITS.schema);
  if (preflight.status === "not-evaluated") {
    context.addIssue({
      code: "custom",
      path: ["schema", ...preflight.diagnostic.schemaPath],
      message: preflight.diagnostic.message,
    });
  }
}

const calledToolShape = { ...definitionBase, toolName: z.string() };
const toolCallCountShape = {
  ...definitionBase,
  toolName: z.string().optional(),
  count: z.number().int().nonnegative(),
  comparator: toolCallCountComparator,
};
const toolCallArgumentsShape = {
  ...definitionBase,
  toolName: z.string(),
  argumentsSubset: jsonObjectSchema,
};

const probability = z.number().min(0).max(1);
const decisionBoundComparator = z.enum(["at-least", "at-most"]);

/**
 * The decision kinds' shapes. `text` is a runnable plan's identifier rule,
 * where an empty question or option cannot run; authoring relaxes it so
 * "+ Add check" can leave them for preflight to name.
 */
function decisionCheckShapes(text: z.ZodString) {
  return [
    z.object({ ...negatableBase, kind: z.literal("decision-choice"), questionId: text, option: text }).strict(),
    z.object({
      ...definitionBase,
      kind: z.literal("decision-option-probability"),
      questionId: text,
      option: text,
      comparator: decisionBoundComparator,
      value: probability,
    }).strict(),
    z.object({
      ...definitionBase,
      kind: z.literal("decision-score-range"),
      questionId: text,
      min: z.number().finite().optional(),
      max: z.number().finite().optional(),
    }).strict(),
    z.object({
      ...definitionBase,
      kind: z.literal("decision-noul"),
      questionId: text,
      comparator: decisionBoundComparator,
      value: probability,
    }).strict(),
    z.object({ ...definitionBase, kind: z.literal("decision-confidence"), questionId: text, atLeast: probability }).strict(),
  ] as const;
}

function refineScoreRange(definition: CheckDefinition, context: z.RefinementCtx): void {
  if (definition.kind !== "decision-score-range") return;
  if (definition.min === undefined && definition.max === undefined) {
    context.addIssue({ code: "custom", path: ["min"], message: "A score range needs a minimum, a maximum, or both." });
  } else if (definition.min !== undefined && definition.max !== undefined && definition.min > definition.max) {
    context.addIssue({ code: "custom", path: ["max"], message: "A score range's maximum must be at least its minimum." });
  }
}

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
        inputPolicy,
      })
      .strict(),
    z.object(jsonSchemaShape).strict(),
    z
      .object({ ...definitionBase, kind: z.literal("max-output-characters"), limit })
      .strict(),
    z
      .object({ ...definitionBase, kind: z.literal("max-duration-ms"), limit })
      .strict(),
    z
      .object({ ...definitionBase, kind: z.literal("max-total-tokens"), limit })
      .strict(),
    z.object({ ...calledToolShape, kind: z.literal("called-tool") }).strict(),
    z.object({ ...calledToolShape, kind: z.literal("did-not-call-tool") }).strict(),
    z.object({ ...toolCallCountShape, kind: z.literal("tool-call-count") }).strict(),
    z.object({ ...toolCallArgumentsShape, kind: z.literal("tool-call-arguments") }).strict(),
    ...decisionCheckShapes(z.string().min(1)),
  ])
  .superRefine((definition, context) => {
    refineRunnableSchema(definition, context);
    refineScoreRange(definition, context);
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
 * Portable project authoring permits two intentionally incomplete states: an
 * empty regex pattern, and a JSON Schema the evaluator does not support yet.
 * Preflight blocks both before an executable plan is created, while every
 * non-empty pattern still receives the exact runtime Safe regex validation here.
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
    z.object({ ...negatableBase, kind: z.literal("valid-json"), topLevel: z.enum(["any", "object", "array"]).optional(), inputPolicy }).strict(),
    z.object(jsonSchemaShape).strict(),
    z.object({ ...definitionBase, kind: z.literal("max-output-characters"), limit }).strict(),
    z.object({ ...definitionBase, kind: z.literal("max-duration-ms"), limit }).strict(),
    z.object({ ...definitionBase, kind: z.literal("max-total-tokens"), limit }).strict(),
    z.object({ ...calledToolShape, kind: z.literal("called-tool") }).strict(),
    z.object({ ...calledToolShape, kind: z.literal("did-not-call-tool") }).strict(),
    z.object({ ...toolCallCountShape, kind: z.literal("tool-call-count") }).strict(),
    z.object({ ...toolCallArgumentsShape, kind: z.literal("tool-call-arguments") }).strict(),
    ...decisionCheckShapes(z.string()),
  ])
  .superRefine((definition, context) => {
    refineScoreRange(definition, context);
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
    toolCalls: toolCallsInRun(state),
  };
}

/**
 * Projects a decision run for the check vocabulary (D48). As for chat, only a
 * completed run can be asserted about. Tokens come from the completed
 * attempt's reported usage: an attempt that failed before an answer reports
 * none, so there is nothing else to add.
 */
export function decisionCheckSubject(run: DecisionRun): DecisionCheckSubject {
  switch (run.status.kind) {
    case "failed":
      return {
        kind: "decision",
        unavailable: `The run failed (${run.status.error.code}) and produced no checkable result.`,
      };
    case "cancelled":
      return { kind: "decision", unavailable: "The run was cancelled and produced no checkable result." };
    case "completed":
      break;
    default:
      return { kind: "decision", unavailable: "The run has not reached a terminal status." };
  }
  const completed = run.attempts.findLast(({ status }) => status === "completed");
  const result = completed?.result;
  if (!result) {
    return { kind: "decision", unavailable: "The run completed without a recorded answer." };
  }
  const startedAt = run.startedAt === undefined ? Number.NaN : Date.parse(run.startedAt);
  const endedAt = run.endedAt === undefined ? Number.NaN : Date.parse(run.endedAt);
  const totalDurationMs = Number.isFinite(startedAt) && Number.isFinite(endedAt) ? endedAt - startedAt : undefined;
  const totalTokens = result.usage?.totalTokens;
  return {
    kind: "decision",
    answers: result.answers,
    ...(totalDurationMs !== undefined ? { totalDurationMs } : {}),
    totalTokenCoverage: { reportedAttempts: totalTokens === undefined ? 0 : 1, totalAttempts: 1 },
    ...(totalTokens !== undefined ? { reportedTotalTokens: totalTokens } : {}),
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

/**
 * True when every key of `expected` is present in `actual` with an equal
 * value. Nested objects recurse the same way; arrays and scalars compare by
 * deep equality, since a partial match inside an array is ambiguous (which
 * element? which order?).
 */
function jsonSubsetMatches(expected: JsonValue, actual: JsonValue): boolean {
  if (
    expected === null ||
    typeof expected !== "object" ||
    Array.isArray(expected) ||
    actual === null ||
    typeof actual !== "object" ||
    Array.isArray(actual)
  ) {
    return JSON.stringify(expected) === JSON.stringify(actual);
  }
  return Object.entries(expected).every(([key, value]) =>
    key in actual && jsonSubsetMatches(value, (actual as JsonObject)[key]),
  );
}

function toolCallsNamed(
  toolCalls: ToolCallEvidence[] | undefined,
  toolName: string,
): ToolCallEvidence[] {
  return (toolCalls ?? []).filter((call) => call.name === toolName);
}

function evaluateOutputCheck(
  definition: ExactMatchCheck | ContainsCheck | RegexCheck | ValidJsonCheck | JsonSchemaCheck,
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
      const parsed = parseJsonInput(output, definition.inputPolicy);
      const topLevel = parsed.valid ? parsed.topLevel : undefined;
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
          // Evidence for a definition without a policy is unchanged from v3.
          ...(definition.inputPolicy !== undefined
            ? { inputPolicy: definition.inputPolicy, ...(parsed.valid ? { path: parsed.path } : {}) }
            : {}),
        },
      );
    }
    case "json-schema":
      return evaluateJsonSchemaCheck(definition, output);
  }
}

function evaluateJsonSchemaCheck(definition: JsonSchemaCheck, output: string): CheckOutcome {
  const policy = definition.inputPolicy ?? "strict";
  // The output limit applies to the original text, before anything parses it.
  if (output.length > MAX_SCHEMA_OUTPUT_CODE_UNITS) {
    return {
      status: "failed",
      message: `Final assistant output is ${output.length} UTF-16 code units; JSON Schema checks accept at most ${MAX_SCHEMA_OUTPUT_CODE_UNITS}.`,
      evidence: { code: "output-too-large", codeUnits: output.length, limit: MAX_SCHEMA_OUTPUT_CODE_UNITS },
    };
  }
  const characters = outputCharacterCount(output);
  const parsed = parseJsonInput(output, policy);
  if (!parsed.valid) {
    return {
      status: "failed",
      message: `Final assistant output is not valid JSON under the ${policy} input policy.`,
      evidence: { code: "invalid-json", inputPolicy: policy, characters },
    };
  }
  const result = evaluateJsonSchema(definition.schema, parsed.value, SCHEMA_CHECK_LIMITS);
  if (result.status === "not-evaluated") return { status: "not-evaluated", reason: result.diagnostic.message };
  const evidence = {
    inputPolicy: policy,
    path: parsed.path,
    characters,
    topLevel: parsed.topLevel,
    ...(result.uncheckedFormats.length > 0
      ? { uncheckedFormats: result.uncheckedFormats.map(({ format, schemaPath }) => ({ format, schemaPath: [...schemaPath] })) }
      : {}),
  };
  if (result.status === "valid") return { status: "passed", evidence };
  // Issues hold authored keywords, property names, and indices; never answer data.
  const issues: JsonObject[] = result.issues.map(({ keyword, location, expectedType, missingProperty }) => ({
    keyword,
    location: location.map((segment): JsonObject => ({ ...segment })),
    ...(expectedType !== undefined ? { expectedType: typeof expectedType === "string" ? expectedType : [...expectedType] } : {}),
    ...(missingProperty !== undefined ? { missingProperty } : {}),
  }));
  // Diagnostics may stop before locating anything; the verdict stands either way.
  const summary = issues.length > 0 ? formatSchemaIssue(issues[0]) : "Final assistant output does not satisfy the schema.";
  const suffix = result.truncated
    ? " More issues may exist than are listed."
    : issues.length > 1 ? ` ${issues.length - 1} more issue${issues.length === 2 ? "" : "s"}.` : "";
  return {
    status: "failed",
    message: summary + suffix,
    evidence: { code: "schema-mismatch", ...evidence, issues, truncated: result.truncated },
  };
}

/**
 * Evaluates one check against one run. Pure: no clock, no I/O, and no mutation
 * of the state passed in. The same run state and definition always produce the
 * same outcome.
 */
export function evaluateCheck(
  definition: CheckDefinition,
  subject: CheckSubject,
): CheckOutcome {
  if (subject.unavailable) {
    return { status: "not-evaluated", reason: subject.unavailable };
  }
  // Authoring and project validation keep each kind to its own suites, so
  // these guard old or hand-edited artifacts only.
  if (subject.kind === "decision") {
    if (isDecisionCheckKind(definition.kind)) return evaluateDecisionCheck(definition as DecisionCheckDefinition, subject);
    if (!(SHARED_CHECK_KINDS as readonly string[]).includes(definition.kind)) {
      return { status: "not-evaluated", reason: "This check reads a chat run's output or tool calls, which a decision run does not have." };
    }
  } else if (isDecisionCheckKind(definition.kind)) {
    return { status: "not-evaluated", reason: "This check reads a decision run's answers, which a chat run does not have." };
  }
  return evaluateSubjectCheck(definition, subject);
}

function evaluateSubjectCheck(
  definition: CheckDefinition,
  subject: CheckSubject,
): CheckOutcome {
  const chat: Partial<RunCheckSubject> = subject.kind === "decision" ? {} : subject;
  switch (definition.kind) {
    case "exact-match":
    case "contains":
    case "regex":
    case "valid-json":
    case "json-schema": {
      if (chat.output === undefined) {
        return {
          status: "not-evaluated",
          reason: "The run produced no final assistant output.",
        };
      }
      return evaluateOutputCheck(definition, chat.output);
    }
    case "max-output-characters": {
      if (chat.output === undefined) {
        return {
          status: "not-evaluated",
          reason: "The run produced no final assistant output.",
        };
      }
      const characters = outputCharacterCount(chat.output);
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
    case "called-tool": {
      const matches = toolCallsNamed(chat.toolCalls, definition.toolName);
      return outcome(
        { called: matches.length > 0, matchingCalls: matches.length },
        matches.length > 0
          ? undefined
          : `The run did not call tool "${definition.toolName}".`,
      );
    }
    case "did-not-call-tool": {
      const matches = toolCallsNamed(chat.toolCalls, definition.toolName);
      return outcome(
        { called: matches.length > 0, matchingCalls: matches.length },
        matches.length === 0
          ? undefined
          : `The run called tool "${definition.toolName}", which it must not call.`,
      );
    }
    case "tool-call-count": {
      const relevant = definition.toolName === undefined
        ? (chat.toolCalls ?? [])
        : toolCallsNamed(chat.toolCalls, definition.toolName);
      const actual = relevant.length;
      const satisfied = definition.comparator === "exact"
        ? actual === definition.count
        : definition.comparator === "at-least"
          ? actual >= definition.count
          : actual <= definition.count;
      const comparatorWord = definition.comparator === "exact"
        ? "exactly"
        : definition.comparator === "at-least"
          ? "at least"
          : "at most";
      const subjectNoun = definition.toolName
        ? `calls to tool "${definition.toolName}"`
        : "tool calls";
      return outcome(
        {
          count: actual,
          expected: definition.count,
          comparator: definition.comparator,
          ...(definition.toolName ? { toolName: definition.toolName } : {}),
        },
        satisfied
          ? undefined
          : `The run made ${actual} ${subjectNoun}; expected ${comparatorWord} ${definition.count}.`,
      );
    }
    case "tool-call-arguments": {
      const matches = toolCallsNamed(chat.toolCalls, definition.toolName);
      const matched = matches.some(
        (call) =>
          call.arguments.parsed !== undefined &&
          jsonSubsetMatches(definition.argumentsSubset, call.arguments.parsed),
      );
      return outcome(
        { matched, calls: matches.length },
        matched
          ? undefined
          : matches.length === 0
            ? `The run did not call tool "${definition.toolName}".`
            : `No call to tool "${definition.toolName}" had arguments matching the expected subset.`,
      );
    }
    case "decision-choice":
    case "decision-option-probability":
    case "decision-score-range":
    case "decision-noul":
    case "decision-confidence":
      return { status: "not-evaluated", reason: "This check reads a decision run's answers, which a chat run does not have." };
  }
}

function bounded(actual: number, comparator: DecisionBoundComparator, value: number): boolean {
  return comparator === "at-least" ? actual >= value : actual <= value;
}

function comparatorWords(comparator: DecisionBoundComparator): string {
  return comparator === "at-least" ? "at least" : "at most";
}

/**
 * Evidence holds the observed choice, probability, score, or confidence and
 * the authored bound: measurements, never state or instructions.
 */
function evaluateDecisionCheck(
  definition: DecisionCheckDefinition,
  subject: DecisionCheckSubject,
): CheckOutcome {
  const answer = subject.answers?.[definition.questionId];
  if (!answer) {
    return { status: "not-evaluated", reason: `The run has no answer for question "${definition.questionId}".` };
  }
  const wrongType = (expected: string): CheckOutcome => ({
    status: "not-evaluated",
    reason: `Question "${definition.questionId}" was answered as a ${answer.type} question; this check needs ${expected}.`,
  });
  switch (definition.kind) {
    case "decision-choice": {
      if (answer.type !== "choice") return wrongType("a choice question");
      return decide(
        answer.choice === definition.option,
        definition.negate,
        {
          whenUnsatisfied: `Question "${definition.questionId}" chose "${answer.choice}", not "${definition.option}".`,
          whenSatisfied: `Question "${definition.questionId}" chose "${definition.option}", which it must not choose.`,
        },
        { choice: answer.choice, expected: definition.option },
      );
    }
    case "decision-option-probability": {
      if (answer.type === "noul") return wrongType("a choice or score question");
      const probability = answer.probabilities[definition.option];
      if (probability === undefined) {
        return {
          status: "not-evaluated",
          reason: `The answer to question "${definition.questionId}" reports no probability for "${definition.option}".`,
        };
      }
      return outcome(
        { probability, comparator: definition.comparator, value: definition.value },
        bounded(probability, definition.comparator, definition.value)
          ? undefined
          : `P("${definition.option}") for question "${definition.questionId}" is ${probability}; expected ${comparatorWords(definition.comparator)} ${definition.value}.`,
      );
    }
    case "decision-score-range": {
      if (answer.type !== "score") return wrongType("a score question");
      const { score } = answer;
      const inRange = (definition.min === undefined || score >= definition.min)
        && (definition.max === undefined || score <= definition.max);
      const range = definition.min !== undefined && definition.max !== undefined
        ? `between ${definition.min} and ${definition.max}`
        : definition.min !== undefined ? `at least ${definition.min}` : `at most ${definition.max}`;
      return outcome(
        {
          score,
          ...(definition.min !== undefined ? { min: definition.min } : {}),
          ...(definition.max !== undefined ? { max: definition.max } : {}),
        },
        inRange ? undefined : `Question "${definition.questionId}" scored ${score}; expected ${range}.`,
      );
    }
    case "decision-noul": {
      if (answer.type !== "noul") return wrongType("a noul question");
      return outcome(
        { noul: answer.noul, comparator: definition.comparator, value: definition.value },
        bounded(answer.noul, definition.comparator, definition.value)
          ? undefined
          : `P(true) for question "${definition.questionId}" is ${answer.noul}; expected ${comparatorWords(definition.comparator)} ${definition.value}.`,
      );
    }
    case "decision-confidence": {
      if (answer.type === "noul") return wrongType("a choice or score question");
      if (answer.confidence === undefined) {
        return { status: "not-evaluated", reason: `The answer to question "${definition.questionId}" reports no confidence.` };
      }
      return outcome(
        { confidence: answer.confidence, atLeast: definition.atLeast },
        answer.confidence >= definition.atLeast
          ? undefined
          : `Confidence for question "${definition.questionId}" is ${answer.confidence}; expected at least ${definition.atLeast}.`,
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
  const steps = evaluateChecksSteps(state, definitions);
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}

/** Scheduling seam: each next() decides at most one check, with no partial
 * results exposed. The caller owns when to resume; budgets remain per check. */
export function* evaluateChecksSteps(
  state: RunState,
  definitions: readonly CheckDefinition[],
): Generator<void, CheckResult[]> {
  return yield* evaluateSubjectChecksSteps(runCheckSubject(state), definitions);
}

/** As `evaluateChecksSteps`, for evidence already projected from either run kind. */
export function* evaluateSubjectChecksSteps(
  subject: CheckSubject,
  definitions: readonly CheckDefinition[],
): Generator<void, CheckResult[]> {
  const results: CheckResult[] = [];
  for (const definition of definitions) {
    results.push({
      checkId: definition.checkId,
      kind: definition.kind,
      outcome: evaluateCheck(definition, subject),
    });
    yield;
  }
  return results;
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
