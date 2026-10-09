import { z } from "zod";

import {
  CHECK_SCHEMA_VERSION,
  checkDefinitionSchema,
  checkOutcomeSummary,
  evaluateChecks,
} from "./checks.ts";
import type { CheckDefinition, CheckResult } from "./checks.ts";
import { isSensitiveTemplateVariableName } from "./project.ts";
import { runMetrics } from "./run-metrics.ts";
import { finalAssistantOutput, outputCharacterCount } from "./run-output.ts";
import { stableJsonValue } from "./stable-json.ts";
import { toolNameSchema } from "./tool-name.ts";
import {
  DEFAULT_EXPERIMENT_TURN_CEILING,
  MAX_EXPERIMENT_TURN_CEILING,
  MIN_EXPERIMENT_TURN_CEILING,
} from "./turn-ceiling.ts";
import type {
  ConnectionProfileId,
  ConversationMessage,
  ConversationRevisionId,
  EntityId,
  EntityIdKind,
  EvaluationAssessmentId,
  EvaluationCaseId,
  EvaluationInputBindingId,
  EvaluationSuiteId,
  EvaluationVariantId,
  ExperimentCellId,
  ExperimentId,
  InferenceOptions,
  JsonObject,
  JsonValue,
  ResolvedRunInput,
  ResolvedTemplateUse,
  RunId,
  RunState,
  TerminalRunStatus,
  ToolDefinition,
  PromptTemplateUseId,
} from "./run-kernel/types.ts";
import { PROVIDER_WIRE_PROTOCOLS } from "./run-kernel/types.ts";

export const EXPERIMENT_SCHEMA_VERSION = 4;
/**
 * Results moved to Version 5 alone, to record a batch that stopped itself, and
 * to Version 6 to record the concurrency and retry policy they ran under and
 * the order their cells started in. Plans did not change shape, so they keep Version 4.
 */
export const EXPERIMENT_RESULT_SCHEMA_VERSION = 6;
/** The project-folder directory that holds experiment plans, results, and assessments. */
export const EXPERIMENTS_DIRECTORY_NAME = "experiments";
export const EXPERIMENT_PLAN_FILE_SUFFIX = ".plan.json";
export const EXPERIMENT_RESULT_FILE_SUFFIX = ".result.json";
/**
 * Reassessments live beside the plan and result they reinterpret, so they
 * inherit the same immutable, write-once storage contract on both shells.
 * The name carries only the assessment ID: the artifact's own `experimentId`
 * field is authoritative, and an experiment ID may legally contain `.`, which
 * leaves a two-ID name with no unambiguous split point.
 */
export const EVALUATION_ASSESSMENT_FILE_SUFFIX = ".assessment.json";

/**
 * How many provider turns one repetition may start.
 *
 * Turns rather than tool rounds, because the turn is what a provider bills and
 * what a cost estimate is expressed in. Without exposed tools a repetition can
 * never reach turn two, so the ceiling only becomes observable once tools are
 * served automatically — which is exactly when a runaway loop can be paid for.
 *
 * The minimum is two rather than one: a ceiling of one would expose tools and
 * then guarantee that every repetition asking for one fails.
 */
export {
  DEFAULT_EXPERIMENT_TURN_CEILING,
  MAX_EXPERIMENT_TURN_CEILING,
  MIN_EXPERIMENT_TURN_CEILING,
} from "./turn-ceiling.ts";

export class ExperimentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExperimentValidationError";
  }
}

export interface ExperimentCellBase {
  cellId: ExperimentCellId;
  ordinal: number;
  runId: RunId;
}

export type RepeatedExperimentCell = ExperimentCellBase;

export interface RepeatedExperimentPlanV4 {
  schemaVersion: 4;
  experimentId: ExperimentId;
  kind: "repeated-request";
  createdAt: string;
  commonInput: Omit<ResolvedRunInput, "runId">;
  /**
   * Provider turns one repetition may start before it is failed.
   *
   * Optional so that plans written before automatic tool continuation still
   * parse; absent reads as `DEFAULT_EXPERIMENT_TURN_CEILING`. It lives in the
   * plan rather than beside it because it bounds what the repetitions may
   * spend, and a plan re-read later has to say what bounded the run it
   * describes.
   */
  turnCeiling?: number;
  cells: RepeatedExperimentCell[];
}

export interface EvaluationInputBindingSnapshot {
  id: EvaluationInputBindingId;
  name: string;
  target: {
    kind: "template-variable";
    templateUseId: PromptTemplateUseId;
    variableName: string;
  };
}

export interface EvaluationCaseSnapshotV4 {
  caseId: EvaluationCaseId;
  name: string;
  values: Record<EvaluationInputBindingId, string>;
  checks: CheckDefinition[];
  referenceAnswer?: string;
  input: Pick<ResolvedRunInput,
    "conversationId" | "conversationRevisionId" | "messages" | "templateResolutions" | "resolvedAt"
  >;
}

export interface EvaluationVariantSnapshotV4 {
  variantId: EvaluationVariantId;
  name: string;
  target: ResolvedRunInput["target"];
  responseMode: ResolvedRunInput["responseMode"];
  options: InferenceOptions;
}

export interface EvaluationExperimentCellV4 extends ExperimentCellBase {
  caseId: EvaluationCaseId;
  variantId: EvaluationVariantId;
  repetition: number;
}

export interface EvaluationExperimentPlanV4 {
  schemaVersion: 4;
  experimentId: ExperimentId;
  kind: "evaluation";
  createdAt: string;
  checkSchemaVersion: typeof CHECK_SCHEMA_VERSION;
  scoringPolicy: "strict";
  repetitions: number;
  /** See `RepeatedExperimentPlanV4.turnCeiling`; the controller reads both. */
  turnCeiling?: number;
  suite: {
    suiteId: EvaluationSuiteId;
    name: string;
    conversationRevisionId: ConversationRevisionId;
    inputBindings: EvaluationInputBindingSnapshot[];
    tools: ToolDefinition[];
    cases: EvaluationCaseSnapshotV4[];
    variants: EvaluationVariantSnapshotV4[];
  };
  cells: EvaluationExperimentCellV4[];
}

export type ExperimentPlanV4 = RepeatedExperimentPlanV4 | EvaluationExperimentPlanV4;
export type ExperimentCell = RepeatedExperimentCell | EvaluationExperimentCellV4;
// Source-level aliases keep feature owners compiling while they adopt the v4
// snapshot shape. They never accept or emit a v3 artifact.
export type RepeatedExperimentPlanV3 = RepeatedExperimentPlanV4;
export type EvaluationExperimentPlanV3 = EvaluationExperimentPlanV4;
export type ExperimentPlanV3 = ExperimentPlanV4;
export type ExperimentResultV3 = ExperimentResultV4;
/** The current in-memory result. Every accepted result is read as this. */
export type ExperimentResult = ExperimentResultV6;
/** A result as it may arrive from storage or a caller: any readable version. */
export type ExperimentResultInput = ExperimentResultV4 | ExperimentResultV5 | ExperimentResultV6;
export type EvaluationCaseSnapshot = EvaluationCaseSnapshotV4;

export interface ExperimentTerminalCellResult {
  cellId: ExperimentCellId;
  runId: RunId;
  status: TerminalRunStatus["kind"];
}

export interface ExperimentNotRunCellResult {
  cellId: ExperimentCellId;
  runId: RunId;
  status: "not-run";
}

export type ExperimentCellResult =
  | ExperimentTerminalCellResult
  | ExperimentNotRunCellResult;

/** A started cell, as Version 6 records it. */
export interface ExperimentStartedCellResultV6 extends ExperimentTerminalCellResult {
  /**
   * One-based position among the cells this experiment started. Cells are
   * stored in plan order; this says when each one began.
   */
  startOrder: number;
}

export type ExperimentCellResultV6 =
  | ExperimentStartedCellResultV6
  | ExperimentNotRunCellResult;

/**
 * The limit one connection ran under. A connection is identified the way the
 * scheduler keys prepared credentials: the target's profile and endpoint.
 */
export interface ExperimentConnectionConcurrency {
  profileId: ConnectionProfileId;
  endpoint: string;
  /** Most cells for this connection that could be in flight at once. */
  limit: number;
}

/**
 * Which failed attempts the scheduler may retry, keyed by failure class so a
 * later version can add a class (a 5xx, say) with its own bound. Version 6
 * knows only rate limiting.
 */
export interface ExperimentRetryPolicy {
  /** A provider 429. `maxRetries: 0` means a 429 fails its repetition. */
  rateLimited: { maxRetries: number };
}

/** Retries off: what every result before Version 6 ran with, and the default. */
export function noExperimentRetries(): ExperimentRetryPolicy {
  return { rateLimited: { maxRetries: 0 } };
}

/**
 * How many cells could be in flight: at most `maxInFlight` across the whole
 * experiment, and at most each connection's `limit` on that connection. An
 * overall limit of 1 is one cell at a time, whatever the connection limits.
 */
export interface ExperimentConcurrency {
  maxInFlight: number;
  /** One entry per distinct connection, in the order the plan first uses it. */
  connections: ExperimentConnectionConcurrency[];
}

export interface ExperimentResultV4 {
  schemaVersion: 4;
  experimentId: ExperimentId;
  status: "completed" | "cancelled";
  endedAt: string;
  cells: ExperimentCellResult[];
}

/**
 * Why a batch stopped itself. Only a tool binding that can no longer serve any
 * repetition stops a batch; every other failure fails one repetition.
 */
export interface ExperimentStop {
  reason: "tool_unavailable";
  /** The failed repetition that found the tool unavailable. */
  cellId: ExperimentCellId;
  toolId: ToolDefinition["id"];
}

export interface ExperimentResultV5 {
  schemaVersion: 5;
  experimentId: ExperimentId;
  status: "completed" | "cancelled" | "stopped";
  /** Present exactly when `status` is `stopped`. */
  stop?: ExperimentStop;
  endedAt: string;
  cells: ExperimentCellResult[];
}

export interface ExperimentStopV6 extends ExperimentStop {
  /**
   * How many cells had started when the stop was recorded. No cell starts
   * after it, so every started cell's `startOrder` is at most this.
   */
  startedCells: number;
}

export interface ExperimentResultV6 {
  schemaVersion: 6;
  experimentId: ExperimentId;
  status: "completed" | "cancelled" | "stopped";
  /** Present exactly when `status` is `stopped`. */
  stop?: ExperimentStopV6;
  endedAt: string;
  concurrency: ExperimentConcurrency;
  retryPolicy: ExperimentRetryPolicy;
  /** Always in plan order, whatever order the cells finished in. */
  cells: ExperimentCellResultV6[];
}

export type EvaluationRepetitionClassification =
  | "passed"
  | "check-failed"
  | "not-evaluated"
  | "run-failed"
  | "cancelled"
  | "not-run"
  | "trace-unavailable";

export interface EvaluationRepetitionAssessment {
  cellId: ExperimentCellId;
  runId: RunId;
  repetition: number;
  classification: EvaluationRepetitionClassification;
  checks: CheckResult[];
}

export interface EvaluationCaseAssessment {
  caseId: EvaluationCaseId;
  name: string;
  passed: boolean;
  repetitions: EvaluationRepetitionAssessment[];
}

export interface EvaluationCaseCounts {
  total: number;
  passed: number;
  failed: number;
  incomplete: number;
}

/** One configuration's independently-scored view of an evaluation bakeoff. */
export interface EvaluationVariantAssessment {
  variant: EvaluationVariantSnapshotV4;
  lifecycle: ExperimentLifecycle;
  passed: boolean;
  cases: EvaluationCaseAssessment[];
  caseCounts: EvaluationCaseCounts;
  repetitionCounts: Record<EvaluationRepetitionClassification, number>;
  checkCounts: { total: number; passed: number; failed: number; notEvaluated: number };
  totalDurationMs: ExperimentMetricRange;
  totalTokens: ExperimentUsageAggregate;
  outputTokens: ExperimentUsageAggregate;
}

/**
 * Replacement criteria for one re-derivation, keyed by the execution's own
 * stable case identity.
 *
 * A plain map rather than a saved artifact on purpose: the same override serves
 * a never-persisted preview against the current authored suite and a saved
 * reassessment read back from disk, and the scoring aggregate has no business
 * knowing which of those it was handed. A case the map omits keeps the
 * execution's own checks, so correcting one case never blanks the others.
 */
export type EvaluationCriteriaOverride = ReadonlyMap<EvaluationCaseId, readonly CheckDefinition[]>;

/** Ordered results for the immutable configuration snapshots in a plan. */
export interface EvaluationBakeoffAssessment {
  lifecycle: ExperimentLifecycle;
  variants: EvaluationVariantAssessment[];
}

export type ExperimentLifecycle = "interrupted" | "completed" | "cancelled" | "stopped";

export interface ExperimentMetricRange {
  count: number;
  min?: number;
  median?: number;
  max?: number;
}

export interface ExperimentUsageAggregate {
  reportedRuns: number;
  total?: number;
}

export interface RepeatedExperimentAggregate {
  lifecycle: ExperimentLifecycle;
  requested: number;
  completed: number;
  failed: number;
  cancelled: number;
  notRun: number;
  missingTrace: number;
  runsWithRetries: number;
  totalDurationMs: ExperimentMetricRange;
  ttfoMs: ExperimentMetricRange;
  reportedTotalTokens: ExperimentMetricRange;
  reportedOutputTokens: ExperimentMetricRange;
  totalTokens: ExperimentUsageAggregate;
  outputTokens: ExperimentUsageAggregate;
  outputTokensPerSecond: ExperimentMetricRange;
  /**
   * Turn and tool-call variation across repetitions. Two repetitions of one
   * frozen request that took a different number of turns did different work,
   * which the token ranges alone can hide.
   */
  turnsPerRun: ExperimentMetricRange;
  toolCallsPerRun: ExperimentMetricRange;
  distinctFinalAssistantOutputs: number;
  outputCharacterCount: ExperimentMetricRange;
}

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const jsonObjectSchema = z.record(z.string(), jsonValueSchema) as z.ZodType<JsonObject>;

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

const contentPartSchema = z.object({ type: z.literal("text"), text: z.string() }).strict();

const toolCallSchema = z
  .object({
    id: entityId("tool-call"),
    providerCallId: z.string().optional(),
    name: z.string(),
    arguments: z
      .object({ text: z.string(), parsed: jsonObjectSchema.optional() })
      .strict(),
  })
  .strict();

const messageBaseSchema = {
  id: entityId("message"),
  content: z.array(contentPartSchema),
};

const conversationMessageSchema: z.ZodType<ConversationMessage> = z.discriminatedUnion(
  "role",
  [
    z.object({ ...messageBaseSchema, role: z.literal("system") }).strict(),
    z.object({ ...messageBaseSchema, role: z.literal("user") }).strict(),
    z
      .object({
        ...messageBaseSchema,
        role: z.literal("assistant"),
        toolCalls: z.array(toolCallSchema).optional(),
      })
      .strict(),
    z
      .object({
        ...messageBaseSchema,
        role: z.literal("tool"),
        toolCallId: entityId("tool-call"),
        name: z.string().optional(),
      })
      .strict(),
  ],
);

const inferenceOptionsSchema: z.ZodType<InferenceOptions> = z
  .object({
    temperature: z.number().finite().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    seed: z.number().int().optional(),
    stop: z.array(z.string()).optional(),
    providerOptions: jsonObjectSchema.optional(),
  })
  .strict();

const toolDefinitionSchema: z.ZodType<ToolDefinition> = z
  .object({
    id: entityId("tool"),
    name: toolNameSchema,
    description: z.string().optional(),
    inputSchema: jsonObjectSchema,
    providerOptions: jsonObjectSchema.optional(),
    source: z.object({
      kind: z.literal("mcp"),
      remoteToolName: z.string().min(1),
      discoveryFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict().optional(),
  })
  .strict();

const resolvedTemplateUseBaseSchema = z.object({
    templateUseId: entityId("template-use"),
    templateId: entityId("template"),
    templateRevisionId: entityId("template-revision"),
    templateName: z.string(),
    variableDefaults: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()),
    values: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()),
    outputMessageIds: z.array(entityId("message")).min(1),
  });

const templateMessagesSchema = z
  .array(
    z
      .object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.string(),
      })
      .strict(),
  )
  .min(1) as unknown as z.ZodType<ResolvedTemplateUse["messages"]>;

const resolvedTemplateUseSchema: z.ZodType<ResolvedTemplateUse> =
  resolvedTemplateUseBaseSchema
    .extend({ messages: templateMessagesSchema })
    .strict();

const capabilitiesSchema = z
  .object({
    chatCompletions: z.boolean(),
    responsesApi: z.boolean(),
    // Recorded before the protocol existed means it was not enabled.
    anthropicMessages: z.boolean().default(false),
    streaming: z.boolean(),
    modelDiscovery: z.boolean(),
    tools: z.boolean(),
    parallelToolCalls: z.boolean(),
    structuredOutput: z.boolean(),
    vision: z.boolean(),
    embeddings: z.boolean(),
  })
  .strict();

const commonInputBaseSchema = z
  .object({
    conversationId: entityId("conversation"),
    conversationRevisionId: entityId("revision"),
    target: z
      .object({
        profileId: entityId("profile"),
        protocol: z.enum([...PROVIDER_WIRE_PROTOCOLS, "mock"]),
        endpoint: z
          .url()
          .refine(
            (value) => {
              const endpoint = new URL(value);
              return (
                (endpoint.protocol === "http:" || endpoint.protocol === "https:") &&
                !endpoint.username &&
                !endpoint.password &&
                !endpoint.search &&
                !endpoint.hash
              );
            },
            "Endpoint must use HTTP or HTTPS without credentials, query parameters, or fragments.",
          ),
        model: z.string().min(1),
        capabilities: capabilitiesSchema,
      })
      .strict(),
    messages: z.array(conversationMessageSchema),
    responseMode: z.enum(["streaming", "buffered"]),
    options: inferenceOptionsSchema,
    tools: z.array(toolDefinitionSchema),
    resolvedAt: z.string().datetime(),
  });

const commonInputSchema = commonInputBaseSchema
  .extend({ templateResolutions: z.array(resolvedTemplateUseSchema) })
  .strict();

const experimentCellBaseSchema = z.object({
  cellId: entityId("experiment-cell"),
  ordinal: z.number().int().positive(),
  runId: entityId("run"),
});

const turnCeilingSchema = z
  .number()
  .int()
  .min(MIN_EXPERIMENT_TURN_CEILING)
  .max(MAX_EXPERIMENT_TURN_CEILING);

const planBaseSchema = z.object({
  experimentId: entityId("experiment"),
  createdAt: z.string().datetime(),
});

const repeatedPlanSchema = planBaseSchema.extend({
    schemaVersion: z.literal(EXPERIMENT_SCHEMA_VERSION),
    kind: z.literal("repeated-request"),
    commonInput: commonInputSchema,
    turnCeiling: turnCeilingSchema.optional(),
    cells: z.array(experimentCellBaseSchema.strict()).min(2),
  })
  .strict();

const evaluationInputBindingSchema = z.object({
  id: entityId("evaluation-input"),
  name: z.string().trim().min(1),
  target: z.object({
    kind: z.literal("template-variable"),
    templateUseId: entityId("template-use"),
    variableName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  }).strict(),
}).strict();

const evaluationCaseSnapshotSchema = z.object({
  caseId: entityId("evaluation-case"),
  name: z.string().trim().min(1),
  values: z.record(entityId("evaluation-input"), z.string()),
  checks: z.array(checkDefinitionSchema).min(1),
  referenceAnswer: z.string().optional(),
  input: commonInputSchema.pick({
    conversationId: true,
    conversationRevisionId: true,
    messages: true,
    templateResolutions: true,
    resolvedAt: true,
  }),
}).strict();

const evaluationVariantSnapshotSchema = z.object({
  variantId: entityId("evaluation-variant"),
  name: z.string().trim().min(1),
  target: commonInputBaseSchema.shape.target,
  responseMode: z.enum(["streaming", "buffered"]),
  options: inferenceOptionsSchema,
}).strict();

const evaluationPlanSchema = planBaseSchema.extend({
  schemaVersion: z.literal(EXPERIMENT_SCHEMA_VERSION),
  kind: z.literal("evaluation"),
  checkSchemaVersion: z.literal(CHECK_SCHEMA_VERSION),
  scoringPolicy: z.literal("strict"),
  repetitions: z.number().int().positive(),
  turnCeiling: turnCeilingSchema.optional(),
  suite: z.object({
    suiteId: entityId("evaluation-suite"),
    name: z.string().trim().min(1),
    conversationRevisionId: entityId("revision"),
    inputBindings: z.array(evaluationInputBindingSchema),
    tools: z.array(toolDefinitionSchema),
    cases: z.array(evaluationCaseSnapshotSchema).min(1),
    variants: z.array(evaluationVariantSnapshotSchema).min(1),
  }).strict(),
  cells: z.array(experimentCellBaseSchema.extend({
    caseId: entityId("evaluation-case"),
    variantId: entityId("evaluation-variant"),
    repetition: z.number().int().positive(),
  }).strict()).min(1),
}).strict();

const planSchema: z.ZodType<ExperimentPlanV4> = z.discriminatedUnion("kind", [
  repeatedPlanSchema,
  evaluationPlanSchema,
]);

// Kept only as schemas for clear rejection diagnostics when stale artifacts
// are encountered. PR10 intentionally does not migrate pre-v3 artifacts.
const unsupportedPlanVersionSchema = z.object({ schemaVersion: z.number().int() }).passthrough();

const resultCellsSchema = z.array(
  z.discriminatedUnion("status", [
    z
      .object({
        cellId: entityId("experiment-cell"),
        runId: entityId("run"),
        status: z.enum(["completed", "cancelled", "failed"]),
      })
      .strict(),
    z
      .object({
        cellId: entityId("experiment-cell"),
        runId: entityId("run"),
        status: z.literal("not-run"),
      })
      .strict(),
  ]),
);

const resultV4Schema = z
  .object({
    schemaVersion: z.literal(4),
    experimentId: entityId("experiment"),
    status: z.enum(["completed", "cancelled"]),
    endedAt: z.string().datetime(),
    cells: resultCellsSchema,
  })
  .strict();

const resultV5Schema = z
  .object({
    schemaVersion: z.literal(5),
    experimentId: entityId("experiment"),
    status: z.enum(["completed", "cancelled", "stopped"]),
    stop: z
      .object({
        reason: z.literal("tool_unavailable"),
        cellId: entityId("experiment-cell"),
        toolId: entityId("tool"),
      })
      .strict()
      .optional(),
    endedAt: z.string().datetime(),
    cells: resultCellsSchema,
  })
  .strict();

const resultV6Schema = z
  .object({
    schemaVersion: z.literal(EXPERIMENT_RESULT_SCHEMA_VERSION),
    experimentId: entityId("experiment"),
    status: z.enum(["completed", "cancelled", "stopped"]),
    stop: z
      .object({
        reason: z.literal("tool_unavailable"),
        cellId: entityId("experiment-cell"),
        toolId: entityId("tool"),
        startedCells: z.number().int().positive(),
      })
      .strict()
      .optional(),
    endedAt: z.string().datetime(),
    concurrency: z
      .object({
        maxInFlight: z.number().int().positive(),
        connections: z.array(
          z
            .object({
              profileId: entityId("profile"),
              endpoint: z.string(),
              limit: z.number().int().positive(),
            })
            .strict(),
        ),
      })
      .strict(),
    retryPolicy: z
      .object({
        rateLimited: z.object({ maxRetries: z.number().int().nonnegative() }).strict(),
      })
      .strict(),
    cells: z.array(
      z.discriminatedUnion("status", [
        z
          .object({
            cellId: entityId("experiment-cell"),
            runId: entityId("run"),
            status: z.enum(["completed", "cancelled", "failed"]),
            startOrder: z.number().int().positive(),
          })
          .strict(),
        z
          .object({
            cellId: entityId("experiment-cell"),
            runId: entityId("run"),
            status: z.literal("not-run"),
          })
          .strict(),
      ]),
    ),
  })
  .strict();

function parseWith<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ExperimentValidationError(
      issue
        ? `Invalid ${label} at ${issue.path.join(".") || "root"}: ${issue.message}`
        : `${label} is invalid.`,
    );
  }
  return parsed.data;
}

function planInputs(plan: ExperimentPlanV4): Array<Omit<ResolvedRunInput, "runId">> {
  return plan.kind === "repeated-request"
    ? [plan.commonInput]
    : plan.suite.variants.map((variant) => ({
        ...plan.suite.cases[0]!.input,
        ...variant,
        tools: plan.suite.tools,
      }));
}

/**
 * One cell at a time: an overall limit of 1, and every distinct connection a
 * plan targets, in the order the plan first uses it, at a limit of 1. What
 * every result before Version 6 ran at, and the default.
 */
export function sequentialExperimentConcurrency(
  plan: ExperimentPlanV4,
): ExperimentConcurrency {
  const connections = new Map<string, ExperimentConnectionConcurrency>();
  for (const { target } of planInputs(plan)) {
    const key = experimentConnectionKey(target);
    if (!connections.has(key)) {
      connections.set(key, { profileId: target.profileId, endpoint: target.endpoint, limit: 1 });
    }
  }
  return { maxInFlight: 1, connections: [...connections.values()] };
}

/**
 * The concurrency a person asks for. Every limit defaults to 1, so an empty
 * setting runs one cell at a time. Not persisted: a result records the
 * effective limits `resolveExperimentConcurrency` derives from it.
 */
export interface ExperimentConcurrencySetting {
  /** Most cells in flight across the whole experiment. */
  maxInFlight?: number;
  /** The limit for any connection `connections` does not name. */
  connectionLimit?: number;
  /** Per-connection limits. Entries for connections a plan does not use are ignored. */
  connections?: readonly ExperimentConnectionConcurrency[];
}

/**
 * The limits a plan actually runs under. No connection's limit exceeds the
 * overall limit, because it could never be reached.
 */
export function resolveExperimentConcurrency(
  plan: ExperimentPlanV4,
  setting: ExperimentConcurrencySetting = {},
): ExperimentConcurrency {
  const maxInFlight = concurrencyLimit(setting.maxInFlight, "The overall limit");
  const connectionLimit = concurrencyLimit(setting.connectionLimit, "The connection limit");
  const named = new Map(
    (setting.connections ?? []).map((connection) => [
      experimentConnectionKey(connection),
      concurrencyLimit(connection.limit, `The limit for ${connection.profileId}`),
    ]),
  );
  return {
    maxInFlight,
    connections: sequentialExperimentConcurrency(plan).connections.map((connection) => ({
      ...connection,
      limit: Math.min(maxInFlight, named.get(experimentConnectionKey(connection)) ?? connectionLimit),
    })),
  };
}

function concurrencyLimit(value: number | undefined, label: string): number {
  if (value === undefined) return 1;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ExperimentValidationError(`${label} must be a positive whole number.`);
  }
  return value;
}

/** The key the scheduler and the result both use for one connection. */
export function experimentConnectionKey(
  target: Pick<ResolvedRunInput["target"], "profileId" | "endpoint">,
): string {
  return `${target.profileId}\u0000${target.endpoint}`;
}

function assertNoSensitiveProviderOptions(plan: ExperimentPlanV4): void {
  function inspect(value: JsonValue | undefined, path: string): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const [key, nested] of Object.entries(value)) {
      if (isSensitiveTemplateVariableName(key)) {
        throw new ExperimentValidationError(
          `${path}.${key} cannot contain credential-like provider options.`,
        );
      }
      inspect(nested, `${path}.${key}`);
    }
  }

  planInputs(plan).forEach((input, inputIndex) => {
    const prefix = plan.kind === "repeated-request" ? "commonInput" : `suite.variants.${inputIndex}`;
    inspect(input.options.providerOptions, `${prefix}.options.providerOptions`);
    input.tools.forEach((tool, toolIndex) =>
      inspect(tool.providerOptions, `${prefix}.tools.${toolIndex}.providerOptions`),
    );
  });
}

function assertPlanReferences(plan: ExperimentPlanV4): void {
  const cellIds = new Set<string>();
  const runIds = new Set<string>();
  plan.cells.forEach((cell, index) => {
    if (cell.ordinal !== index + 1) {
      throw new ExperimentValidationError("Experiment cell ordinals must be contiguous and one-based.");
    }
    if (cellIds.has(cell.cellId)) {
      throw new ExperimentValidationError(`Experiment repeats cell ${cell.cellId}.`);
    }
    if (runIds.has(cell.runId)) {
      throw new ExperimentValidationError(`Experiment repeats run ${cell.runId}.`);
    }
    cellIds.add(cell.cellId);
    runIds.add(cell.runId);
  });

  if (plan.kind !== "evaluation") return;
  const bindingIds = new Set(plan.suite.inputBindings.map(({ id }) => id));
  if (bindingIds.size !== plan.suite.inputBindings.length) {
    throw new ExperimentValidationError("Evaluation input binding identities must be unique.");
  }
  const cases = new Map<EvaluationCaseId, EvaluationCaseSnapshotV4>();
  plan.suite.cases.forEach((evaluationCase) => {
    if (cases.has(evaluationCase.caseId)) {
      throw new ExperimentValidationError(`Evaluation repeats case ${evaluationCase.caseId}.`);
    }
    const valueIds = Object.keys(evaluationCase.values);
    if (valueIds.length !== bindingIds.size || valueIds.some((id) => !bindingIds.has(id as EvaluationInputBindingId))) {
      throw new ExperimentValidationError(`Evaluation case ${evaluationCase.caseId} must snapshot exactly one value for every input binding.`);
    }
    if (evaluationCase.input.conversationRevisionId !== plan.suite.conversationRevisionId) {
      throw new ExperimentValidationError(`Evaluation case ${evaluationCase.caseId} resolves a different conversation revision.`);
    }
    cases.set(evaluationCase.caseId, evaluationCase);
  });
  const variants = new Map<EvaluationVariantId, EvaluationVariantSnapshotV4>();
  plan.suite.variants.forEach((variant) => {
    if (variants.has(variant.variantId)) {
      throw new ExperimentValidationError(`Evaluation repeats configuration ${variant.variantId}.`);
    }
    variants.set(variant.variantId, variant);
  });
  if (plan.cells.length !== plan.suite.cases.length * plan.suite.variants.length * plan.repetitions) {
    throw new ExperimentValidationError("Evaluation cells must include every planned case, configuration, and repetition exactly once.");
  }
  plan.suite.cases.forEach((evaluationCase, caseIndex) => {
    plan.suite.variants.forEach((variant, variantIndex) => {
      for (let repetition = 1; repetition <= plan.repetitions; repetition += 1) {
        const cell = plan.cells[(caseIndex * plan.suite.variants.length + variantIndex) * plan.repetitions + repetition - 1];
        if (cell?.caseId !== evaluationCase.caseId || cell.variantId !== variant.variantId || cell.repetition !== repetition) {
          throw new ExperimentValidationError("Evaluation cells must retain case, configuration, and contiguous one-based repetition order.");
        }
      }
    });
  });
}

function assertResultReferences(
  result: ExperimentResultV6,
  plan: ExperimentPlanV4,
): void {
  if (result.experimentId !== plan.experimentId) {
    throw new ExperimentValidationError("Experiment result belongs to a different experiment.");
  }
  if (result.cells.length !== plan.cells.length) {
    throw new ExperimentValidationError("Experiment result must account for every planned cell.");
  }
  const planned = new Map(plan.cells.map((cell) => [cell.cellId, cell]));
  const seen = new Set<string>();
  result.cells.forEach((cell, index) => {
    const expected = planned.get(cell.cellId);
    if (!expected || expected.runId !== cell.runId) {
      throw new ExperimentValidationError("Experiment result references an unplanned cell or run.");
    }
    if (seen.has(cell.cellId)) {
      throw new ExperimentValidationError(`Experiment result repeats cell ${cell.cellId}.`);
    }
    if (cell.cellId !== plan.cells[index]?.cellId) {
      throw new ExperimentValidationError("Experiment result cells must retain plan order.");
    }
    seen.add(cell.cellId);
  });
  assertConcurrency(result.concurrency, plan);
  // Every started cell has a start order, and together they count 1..n.
  const startOrders = result.cells
    .flatMap((cell) => cell.status === "not-run" ? [] : [cell.startOrder])
    .sort((left, right) => left - right);
  if (startOrders.some((order, index) => order !== index + 1)) {
    throw new ExperimentValidationError(
      "Experiment result start orders must number the started cells once each, from one.",
    );
  }
  assertConnectionStartOrder(result, plan);
  if (result.status === "completed" && result.cells.some((cell) => cell.status === "not-run")) {
    throw new ExperimentValidationError("A completed experiment cannot contain unstarted cells.");
  }
  if (result.status !== "stopped") {
    if (result.stop) {
      throw new ExperimentValidationError("Only a stopped experiment records a stop.");
    }
    return;
  }
  if (!result.stop) {
    throw new ExperimentValidationError("A stopped experiment must record why it stopped.");
  }
  const { cellId, startedCells } = result.stop;
  const stopping = result.cells.find((cell) => cell.cellId === cellId);
  if (!stopping || stopping.status !== "failed") {
    throw new ExperimentValidationError("A stop must name the failed repetition that caused it.");
  }
  // Cells already running when the stop was recorded may finish, so a later
  // cell in plan order can be terminal. None may have started after it.
  if (startOrders.length > startedCells) {
    throw new ExperimentValidationError("No repetition may start after the stop.");
  }
  if (startOrders.length < startedCells) {
    throw new ExperimentValidationError("A stop must count only cells that started.");
  }
}

/**
 * Each connection starts its cells in plan order as slots free up, so on one
 * connection the started cells are a prefix of its cells, in rising start
 * order. Different connections are independent of each other.
 */
function assertConnectionStartOrder(result: ExperimentResultV6, plan: ExperimentPlanV4): void {
  const connectionOf = cellConnectionKeys(plan);
  const lastStart = new Map<string, number>();
  const unstarted = new Set<string>();
  for (const cell of result.cells) {
    const connection = connectionOf(cell.cellId);
    if (cell.status === "not-run") {
      unstarted.add(connection);
      continue;
    }
    if (unstarted.has(connection) || cell.startOrder < (lastStart.get(connection) ?? 0)) {
      throw new ExperimentValidationError(
        "Experiment result cells must start in plan order on each connection.",
      );
    }
    lastStart.set(connection, cell.startOrder);
  }
}

function cellConnectionKeys(plan: ExperimentPlanV4): (cellId: ExperimentCellId) => string {
  if (plan.kind === "repeated-request") {
    const key = experimentConnectionKey(plan.commonInput.target);
    return () => key;
  }
  const byVariant = new Map(
    plan.suite.variants.map((variant) => [variant.variantId, experimentConnectionKey(variant.target)]),
  );
  const byCell = new Map(plan.cells.map((cell) => [cell.cellId, byVariant.get(cell.variantId)!]));
  return (cellId) => byCell.get(cellId)!;
}

function assertConcurrency(
  concurrency: ExperimentConcurrency,
  plan: ExperimentPlanV4,
): void {
  const expected = sequentialExperimentConcurrency(plan).connections.map(experimentConnectionKey);
  const actual = concurrency.connections.map(experimentConnectionKey);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new ExperimentValidationError(
      "Experiment result concurrency must name each connection the plan uses once, in plan order.",
    );
  }
}

/**
 * Results before Version 6 ran one cell at a time in plan order, so their
 * started cells began in plan order, every connection had a limit of 1, and
 * nothing was retried.
 * Version 5 already refused a cell that ran after the stop; counting the
 * stopping cell as the last to start keeps that refusal after the upgrade.
 */
function upgradeSequentialResult(
  result: ExperimentResultV5,
  plan: ExperimentPlanV4,
): ExperimentResultV6 {
  let started = 0;
  const cells = result.cells.map((cell): ExperimentCellResultV6 =>
    cell.status === "not-run" ? cell : { ...cell, startOrder: ++started }
  );
  const stopOrder = result.stop
    ? cells.find((cell) => cell.cellId === result.stop!.cellId)
    : undefined;
  return {
    schemaVersion: EXPERIMENT_RESULT_SCHEMA_VERSION,
    experimentId: result.experimentId,
    status: result.status,
    ...(result.stop
      ? {
          stop: {
            ...result.stop,
            // A stop naming no started cell is refused by the validator; any
            // positive count keeps that the error it reports.
            startedCells: stopOrder && stopOrder.status !== "not-run" ? stopOrder.startOrder : 1,
          },
        }
      : {}),
    endedAt: result.endedAt,
    concurrency: sequentialExperimentConcurrency(plan),
    retryPolicy: noExperimentRetries(),
    cells,
  };
}

export function experimentPlanFileName(experimentId: ExperimentId): string {
  const parsed = parseWith(entityId("experiment"), experimentId, "experiment ID");
  return `${parsed}${EXPERIMENT_PLAN_FILE_SUFFIX}`;
}

export function experimentResultFileName(experimentId: ExperimentId): string {
  const parsed = parseWith(entityId("experiment"), experimentId, "experiment ID");
  return `${parsed}${EXPERIMENT_RESULT_FILE_SUFFIX}`;
}

export function isExperimentEntryName(fileName: string): boolean {
  return /^(?:experiment_[A-Za-z0-9][A-Za-z0-9._-]*\.(?:plan|result)\.json|evaluation-assessment_[A-Za-z0-9][A-Za-z0-9._-]*\.assessment\.json)$/.test(fileName)
    && !fileName.includes("..");
}

export function assertExperimentEntryName(fileName: string): string {
  if (!isExperimentEntryName(fileName)) {
    throw new ExperimentValidationError(`${fileName} is not an experiment artifact file name.`);
  }
  return fileName;
}

/**
 * A union rather than an optional field, so every reader of the experiments
 * directory has to say what an assessment is instead of silently treating it
 * as a plan or a result.
 */
export type ExperimentArtifactIdentity =
  | { kind: "plan"; experimentId: ExperimentId }
  | { kind: "result"; experimentId: ExperimentId }
  | { kind: "assessment"; assessmentId: EvaluationAssessmentId };

export function experimentArtifactIdentity(fileName: string): ExperimentArtifactIdentity {
  const safeName = assertExperimentEntryName(fileName);
  if (safeName.endsWith(EVALUATION_ASSESSMENT_FILE_SUFFIX)) {
    return {
      kind: "assessment",
      assessmentId: safeName.slice(0, -EVALUATION_ASSESSMENT_FILE_SUFFIX.length) as EvaluationAssessmentId,
    };
  }
  if (safeName.endsWith(EXPERIMENT_PLAN_FILE_SUFFIX)) {
    return {
      kind: "plan",
      experimentId: safeName.slice(0, -EXPERIMENT_PLAN_FILE_SUFFIX.length) as ExperimentId,
    };
  }
  return {
    kind: "result",
    experimentId: safeName.slice(0, -EXPERIMENT_RESULT_FILE_SUFFIX.length) as ExperimentId,
  };
}

export function parseExperimentPlanFile(value: unknown): ExperimentPlanV4 {
  const version = unsupportedPlanVersionSchema.safeParse(value);
  if (version.success && version.data.schemaVersion !== EXPERIMENT_SCHEMA_VERSION) {
    throw new ExperimentValidationError(
      `Experiment plan schema Version ${version.data.schemaVersion} is unsupported; expected Version ${EXPERIMENT_SCHEMA_VERSION}.`,
    );
  }
  const plan = parseWith(planSchema, value, "experiment plan");
  assertPlanReferences(plan);
  assertNoSensitiveProviderOptions(plan);
  return plan;
}

export function parseExperimentPlanJson(contents: string): ExperimentPlanV4 {
  try {
    return parseExperimentPlanFile(JSON.parse(contents));
  } catch (error) {
    if (error instanceof ExperimentValidationError) throw error;
    throw new ExperimentValidationError("Experiment plan is not valid JSON.");
  }
}

export function parseExperimentResultFile(
  value: unknown,
  plan: ExperimentPlanV4,
): ExperimentResultV6 {
  const parsedPlan = parseExperimentPlanFile(plan);
  const version = unsupportedPlanVersionSchema.safeParse(value);
  if (
    version.success &&
    version.data.schemaVersion !== 4 &&
    version.data.schemaVersion !== 5 &&
    version.data.schemaVersion !== EXPERIMENT_RESULT_SCHEMA_VERSION
  ) {
    throw new ExperimentValidationError(
      `Experiment result schema Version ${version.data.schemaVersion} is unsupported; expected Version 4, 5, or ${EXPERIMENT_RESULT_SCHEMA_VERSION}.`,
    );
  }
  const schemaVersion = version.success ? version.data.schemaVersion : EXPERIMENT_RESULT_SCHEMA_VERSION;
  // Version 4 is a strict subset of Version 5: it cannot say "stopped".
  const result: ExperimentResultV6 = schemaVersion === 4
    ? upgradeSequentialResult(
        {
          ...(parseWith(resultV4Schema, value, "experiment result") as ExperimentResultV4),
          schemaVersion: 5,
        },
        parsedPlan,
      )
    : schemaVersion === 5
      ? upgradeSequentialResult(
          parseWith(resultV5Schema, value, "experiment result") as ExperimentResultV5,
          parsedPlan,
        )
      : (parseWith(resultV6Schema, value, "experiment result") as ExperimentResultV6);
  assertResultReferences(result, parsedPlan);
  return result;
}

export function parseExperimentResultJson(
  contents: string,
  plan: ExperimentPlanV4,
): ExperimentResultV6 {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new ExperimentValidationError("Experiment result is not valid JSON.");
  }
  return parseExperimentResultFile(value, plan);
}

export function serializeExperimentPlan(plan: ExperimentPlanV4): string {
  return serializeParsedExperimentPlan(parseExperimentPlanFile(plan));
}

/**
 * Serializes a plan that was already accepted by `parseExperimentPlanFile`.
 * This is useful to execution owners that must validate an ad hoc plan before
 * starting, but must not re-parse the full frozen input for every cell.
 */
export function serializeParsedExperimentPlan(plan: ExperimentPlanV4): string {
  return `${JSON.stringify(stableJsonValue(plan), null, 2)}\n`;
}

export function serializeExperimentResult(
  result: ExperimentResultInput,
  plan: ExperimentPlanV4,
): string {
  return `${JSON.stringify(stableJsonValue(parseExperimentResultFile(result, plan)), null, 2)}\n`;
}

/** The cost bound this plan runs under, whether or not it recorded one. */
export function experimentTurnCeiling(plan: ExperimentPlanV4): number {
  return plan.turnCeiling ?? DEFAULT_EXPERIMENT_TURN_CEILING;
}

/**
 * Every tool this plan exposes to the provider, deduplicated by tool ID.
 *
 * One list across both plan kinds, because everything that reads it — the start
 * gate, the confirmation listing, the controller's binding check — asks the
 * same question: what must be servable before this experiment is worth
 * starting? An evaluation plan may expose a different set per case, so the
 * union is what has to be satisfiable, not any one case's selection.
 */
export function experimentExposedTools(plan: ExperimentPlanV4): ToolDefinition[] {
  const inputs = plan.kind === "repeated-request"
    ? [plan.commonInput]
    : [{ tools: plan.suite.tools }];
  const byId = new Map<ToolDefinition["id"], ToolDefinition>();
  for (const input of inputs) {
    for (const tool of input.tools) if (!byId.has(tool.id)) byId.set(tool.id, tool);
  }
  return [...byId.values()];
}

/** Materializes exactly one preallocated repetition without changing its frozen input. */
export function materializeExperimentCellInput(
  plan: ExperimentPlanV4,
  cellId: ExperimentCellId,
): ResolvedRunInput {
  const parsed = parseExperimentPlanFile(plan);
  const cell = parsed.cells.find((candidate) => candidate.cellId === cellId);
  if (!cell) throw new ExperimentValidationError(`Unknown experiment cell ${cellId}.`);
  return materializeParsedExperimentCellInput(parsed, cell);
}

/**
 * Materializes a cell from a plan already accepted by `parseExperimentPlanFile`.
 * Callers that receive untrusted plans must use `materializeExperimentCellInput`
 * or parse first.
 */
export function materializeParsedExperimentCellInput(
  plan: ExperimentPlanV4,
  cell: ExperimentCell,
): ResolvedRunInput {
  const plannedCell = plan.cells.find((candidate) => candidate.cellId === cell.cellId);
  if (!plannedCell || plannedCell.runId !== cell.runId) {
    throw new ExperimentValidationError(`Unknown experiment cell ${cell.cellId}.`);
  }
  if (plan.kind === "repeated-request") {
    return { ...plan.commonInput, runId: plannedCell.runId };
  }
  const evaluationCell = plannedCell as EvaluationExperimentCellV4;
  const evaluationCase = plan.suite.cases.find(({ caseId }) => caseId === evaluationCell.caseId);
  if (!evaluationCase) throw new ExperimentValidationError(`Unknown evaluation case ${evaluationCell.caseId}.`);
  const variant = plan.suite.variants.find(({ variantId }) => variantId === evaluationCell.variantId);
  if (!variant) throw new ExperimentValidationError(`Unknown evaluation configuration ${evaluationCell.variantId}.`);
  return { ...evaluationCase.input, ...variant, tools: plan.suite.tools, runId: plannedCell.runId };
}

/** A plan with no result survived an interrupted application session. */
export function experimentLifecycle(
  _plan: ExperimentPlanV4,
  result?: ExperimentResultInput,
): ExperimentLifecycle {
  return result ? result.status : "interrupted";
}

function range(values: number[]): ExperimentMetricRange {
  const sorted = [...values].sort((left, right) => left - right);
  const count = sorted.length;
  if (count === 0) return { count };
  const middle = Math.floor(count / 2);
  const median = count % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  return { count, min: sorted[0], median, max: sorted.at(-1) };
}

function usage(values: Array<number | undefined>): ExperimentUsageAggregate {
  const reported = values.filter((value): value is number => value !== undefined);
  return {
    reportedRuns: reported.length,
    ...(reported.length ? { total: reported.reduce((sum, value) => sum + value, 0) } : {}),
  };
}

export { finalAssistantOutput } from "./run-output.ts";

/**
 * Derives summary evidence from immutable artifacts and ordinary run states.
 * Missing states are explicitly represented rather than treated as zero-valued
 * metrics or successful repetitions.
 */
export function repeatedExperimentAggregate(
  plan: RepeatedExperimentPlanV4,
  result: ExperimentResultInput | undefined,
  states: ReadonlyMap<RunId, RunState> = new Map(),
): RepeatedExperimentAggregate {
  const parsedPlan = parseExperimentPlanFile(plan);
  if (parsedPlan.kind !== "repeated-request") {
    throw new ExperimentValidationError("Repeated-experiment aggregates require a repeated-request plan.");
  }
  const parsedResult = result ? parseExperimentResultFile(result, parsedPlan) : undefined;
  const results = new Map(parsedResult?.cells.map((cell) => [cell.cellId, cell]));
  let completed = 0;
  let failed = 0;
  let cancelled = 0;
  let notRun = 0;
  let missingTrace = 0;
  let runsWithRetries = 0;
  const durations: number[] = [];
  const ttfo: number[] = [];
  const totalTokens: Array<number | undefined> = [];
  const outputTokens: Array<number | undefined> = [];
  const throughput: number[] = [];
  const turns: number[] = [];
  const toolCalls: number[] = [];
  const outputs: string[] = [];

  for (const cell of parsedPlan.cells) {
    const disposition = results.get(cell.cellId);
    const state = states.get(cell.runId);
    if (disposition?.status === "not-run" || (!disposition && !state)) {
      notRun += 1;
      continue;
    }
    if (!state) {
      missingTrace += 1;
      continue;
    }
    switch (state.status.kind) {
      case "completed": completed += 1; break;
      case "failed": failed += 1; break;
      case "cancelled": cancelled += 1; break;
      default: notRun += 1; continue;
    }
    const metrics = runMetrics(state);
    if (metrics.retryCount > 0) runsWithRetries += 1;
    if (metrics.totalDurationMs !== undefined) durations.push(metrics.totalDurationMs);
    if (metrics.ttfoMs !== undefined) ttfo.push(metrics.ttfoMs);
    totalTokens.push(metrics.usage.totalTokens);
    outputTokens.push(metrics.usage.outputTokens);
    if (metrics.outputTokensPerSecond !== undefined) throughput.push(metrics.outputTokensPerSecond);
    turns.push(metrics.turnCount);
    toolCalls.push(metrics.toolCallCount);
    if (state.status.kind === "completed") {
      const output = finalAssistantOutput(state);
      if (output !== undefined) outputs.push(output);
    }
  }

  return {
    lifecycle: experimentLifecycle(parsedPlan, parsedResult),
    requested: parsedPlan.cells.length,
    completed,
    failed,
    cancelled,
    notRun,
    missingTrace,
    runsWithRetries,
    totalDurationMs: range(durations),
    ttfoMs: range(ttfo),
    reportedTotalTokens: range(totalTokens.filter((value): value is number => value !== undefined)),
    reportedOutputTokens: range(outputTokens.filter((value): value is number => value !== undefined)),
    totalTokens: usage(totalTokens),
    outputTokens: usage(outputTokens),
    outputTokensPerSecond: range(throughput),
    turnsPerRun: range(turns),
    toolCallsPerRun: range(toolCalls),
    distinctFinalAssistantOutputs: new Set(outputs).size,
    outputCharacterCount: range(outputs.map(outputCharacterCount)),
  };
}

/**
 * Derives the immutable "As run" assessment. Strict scoring is intentionally
 * encoded here rather than persisted: every repetition, case, and the suite
 * pass only when all required lower-level evidence passes.
 */
export function evaluationExperimentAggregate(
  plan: EvaluationExperimentPlanV4,
  result: ExperimentResultInput | undefined,
  states: ReadonlyMap<RunId, RunState> = new Map(),
): EvaluationBakeoffAssessment {
  const parsed = parseExperimentPlanFile(plan);
  if (parsed.kind !== "evaluation") {
    throw new ExperimentValidationError("Evaluation aggregates require an evaluation plan.");
  }
  return evaluationParsedExperimentAggregate(parsed, result, states);
}

/**
 * Derives an evaluation aggregate from a plan already accepted by
 * `parseExperimentPlanFile`. Render paths can retain this trusted immutable
 * snapshot while streamed state changes without re-validating every case input.
 *
 * `criteria` replaces the plan's own checks for the cases it names, which is
 * the whole of what reassessing a saved output means: outcomes are never
 * persisted, so a reinterpretation is this same pure function with one argument
 * substituted. Omitting it derives the immutable "As run" reading, so a caller
 * that does not opt in cannot be shown a reinterpretation by accident.
 */
export function evaluationParsedExperimentAggregate(
  plan: EvaluationExperimentPlanV4,
  result: ExperimentResultInput | undefined,
  states: ReadonlyMap<RunId, RunState> = new Map(),
  criteria?: EvaluationCriteriaOverride,
): EvaluationBakeoffAssessment {
  const parsed = plan;
  const parsedResult = result ? parseExperimentResultFile(result, parsed) : undefined;
  const dispositions = new Map(parsedResult?.cells.map((cell) => [cell.cellId, cell]));
  // Resolved once, ahead of scoring, so the check denominator and the outcomes
  // counted into it can never come from two different check sets.
  const effectiveChecks = new Map(parsed.suite.cases.map((evaluationCase) => {
    const replacement = criteria?.get(evaluationCase.caseId);
    if (replacement && replacement.length === 0) {
      throw new ExperimentValidationError(
        `Replacement criteria for case ${evaluationCase.caseId} contain no checks; strict scoring over zero checks has no meaning.`,
      );
    }
    return [evaluationCase.caseId, replacement ?? evaluationCase.checks] as const;
  }));
  const lifecycle = experimentLifecycle(parsed, parsedResult);
  const variants = parsed.suite.variants.map((variant): EvaluationVariantAssessment => {
    const assessments = new Map<EvaluationCaseId, EvaluationRepetitionAssessment[]>();
    const repetitionCounts: Record<EvaluationRepetitionClassification, number> = {
      passed: 0, "check-failed": 0, "not-evaluated": 0, "run-failed": 0,
      cancelled: 0, "not-run": 0, "trace-unavailable": 0,
    };
    const checkCounts = { total: 0, passed: 0, failed: 0, notEvaluated: 0 };
    const durations: number[] = [];
    const totalTokenValues: Array<number | undefined> = [];
    const outputTokenValues: Array<number | undefined> = [];

    for (const cell of parsed.cells.filter((candidate) => candidate.variantId === variant.variantId)) {
      const caseChecks = effectiveChecks.get(cell.caseId)!;
      const disposition = dispositions.get(cell.cellId);
      const state = states.get(cell.runId);
      checkCounts.total += caseChecks.length;
      let classification: EvaluationRepetitionClassification;
      let checks: CheckResult[] = [];
      if (disposition?.status === "not-run") {
        classification = "not-run";
        checkCounts.notEvaluated += caseChecks.length;
      } else if (!state) {
        classification = parsedResult ? "trace-unavailable" : "not-evaluated";
        checkCounts.notEvaluated += caseChecks.length;
      } else if (state.status.kind === "failed") {
        classification = "run-failed";
        checks = evaluateChecks(state, caseChecks);
      } else if (state.status.kind === "cancelled") {
        classification = "cancelled";
        checks = evaluateChecks(state, caseChecks);
      } else if (state.status.kind !== "completed") {
        classification = "not-evaluated";
        checkCounts.notEvaluated += caseChecks.length;
      } else {
        checks = evaluateChecks(state, caseChecks);
        const summary = checkOutcomeSummary(checks);
        classification = summary.notEvaluated > 0 ? "not-evaluated" : summary.failed > 0 ? "check-failed" : "passed";
      }
      if (checks.length > 0) {
        const summary = checkOutcomeSummary(checks);
        checkCounts.passed += summary.passed;
        checkCounts.failed += summary.failed;
        checkCounts.notEvaluated += summary.notEvaluated;
      }
      if (state && ["completed", "failed", "cancelled"].includes(state.status.kind)) {
        const metrics = runMetrics(state);
        totalTokenValues.push(metrics.usage.totalTokens);
        outputTokenValues.push(metrics.usage.outputTokens);
        if (state.status.kind === "completed" && metrics.totalDurationMs !== undefined) durations.push(metrics.totalDurationMs);
      }
      repetitionCounts[classification] += 1;
      assessments.set(cell.caseId, [...(assessments.get(cell.caseId) ?? []), {
        cellId: cell.cellId, runId: cell.runId, repetition: cell.repetition, classification, checks,
      }]);
    }
    const caseAssessments = parsed.suite.cases.map((evaluationCase): EvaluationCaseAssessment => {
      const repetitions = assessments.get(evaluationCase.caseId) ?? [];
      return {
        caseId: evaluationCase.caseId,
        name: evaluationCase.name,
        passed: repetitions.length > 0 && repetitions.every(({ classification }) => classification === "passed"),
        repetitions,
      };
    });
    const passed = caseAssessments.filter((assessment) => assessment.passed).length;
    const failed = caseAssessments.filter(({ passed: casePassed, repetitions }) =>
      !casePassed && repetitions.some(({ classification }) => ["check-failed", "run-failed", "cancelled"].includes(classification)),
    ).length;
    return {
      variant,
      lifecycle,
      passed: caseAssessments.length > 0 && passed === caseAssessments.length,
      cases: caseAssessments,
      caseCounts: { total: caseAssessments.length, passed, failed, incomplete: caseAssessments.length - passed - failed },
      repetitionCounts,
      checkCounts,
      totalDurationMs: range(durations),
      totalTokens: usage(totalTokenValues),
      outputTokens: usage(outputTokenValues),
    };
  });
  return { lifecycle, variants };
}

export function evaluationVariantAssessment(
  aggregate: EvaluationBakeoffAssessment,
  variantId: EvaluationVariantId,
): EvaluationVariantAssessment {
  const assessment = aggregate.variants.find((item) => item.variant.variantId === variantId);
  if (!assessment) throw new ExperimentValidationError(`Unknown evaluation configuration ${variantId}.`);
  return assessment;
}
