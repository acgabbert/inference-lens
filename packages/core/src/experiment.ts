import { z } from "zod";
import { ownKeyRecord } from "./own-key-record.ts";

import {
  CHECK_SCHEMA_VERSION,
  checkRunKindIssue,
  checkVocabularyIssue,
  checkDefinitionSchema,
  checkOutcomeSummary,
  decisionCheckSubject,
  evaluateSubjectChecksSteps,
  runCheckSubject,
} from "./checks.ts";
import type { CheckDefinition, CheckResult, CheckSchemaVersion, CheckSubject } from "./checks.ts";
import { DECISION_WIRE_PROTOCOLS, isDecisionInput } from "./decision.ts";
import type { DecisionInput, DecisionRun, ResolvedDecisionTarget, ResolvedDecisionRunInput } from "./decision.ts";
import { environmentProvenanceIssue } from "./environment.ts";
import { isSensitiveTemplateVariableName } from "./project.ts";
import { runMetrics } from "./run-metrics.ts";
import { finalAssistantOutput, outputCharacterCount } from "./run-output.ts";
import { sourceFilePathSchema, sourceRootNameSchema } from "./source-root-rules.ts";
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
  DecisionRequestId,
  DecisionRequestRevisionId,
  EntityId,
  EntityIdKind,
  EnvironmentId,
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
  PromptTemplateId,
  PromptTemplateRevisionId,
  ResolvedRunInput,
  ResolvedTemplateMessage,
  ResolvedTemplateUse,
  RunId,
  RunState,
  TerminalRunStatus,
  ToolDefinition,
  PromptTemplateUseId,
} from "./run-kernel/types.ts";
import { isTerminalRunStatus, PROVIDER_WIRE_PROTOCOLS } from "./run-kernel/types.ts";

/**
 * Plans moved to Version 5 to add decision evaluations (D47). A Version 4 plan
 * is a Version 5 plan that cannot be a decision evaluation, so it opens as one.
 * Version 6 adds prompt environments: inputs record value sources and the
 * environment they consumed, and an evaluation case holds one input per
 * environment its configurations use. Older plans open as Version 6 with one
 * input, no environment, and no value sources. Version 7 lets an evaluation
 * run linked prompts from their files (E4): the suite records each file's
 * snapshot, and each template use it replaced names the file. A Version 6
 * plan opens as Version 7 with no file sources.
 */
export const EXPERIMENT_SCHEMA_VERSION = 7;
/**
 * Results moved to Version 5 alone, to record a batch that stopped itself, and
 * to Version 6 to record the concurrency and retry policy they ran under and
 * the order their cells started in. A decision cell's disposition means what
 * a chat cell's does, so decision plans did not move results past Version 6.
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

export interface RepeatedExperimentPlan {
  schemaVersion: typeof EXPERIMENT_SCHEMA_VERSION;
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

/** One rendering of a case: against one environment, or against none. */
export type EvaluationCaseInputSnapshot = Pick<ResolvedRunInput,
  "conversationId" | "conversationRevisionId" | "messages" | "templateResolutions" | "resolvedAt" | "environment"
>;

export interface EvaluationCaseSnapshotV6 extends Omit<EvaluationCaseSnapshotV4, "input"> {
  /**
   * One input per environment the plan's configurations use, at most one with
   * no environment. Configurations that share an environment share an input.
   */
  inputs: [EvaluationCaseInputSnapshot, ...EvaluationCaseInputSnapshot[]];
}

export interface EvaluationVariantSnapshotV4 {
  variantId: EvaluationVariantId;
  name: string;
  target: ResolvedRunInput["target"];
  responseMode: ResolvedRunInput["responseMode"];
  options: InferenceOptions;
}

export interface EvaluationVariantSnapshotV6 extends EvaluationVariantSnapshotV4 {
  /** Selects the case input this configuration sends; absent means none. */
  environmentId?: EnvironmentId;
}

export interface EvaluationExperimentCellV4 extends ExperimentCellBase {
  caseId: EvaluationCaseId;
  variantId: EvaluationVariantId;
  repetition: number;
}

/**
 * A linked prompt's file as one evaluation read it, frozen during preparation
 * (E4). Every template use of `templateId` in the plan sent `messages` in
 * place of `baseTemplateRevisionId`'s, with `variableDefaults` in place of
 * its defaults. No host path is recorded.
 */
export interface PromptFileSnapshot {
  templateId: PromptTemplateId;
  /** The revision the suite's conversation pins, which the file replaced. */
  baseTemplateRevisionId: PromptTemplateRevisionId;
  sourceRootName: string;
  /** Relative to the source root, `/`-separated. */
  path: string;
  /** The file receipt digest this text would have had as a pull. */
  sourceDigest: string;
  /** The file's decoded text, with its line endings, and the role it was read as. */
  authored: { role: ResolvedTemplateMessage["role"]; text: string };
  interpretation: "expression-v1" | "plain-text-v1";
  /** Each n8n expression and the native variable it became, reusing earlier pulls' names. */
  bindings: Array<{ expression: string; variableName: string }>;
  messages: [ResolvedTemplateMessage, ...ResolvedTemplateMessage[]];
  variableDefaults: Record<string, string>;
  /** The pinned revision is not the last one pulled from the file. */
  replacedLocalRevisions: boolean;
}

/** A chat evaluation: a conversation revision run per case and configuration. */
export interface EvaluationExperimentPlan {
  schemaVersion: typeof EXPERIMENT_SCHEMA_VERSION;
  experimentId: ExperimentId;
  kind: "evaluation";
  createdAt: string;
  /** New plans record `CHECK_SCHEMA_VERSION`; plans written by an older build keep its version. */
  checkSchemaVersion: CheckSchemaVersion;
  scoringPolicy: "strict";
  repetitions: number;
  /** See `RepeatedExperimentPlan.turnCeiling`; the controller reads both. */
  turnCeiling?: number;
  suite: {
    suiteId: EvaluationSuiteId;
    name: string;
    conversationRevisionId: ConversationRevisionId;
    inputBindings: EvaluationInputBindingSnapshot[];
    tools: ToolDefinition[];
    cases: EvaluationCaseSnapshotV6[];
    variants: EvaluationVariantSnapshotV6[];
    /** Version 7: the linked prompts this run read from their files, if any. */
    promptSources?: PromptFileSnapshot[];
  };
  cells: EvaluationExperimentCellV4[];
}

export interface DecisionInputBindingSnapshot {
  id: EvaluationInputBindingId;
  name: string;
  target: { kind: "decision-variable"; variableName: string };
}

/** One decision case as it was sent (D47). */
export interface DecisionEvaluationCaseSnapshot {
  caseId: EvaluationCaseId;
  name: string;
  values: Record<EvaluationInputBindingId, string>;
  checks: CheckDefinition[];
  referenceAnswer?: string;
  input: {
    decisionRequestId: DecisionRequestId;
    decisionRequestRevisionId: DecisionRequestRevisionId;
    /** The resolved request that is sent; its key order is authored meaning. */
    decision: DecisionInput;
    resolvedAt: string;
  };
}

/** A decision configuration varies only its target (D33). */
export interface DecisionEvaluationVariantSnapshot {
  variantId: EvaluationVariantId;
  name: string;
  target: ResolvedDecisionTarget;
}

/**
 * A decision evaluation (D47): a pinned decision request revision run per
 * case and configuration. No tools, response mode, options, or turn ceiling:
 * a decision run is one exchange.
 */
export interface DecisionEvaluationExperimentPlan {
  schemaVersion: typeof EXPERIMENT_SCHEMA_VERSION;
  experimentId: ExperimentId;
  kind: "decision-evaluation";
  createdAt: string;
  /** Decision checks exist only from vocabulary 5. */
  checkSchemaVersion: typeof CHECK_SCHEMA_VERSION;
  scoringPolicy: "strict";
  repetitions: number;
  suite: {
    suiteId: EvaluationSuiteId;
    name: string;
    decisionRequestRevisionId: DecisionRequestRevisionId;
    inputBindings: DecisionInputBindingSnapshot[];
    cases: DecisionEvaluationCaseSnapshot[];
    variants: DecisionEvaluationVariantSnapshot[];
  };
  cells: EvaluationExperimentCellV4[];
}

/** The plans a chat run executes. */
export type ChatExperimentPlan = RepeatedExperimentPlan | EvaluationExperimentPlan;
/** The plans that score cases with checks, of either run kind. */
export type SuiteExperimentPlan = EvaluationExperimentPlan | DecisionEvaluationExperimentPlan;
export type ExperimentPlan = ChatExperimentPlan | DecisionEvaluationExperimentPlan;
export type ExperimentCell = RepeatedExperimentCell | EvaluationExperimentCellV4;
/** Where one configuration sends its runs, of either kind. */
export type ExperimentTarget = ResolvedRunInput["target"] | ResolvedDecisionTarget;
// Source-level aliases keep feature owners compiling while they adopt the
// current names. They never accept or emit a v3 artifact.
export type RepeatedExperimentPlanV3 = RepeatedExperimentPlan;
export type EvaluationExperimentPlanV3 = EvaluationExperimentPlan;
export type ExperimentPlanV3 = ExperimentPlan;
export type ExperimentResultV3 = ExperimentResultV4;
/** The current in-memory result. Every accepted result is read as this. */
export type ExperimentResult = ExperimentResultV6;
/** A result as it may arrive from storage or a caller: any readable version. */
export type ExperimentResultInput = ExperimentResultV4 | ExperimentResultV5 | ExperimentResultV6;
export type EvaluationCaseSnapshot = EvaluationCaseSnapshotV6;

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

/** How many times one provider turn may be retried after a 429 when retries are on. */
export const RATE_LIMIT_MAX_RETRIES = 2;

/** Retries on: a rate-limited turn may be retried `RATE_LIMIT_MAX_RETRIES` times. */
export function rateLimitRetries(): ExperimentRetryPolicy {
  return { rateLimited: { maxRetries: RATE_LIMIT_MAX_RETRIES } };
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
  /** The run failed because the provider answered 429: missing evidence, not a model failure. */
  | "rate-limited"
  | "cancelled"
  | "not-run"
  | "trace-unavailable";

/**
 * Whether a repetition is evidence that the configuration failed. Anything
 * else short of `passed` is missing evidence, which leaves its case
 * incomplete rather than failed.
 */
export function isFailingRepetition(classification: EvaluationRepetitionClassification): boolean {
  return classification === "check-failed" || classification === "run-failed" || classification === "cancelled";
}

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

/** A configuration snapshot of either evaluation kind. */
export type EvaluationVariantSnapshot = EvaluationVariantSnapshotV6 | DecisionEvaluationVariantSnapshot;

/**
 * One configuration's independently-scored view of an evaluation bakeoff.
 * `Variant` is the plan kind's configuration snapshot; chat's is the default.
 */
export interface EvaluationVariantAssessment<Variant extends EvaluationVariantSnapshot = EvaluationVariantSnapshotV4> {
  variant: Variant;
  lifecycle: ExperimentLifecycle;
  passed: boolean;
  cases: EvaluationCaseAssessment[];
  caseCounts: EvaluationCaseCounts;
  repetitionCounts: Record<EvaluationRepetitionClassification, number>;
  /**
   * Repetitions that retried at least one attempt the provider answered with
   * 429, whatever their classification, so retrying cannot quietly hide a
   * configuration that keeps reaching its rate limit.
   */
  retriedAfterRateLimit: number;
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
export interface EvaluationBakeoffAssessment<Variant extends EvaluationVariantSnapshot = EvaluationVariantSnapshotV4> {
  lifecycle: ExperimentLifecycle;
  variants: EvaluationVariantAssessment<Variant>[];
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
  /** Failed runs other than those `rateLimited` counts. */
  failed: number;
  /** Runs that failed because the provider answered 429. */
  rateLimited: number;
  cancelled: number;
  notRun: number;
  missingTrace: number;
  runsWithRetries: number;
  /** Runs that retried at least one attempt the provider answered with 429. */
  retriedAfterRateLimit: number;
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
    variableDefaults: ownKeyRecord(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()),
    values: ownKeyRecord(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()),
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

const templateVariableNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

/**
 * Version 6. Sources are optional because a Version 5 plan opens as Version 6
 * without them; an input that records an environment must carry them.
 */
const sourcedResolvedTemplateUseSchema: z.ZodType<ResolvedTemplateUse> =
  resolvedTemplateUseBaseSchema
    .extend({
      messages: templateMessagesSchema,
      valueSources: ownKeyRecord(
        templateVariableNameSchema,
        z.enum(["template-default", "environment", "authored-use", "run-override", "case"]),
      ).optional(),
    })
    .strict()
    .superRefine((resolution, context) => {
      if (!resolution.valueSources) return;
      const sourceNames = Object.keys(resolution.valueSources).sort();
      if (JSON.stringify(Object.keys(resolution.values).sort()) !== JSON.stringify(sourceNames)) {
        context.addIssue({
          code: "custom",
          path: ["valueSources"],
          message: "Template provenance must name a source for every value, and only for values.",
        });
      }
    });

/** Version 7: a use may name the linked prompt file its messages came from. */
const fileSourcedResolvedTemplateUseSchema: z.ZodType<ResolvedTemplateUse> =
  resolvedTemplateUseBaseSchema
    .extend({
      messages: templateMessagesSchema,
      valueSources: ownKeyRecord(
        templateVariableNameSchema,
        z.enum(["template-default", "environment", "authored-use", "run-override", "case"]),
      ).optional(),
      fileSource: z.object({
        sourceRootName: sourceRootNameSchema,
        path: sourceFilePathSchema,
        sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
        baseTemplateRevisionId: entityId("template-revision"),
      }).strict().optional(),
    })
    .strict()
    .superRefine((resolution, context) => {
      if (!resolution.valueSources) return;
      const sourceNames = Object.keys(resolution.valueSources).sort();
      if (JSON.stringify(Object.keys(resolution.values).sort()) !== JSON.stringify(sourceNames)) {
        context.addIssue({
          code: "custom",
          path: ["valueSources"],
          message: "Template provenance must name a source for every value, and only for values.",
        });
      }
    });

const promptFileSnapshotSchema = z.object({
  templateId: entityId("template"),
  baseTemplateRevisionId: entityId("template-revision"),
  sourceRootName: sourceRootNameSchema,
  path: sourceFilePathSchema,
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  authored: z.object({ role: z.enum(["system", "user", "assistant"]), text: z.string() }).strict(),
  interpretation: z.enum(["expression-v1", "plain-text-v1"]),
  bindings: z.array(z.object({
    expression: z.string().min(1),
    variableName: templateVariableNameSchema,
  }).strict()),
  messages: templateMessagesSchema,
  variableDefaults: ownKeyRecord(templateVariableNameSchema, z.string()),
  replacedLocalRevisions: z.boolean(),
}).strict();

const runEnvironmentSnapshotSchema = z
  .object({
    environmentId: entityId("environment"),
    name: z.string(),
    consumed: ownKeyRecord(templateVariableNameSchema, z.string()),
  })
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

const endpointSchema = z
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
  );

const commonInputBaseSchema = z
  .object({
    conversationId: entityId("conversation"),
    conversationRevisionId: entityId("revision"),
    target: z
      .object({
        profileId: entityId("profile"),
        protocol: z.enum([...PROVIDER_WIRE_PROTOCOLS, "mock"]),
        endpoint: endpointSchema,
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

const commonInputV6Schema = commonInputBaseSchema
  .extend({
    templateResolutions: z.array(sourcedResolvedTemplateUseSchema),
    environment: runEnvironmentSnapshotSchema.optional(),
  })
  .strict();

const commonInputV7Schema = commonInputV6Schema
  .extend({ templateResolutions: z.array(fileSourcedResolvedTemplateUseSchema) })
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

/** Chat plans written as Version 4 or 5 open as Version 6; `parseExperimentPlanFile` upgrades them. */
const chatPlanVersionSchema = z.union([z.literal(4), z.literal(5)]);

const repeatedPlanSchema = planBaseSchema.extend({
    schemaVersion: chatPlanVersionSchema,
    kind: z.literal("repeated-request"),
    commonInput: commonInputSchema,
    turnCeiling: turnCeilingSchema.optional(),
    cells: z.array(experimentCellBaseSchema.strict()).min(2),
  })
  .strict();

const repeatedPlanV6Schema = repeatedPlanSchema.extend({
  schemaVersion: z.literal(6),
  commonInput: commonInputV6Schema,
}).strict();

// A repeated request never reads a file, so Version 7 changes only its label.
const repeatedPlanV7Schema = repeatedPlanV6Schema.extend({
  schemaVersion: z.literal(EXPERIMENT_SCHEMA_VERSION),
}).strict();

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

const evaluationCaseSnapshotV6Schema = evaluationCaseSnapshotSchema.omit({ input: true }).extend({
  inputs: z.array(commonInputV6Schema.pick({
    conversationId: true,
    conversationRevisionId: true,
    messages: true,
    templateResolutions: true,
    resolvedAt: true,
    environment: true,
  })).min(1),
}).strict();

const evaluationVariantSnapshotV6Schema = evaluationVariantSnapshotSchema.extend({
  environmentId: entityId("environment").optional(),
}).strict();

const evaluationCellSchema = experimentCellBaseSchema.extend({
  caseId: entityId("evaluation-case"),
  variantId: entityId("evaluation-variant"),
  repetition: z.number().int().positive(),
}).strict();

const evaluationPlanSchema = planBaseSchema.extend({
  schemaVersion: chatPlanVersionSchema,
  kind: z.literal("evaluation"),
  checkSchemaVersion: z.union([z.literal(3), z.literal(4), z.literal(CHECK_SCHEMA_VERSION)]),
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
  cells: z.array(evaluationCellSchema).min(1),
}).strict();

const evaluationPlanV6Schema = evaluationPlanSchema.extend({
  schemaVersion: z.literal(6),
  suite: evaluationPlanSchema.shape.suite.extend({
    cases: z.array(evaluationCaseSnapshotV6Schema).min(1),
    variants: z.array(evaluationVariantSnapshotV6Schema).min(1),
  }).strict(),
}).strict();

const evaluationCaseSnapshotV7Schema = evaluationCaseSnapshotV6Schema.extend({
  inputs: z.array(commonInputV7Schema.pick({
    conversationId: true,
    conversationRevisionId: true,
    messages: true,
    templateResolutions: true,
    resolvedAt: true,
    environment: true,
  })).min(1),
}).strict();

const evaluationPlanV7Schema = evaluationPlanV6Schema.extend({
  schemaVersion: z.literal(EXPERIMENT_SCHEMA_VERSION),
  suite: evaluationPlanV6Schema.shape.suite.extend({
    cases: z.array(evaluationCaseSnapshotV7Schema).min(1),
    promptSources: z.array(promptFileSnapshotSchema).min(1).optional(),
  }).strict(),
}).strict();

const decisionTargetSchema = z.object({
  profileId: entityId("profile"),
  protocol: z.enum(DECISION_WIRE_PROTOCOLS),
  endpoint: endpointSchema,
  model: z.string().min(1),
  capabilities: capabilitiesSchema,
}).strict();

// Checked for shape only and kept as written, as decision traces are: the
// request's key order is what was sent, and rebuilding it could reorder it.
const decisionInputSchema = z.custom<DecisionInput>(
  (value) => isDecisionInput(value),
  "Expected a decision request with a state and at least one question.",
);

// A decision plan's shape did not change in Version 6 or 7; an older one is relabelled.
const decisionPlanSchema = planBaseSchema.extend({
  schemaVersion: z.union([z.literal(5), z.literal(6), z.literal(EXPERIMENT_SCHEMA_VERSION)]),
  kind: z.literal("decision-evaluation"),
  checkSchemaVersion: z.literal(CHECK_SCHEMA_VERSION),
  scoringPolicy: z.literal("strict"),
  repetitions: z.number().int().positive(),
  suite: z.object({
    suiteId: entityId("evaluation-suite"),
    name: z.string().trim().min(1),
    decisionRequestRevisionId: entityId("decision-revision"),
    inputBindings: z.array(z.object({
      id: entityId("evaluation-input"),
      name: z.string().trim().min(1),
      target: z.object({
        kind: z.literal("decision-variable"),
        variableName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      }).strict(),
    }).strict()),
    cases: z.array(z.object({
      caseId: entityId("evaluation-case"),
      name: z.string().trim().min(1),
      values: z.record(entityId("evaluation-input"), z.string()),
      checks: z.array(checkDefinitionSchema).min(1),
      referenceAnswer: z.string().optional(),
      input: z.object({
        decisionRequestId: entityId("decision-request"),
        decisionRequestRevisionId: entityId("decision-revision"),
        decision: decisionInputSchema,
        resolvedAt: z.string().datetime(),
      }).strict(),
    }).strict()).min(1),
    variants: z.array(z.object({
      variantId: entityId("evaluation-variant"),
      name: z.string().trim().min(1),
      target: decisionTargetSchema,
    }).strict()).min(1),
  }).strict(),
  cells: z.array(evaluationCellSchema).min(1),
}).strict();

const planSchema = z.discriminatedUnion("kind", [
  repeatedPlanV7Schema,
  evaluationPlanV7Schema,
  decisionPlanSchema,
]) as unknown as z.ZodType<ExperimentPlan>;

/** Version 6 plans, relabelled Version 7 after parsing: they read no files. */
const planV6Schema = z.discriminatedUnion("kind", [
  repeatedPlanV6Schema,
  evaluationPlanV6Schema,
  decisionPlanSchema,
]) as unknown as z.ZodType<Omit<ExperimentPlan, "schemaVersion">>;

/** Version 4 and 5 chat plans, upgraded to Version 6 after parsing. */
const legacyPlanSchema = z.discriminatedUnion("kind", [
  repeatedPlanSchema,
  evaluationPlanSchema,
  decisionPlanSchema,
]) as unknown as z.ZodType<
  | Exclude<ExperimentPlan, EvaluationExperimentPlan>
  | (Omit<EvaluationExperimentPlan, "suite"> & {
      suite: Omit<EvaluationExperimentPlan["suite"], "cases" | "variants"> & {
        cases: EvaluationCaseSnapshotV4[];
        variants: EvaluationVariantSnapshotV4[];
      };
    })
>;

/** Nothing a Version 4 or 5 plan recorded changes meaning; one input per case, no environment. */
function upgradeLegacyPlan(plan: z.infer<typeof legacyPlanSchema>): ExperimentPlan {
  if (plan.kind !== "evaluation") return { ...plan, schemaVersion: EXPERIMENT_SCHEMA_VERSION } as ExperimentPlan;
  return {
    ...plan,
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    suite: {
      ...plan.suite,
      cases: plan.suite.cases.map(({ input, ...evaluationCase }) => ({ ...evaluationCase, inputs: [input] })),
    },
  };
}

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

/** The connection each configuration reaches, in plan order. */
function planTargets(plan: ExperimentPlan): Array<ExperimentTarget> {
  return plan.kind === "repeated-request"
    ? [plan.commonInput.target]
    : plan.suite.variants.map(({ target }) => target);
}

/**
 * One cell at a time: an overall limit of 1, and every distinct connection a
 * plan targets, in the order the plan first uses it, at a limit of 1. What
 * every result before Version 6 ran at, and the default.
 */
export function sequentialExperimentConcurrency(
  plan: ExperimentPlan,
): ExperimentConcurrency {
  const connections = new Map<string, ExperimentConnectionConcurrency>();
  for (const target of planTargets(plan)) {
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
  plan: ExperimentPlan,
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
  target: Pick<ExperimentTarget, "profileId" | "endpoint">,
): string {
  return `${target.profileId}\u0000${target.endpoint}`;
}

function assertNoSensitiveProviderOptions(plan: ExperimentPlan): void {
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

  // A decision plan carries no options or tools to hold any.
  if (plan.kind === "decision-evaluation") return;
  const inputs = plan.kind === "repeated-request"
    ? [plan.commonInput]
    : plan.suite.variants.map((variant) => ({ options: variant.options, tools: plan.suite.tools }));
  inputs.forEach((input, inputIndex) => {
    const prefix = plan.kind === "repeated-request" ? "commonInput" : `suite.variants.${inputIndex}`;
    inspect(input.options.providerOptions, `${prefix}.options.providerOptions`);
    input.tools.forEach((tool, toolIndex) =>
      inspect(tool.providerOptions, `${prefix}.tools.${toolIndex}.providerOptions`),
    );
  });
}

function assertPlanReferences(plan: ExperimentPlan): void {
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

  if (plan.kind === "repeated-request") {
    const issue = environmentInputIssue(plan.commonInput);
    if (issue) throw new ExperimentValidationError(issue);
    return;
  }
  if (plan.kind === "evaluation") {
    assertEvaluationInputs(plan);
    assertPromptFileSources(plan);
  }
  const bindingIds = new Set(plan.suite.inputBindings.map(({ id }) => id));
  if (bindingIds.size !== plan.suite.inputBindings.length) {
    throw new ExperimentValidationError("Evaluation input binding identities must be unique.");
  }
  const cases = new Set<EvaluationCaseId>();
  plan.suite.cases.forEach((evaluationCase) => {
    if (cases.has(evaluationCase.caseId)) {
      throw new ExperimentValidationError(`Evaluation repeats case ${evaluationCase.caseId}.`);
    }
    const valueIds = Object.keys(evaluationCase.values);
    if (valueIds.length !== bindingIds.size || valueIds.some((id) => !bindingIds.has(id as EvaluationInputBindingId))) {
      throw new ExperimentValidationError(`Evaluation case ${evaluationCase.caseId} must snapshot exactly one value for every input binding.`);
    }
    if (plan.kind === "evaluation"
      ? (evaluationCase as EvaluationCaseSnapshotV6).inputs.some(({ conversationRevisionId }) => conversationRevisionId !== plan.suite.conversationRevisionId)
      : (evaluationCase as DecisionEvaluationCaseSnapshot).input.decisionRequestRevisionId !== plan.suite.decisionRequestRevisionId) {
      throw new ExperimentValidationError(
        `Evaluation case ${evaluationCase.caseId} resolves a different ${plan.kind === "evaluation" ? "conversation" : "decision request"} revision.`,
      );
    }
    cases.add(evaluationCase.caseId);
  });
  const variants = new Set<EvaluationVariantId>();
  plan.suite.variants.forEach((variant) => {
    if (variants.has(variant.variantId)) {
      throw new ExperimentValidationError(`Evaluation repeats configuration ${variant.variantId}.`);
    }
    variants.add(variant.variantId);
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

/** An input that records an environment says where every value came from, and agrees with it. */
function environmentInputIssue(
  input: Pick<ResolvedRunInput, "templateResolutions" | "environment">,
): string | undefined {
  if (input.environment && input.templateResolutions.some(({ valueSources }) => !valueSources)) {
    return "An input that records an environment must record valueSources for every template use.";
  }
  return environmentProvenanceIssue(input);
}

/**
 * A file snapshot and the template uses it replaced agree: every use of a
 * snapshot's prompt names that file and sends its messages under the pinned
 * revision, no other use names a file, and every snapshot replaced something.
 */
function assertPromptFileSources(plan: EvaluationExperimentPlan): void {
  const snapshots = new Map<string, PromptFileSnapshot>();
  for (const snapshot of plan.suite.promptSources ?? []) {
    if (snapshots.has(snapshot.templateId)) {
      throw new ExperimentValidationError(`Evaluation records more than one file source for prompt ${snapshot.templateId}.`);
    }
    snapshots.set(snapshot.templateId, snapshot);
  }
  const used = new Set<string>();
  const same = (left: unknown, right: unknown) =>
    JSON.stringify(stableJsonValue(left)) === JSON.stringify(stableJsonValue(right));
  for (const evaluationCase of plan.suite.cases) {
    for (const input of evaluationCase.inputs) {
      for (const resolution of input.templateResolutions) {
        const snapshot = snapshots.get(resolution.templateId);
        if (!snapshot) {
          if (resolution.fileSource) {
            throw new ExperimentValidationError(
              `Evaluation case ${evaluationCase.caseId}: template use ${resolution.templateUseId} names a file source the plan does not record.`,
            );
          }
          continue;
        }
        used.add(snapshot.templateId);
        const expected = {
          sourceRootName: snapshot.sourceRootName,
          path: snapshot.path,
          sourceDigest: snapshot.sourceDigest,
          baseTemplateRevisionId: snapshot.baseTemplateRevisionId,
        };
        if (
          resolution.templateRevisionId !== snapshot.baseTemplateRevisionId ||
          !same(resolution.fileSource, expected) ||
          !same(resolution.messages, snapshot.messages) ||
          !same(resolution.variableDefaults, snapshot.variableDefaults)
        ) {
          throw new ExperimentValidationError(
            `Evaluation case ${evaluationCase.caseId}: template use ${resolution.templateUseId} does not match the file source recorded for its prompt.`,
          );
        }
      }
    }
  }
  const unused = [...snapshots.keys()].find((templateId) => !used.has(templateId));
  if (unused) throw new ExperimentValidationError(`Evaluation records a file source for prompt ${unused}, which no template use sends.`);
}

/**
 * Every configuration finds exactly one input in every case, by environment,
 * and every input is sent by some configuration.
 */
function assertEvaluationInputs(plan: EvaluationExperimentPlan): void {
  const used = new Set(plan.suite.variants.map(({ environmentId }) => environmentId ?? ""));
  for (const evaluationCase of plan.suite.cases) {
    const keys = new Set<string>();
    for (const input of evaluationCase.inputs) {
      const key = input.environment?.environmentId ?? "";
      if (keys.has(key)) {
        throw new ExperimentValidationError(`Evaluation case ${evaluationCase.caseId} has more than one input for one environment.`);
      }
      keys.add(key);
      if (!used.has(key)) {
        throw new ExperimentValidationError(`Evaluation case ${evaluationCase.caseId} has an input no configuration uses.`);
      }
      const issue = environmentInputIssue(input);
      if (issue) throw new ExperimentValidationError(`Evaluation case ${evaluationCase.caseId}: ${issue}`);
    }
    for (const variant of plan.suite.variants) {
      if (!keys.has(variant.environmentId ?? "")) {
        throw new ExperimentValidationError(
          `Evaluation case ${evaluationCase.caseId} has no input for configuration ${variant.variantId}.`,
        );
      }
    }
  }
}

function assertResultReferences(
  result: ExperimentResultV6,
  plan: ExperimentPlan,
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
function assertConnectionStartOrder(result: ExperimentResultV6, plan: ExperimentPlan): void {
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

function cellConnectionKeys(plan: ExperimentPlan): (cellId: ExperimentCellId) => string {
  if (plan.kind === "repeated-request") {
    const key = experimentConnectionKey(plan.commonInput.target);
    return () => key;
  }
  const byVariant = new Map<EvaluationVariantId, string>(
    plan.suite.variants.map((variant) => [variant.variantId, experimentConnectionKey(variant.target)]),
  );
  const byCell = new Map(plan.cells.map((cell) => [cell.cellId, byVariant.get(cell.variantId)!]));
  return (cellId) => byCell.get(cellId)!;
}

function assertConcurrency(
  concurrency: ExperimentConcurrency,
  plan: ExperimentPlan,
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
  plan: ExperimentPlan,
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

/**
 * An older vocabulary rejects newer constructs rather than acquiring them, and
 * each run kind refuses the checks that read the other kind's evidence (D46).
 */
function assertPlanVocabulary(plan: ExperimentPlan): void {
  if (plan.kind === "repeated-request") return;
  const runKind = plan.kind === "evaluation" ? "chat" : "decision";
  for (const evaluationCase of plan.suite.cases) {
    for (const check of evaluationCase.checks) {
      const issue = checkVocabularyIssue(check, plan.checkSchemaVersion) ?? checkRunKindIssue(check.kind, runKind);
      if (issue) throw new ExperimentValidationError(`Invalid experiment plan at case ${evaluationCase.caseId}, check ${check.checkId}: ${issue}`);
    }
  }
}

export function parseExperimentPlanFile(value: unknown): ExperimentPlan {
  const version = unsupportedPlanVersionSchema.safeParse(value);
  if (version.success && ![4, 5, 6, EXPERIMENT_SCHEMA_VERSION].includes(version.data.schemaVersion)) {
    throw new ExperimentValidationError(
      `Experiment plan schema Version ${version.data.schemaVersion} is unsupported; expected Version 4, 5, 6, or ${EXPERIMENT_SCHEMA_VERSION}.`,
    );
  }
  const schemaVersion = version.success ? version.data.schemaVersion : undefined;
  const plan: ExperimentPlan = schemaVersion === EXPERIMENT_SCHEMA_VERSION
    ? { ...parseWith(planSchema, value, "experiment plan"), schemaVersion: EXPERIMENT_SCHEMA_VERSION } as ExperimentPlan
    : schemaVersion === 6
      ? { ...parseWith(planV6Schema, value, "experiment plan"), schemaVersion: EXPERIMENT_SCHEMA_VERSION } as ExperimentPlan
      : upgradeLegacyPlan(parseWith(legacyPlanSchema, value, "experiment plan"));
  assertPlanVocabulary(plan);
  assertPlanReferences(plan);
  assertNoSensitiveProviderOptions(plan);
  return plan;
}

export function parseExperimentPlanJson(contents: string): ExperimentPlan {
  try {
    return parseExperimentPlanFile(JSON.parse(contents));
  } catch (error) {
    if (error instanceof ExperimentValidationError) throw error;
    throw new ExperimentValidationError("Experiment plan is not valid JSON.");
  }
}

export function parseExperimentResultFile(
  value: unknown,
  plan: ExperimentPlan,
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
  plan: ExperimentPlan,
): ExperimentResultV6 {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new ExperimentValidationError("Experiment result is not valid JSON.");
  }
  return parseExperimentResultFile(value, plan);
}

export function serializeExperimentPlan(plan: ExperimentPlan): string {
  return serializeParsedExperimentPlan(parseExperimentPlanFile(plan));
}

/**
 * Serializes a plan that was already accepted by `parseExperimentPlanFile`.
 * This is useful to execution owners that must validate an ad hoc plan before
 * starting, but must not re-parse the full frozen input for every cell.
 */
export function serializeParsedExperimentPlan(plan: ExperimentPlan): string {
  return `${JSON.stringify(stableJsonValue(plan), null, 2)}\n`;
}

export function serializeExperimentResult(
  result: ExperimentResultInput,
  plan: ExperimentPlan,
): string {
  return `${JSON.stringify(stableJsonValue(parseExperimentResultFile(result, plan)), null, 2)}\n`;
}

/** The cost bound this plan runs under, whether or not it recorded one. */
export function experimentTurnCeiling(plan: ChatExperimentPlan): number {
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
export function experimentExposedTools(plan: ExperimentPlan): ToolDefinition[] {
  if (plan.kind === "decision-evaluation") return [];
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
  plan: ChatExperimentPlan,
  cellId: ExperimentCellId,
): ResolvedRunInput {
  const parsed = parseExperimentPlanFile(plan);
  if (parsed.kind === "decision-evaluation") {
    throw new ExperimentValidationError("A decision plan's cells are decision runs; materialize them with materializeParsedDecisionCellInput.");
  }
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
  plan: ChatExperimentPlan,
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
  const { environmentId, ...configuration } = variant;
  const input = evaluationCase.inputs.find(({ environment }) => environment?.environmentId === environmentId);
  if (!input) throw new ExperimentValidationError(`Evaluation case ${evaluationCase.caseId} has no input for configuration ${variant.variantId}.`);
  return { ...input, ...configuration, tools: plan.suite.tools, runId: plannedCell.runId };
}

/**
 * Materializes one decision cell from a plan already accepted by
 * `parseExperimentPlanFile`: the frozen request its case resolved, sent to its
 * configuration's target.
 */
export function materializeParsedDecisionCellInput(
  plan: DecisionEvaluationExperimentPlan,
  cell: ExperimentCell,
): ResolvedDecisionRunInput {
  const plannedCell = plan.cells.find((candidate) => candidate.cellId === cell.cellId);
  if (!plannedCell || plannedCell.runId !== cell.runId) {
    throw new ExperimentValidationError(`Unknown experiment cell ${cell.cellId}.`);
  }
  const evaluationCase = plan.suite.cases.find(({ caseId }) => caseId === plannedCell.caseId);
  if (!evaluationCase) throw new ExperimentValidationError(`Unknown evaluation case ${plannedCell.caseId}.`);
  const variant = plan.suite.variants.find(({ variantId }) => variantId === plannedCell.variantId);
  if (!variant) throw new ExperimentValidationError(`Unknown evaluation configuration ${plannedCell.variantId}.`);
  return {
    runId: plannedCell.runId,
    resolvedAt: evaluationCase.input.resolvedAt,
    target: variant.target,
    decision: evaluationCase.input.decision,
  };
}

/** A plan with no result survived an interrupted application session. */
export function experimentLifecycle(
  _plan: ExperimentPlan,
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
 * Whether a run failed because the provider answered its final attempt with
 * 429. Read from the trace, so no saved artifact records it.
 */
export function isRateLimitedRun(state: RunState): boolean {
  return state.status.kind === "failed" &&
    state.status.error.code === "provider_error" &&
    state.status.error.providerStatus === 429;
}

/**
 * How many attempts in the run the provider answered with 429 and that were
 * then retried. Read from the trace, like `isRateLimitedRun`, so it counts the
 * same way whoever retried them.
 */
export function rateLimitRetryCount(state: RunState): number {
  return state.turns.reduce((count, { attempts }) =>
    count + attempts.slice(0, -1).filter(({ status, error }) =>
      status === "failed" && error?.code === "provider_error" && error.providerStatus === 429).length, 0);
}

/** Whether a decision run failed because the provider answered its last attempt with 429. */
function isRateLimitedDecisionRun(run: DecisionRun): boolean {
  return run.status.kind === "failed" &&
    run.status.error.code === "provider_error" &&
    run.status.error.providerStatus === 429;
}

/**
 * What scoring reads from one repetition, whichever kind of run it was (D50).
 * Classification, counting, and scoring then happen once, so rules such as a
 * 429 counting as missing evidence cannot drift between the kinds.
 */
export interface RepetitionEvidence {
  /** `pending` for a run that never reached a terminal status. */
  status: TerminalRunStatus["kind"] | "pending";
  /** The run failed because the provider answered 429. */
  rateLimited: boolean;
  /** Attempts the provider answered with 429 and that were then retried. */
  rateLimitRetries: number;
  /** Absent where the run or provider never reported the quantity. */
  metrics: { totalDurationMs?: number; totalTokens?: number; outputTokens?: number };
  subject: CheckSubject;
}

function terminalKind(status: RunState["status"] | DecisionRun["status"]): RepetitionEvidence["status"] {
  return isTerminalRunStatus(status) ? status.kind : "pending";
}

export function repetitionEvidence(run: RunState | DecisionRun): RepetitionEvidence {
  if ("kind" in run && run.kind === "decision") {
    const startedAt = run.startedAt === undefined ? Number.NaN : Date.parse(run.startedAt);
    const endedAt = run.endedAt === undefined ? Number.NaN : Date.parse(run.endedAt);
    // Only a completed attempt carries usage; a failed one reported none.
    const usage = run.attempts.findLast(({ status }) => status === "completed")?.result?.usage;
    return {
      status: terminalKind(run.status),
      rateLimited: isRateLimitedDecisionRun(run),
      rateLimitRetries: run.attempts.slice(0, -1).filter(({ status, error }) =>
        status === "failed" && error?.code === "provider_error" && error.providerStatus === 429).length,
      metrics: {
        ...(Number.isFinite(startedAt) && Number.isFinite(endedAt) ? { totalDurationMs: endedAt - startedAt } : {}),
        ...(usage?.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
        ...(usage?.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
      },
      subject: decisionCheckSubject(run),
    };
  }
  const state = run as RunState;
  const metrics = runMetrics(state);
  return {
    status: terminalKind(state.status),
    rateLimited: isRateLimitedRun(state),
    rateLimitRetries: rateLimitRetryCount(state),
    metrics: {
      ...(metrics.totalDurationMs === undefined ? {} : { totalDurationMs: metrics.totalDurationMs }),
      ...(metrics.usage.totalTokens === undefined ? {} : { totalTokens: metrics.usage.totalTokens }),
      ...(metrics.usage.outputTokens === undefined ? {} : { outputTokens: metrics.usage.outputTokens }),
    },
    subject: runCheckSubject(state),
  };
}

/**
 * Derives summary evidence from immutable artifacts and ordinary run states.
 * Missing states are explicitly represented rather than treated as zero-valued
 * metrics or successful repetitions.
 */
export function repeatedExperimentAggregate(
  plan: RepeatedExperimentPlan,
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
  let rateLimited = 0;
  let cancelled = 0;
  let notRun = 0;
  let missingTrace = 0;
  let runsWithRetries = 0;
  let retriedAfterRateLimit = 0;
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
      case "failed": if (isRateLimitedRun(state)) rateLimited += 1; else failed += 1; break;
      case "cancelled": cancelled += 1; break;
      default: notRun += 1; continue;
    }
    const metrics = runMetrics(state);
    if (metrics.retryCount > 0) runsWithRetries += 1;
    if (rateLimitRetryCount(state) > 0) retriedAfterRateLimit += 1;
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
    rateLimited,
    cancelled,
    notRun,
    missingTrace,
    runsWithRetries,
    retriedAfterRateLimit,
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
  plan: EvaluationExperimentPlan,
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
  plan: EvaluationExperimentPlan,
  result: ExperimentResultInput | undefined,
  states?: ReadonlyMap<RunId, RunState>,
  criteria?: EvaluationCriteriaOverride,
): EvaluationBakeoffAssessment;
export function evaluationParsedExperimentAggregate(
  plan: DecisionEvaluationExperimentPlan,
  result: ExperimentResultInput | undefined,
  states?: ReadonlyMap<RunId, DecisionRun>,
  criteria?: EvaluationCriteriaOverride,
): EvaluationBakeoffAssessment<DecisionEvaluationVariantSnapshot>;
export function evaluationParsedExperimentAggregate(
  plan: SuiteExperimentPlan,
  result: ExperimentResultInput | undefined,
  states: ReadonlyMap<RunId, RunState | DecisionRun> = new Map(),
  criteria?: EvaluationCriteriaOverride,
): EvaluationBakeoffAssessment<EvaluationVariantSnapshot> {
  const steps = scoreSuiteExperimentSteps(plan, result, states, criteria);
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}

/** Same derivation as the synchronous API, suspended after each check and cell.
 * The generator owns only local work; abandoning it cannot mutate evidence.
 * Consumers must publish only the returned complete aggregate. */
export function evaluationParsedExperimentAggregateSteps(
  plan: EvaluationExperimentPlan,
  result: ExperimentResultInput | undefined,
  states?: ReadonlyMap<RunId, RunState>,
  criteria?: EvaluationCriteriaOverride,
): Generator<void, EvaluationBakeoffAssessment>;
export function evaluationParsedExperimentAggregateSteps(
  plan: DecisionEvaluationExperimentPlan,
  result: ExperimentResultInput | undefined,
  states?: ReadonlyMap<RunId, DecisionRun>,
  criteria?: EvaluationCriteriaOverride,
): Generator<void, EvaluationBakeoffAssessment<DecisionEvaluationVariantSnapshot>>;
export function evaluationParsedExperimentAggregateSteps(
  plan: SuiteExperimentPlan,
  result: ExperimentResultInput | undefined,
  states: ReadonlyMap<RunId, RunState | DecisionRun> = new Map(),
  criteria?: EvaluationCriteriaOverride,
): Generator<void, EvaluationBakeoffAssessment<EvaluationVariantSnapshot>> {
  return scoreSuiteExperimentSteps(plan, result, states, criteria);
}

/**
 * Scores either evaluation kind. Each repetition is projected into
 * `RepetitionEvidence` first (D50), so nothing below branches on the kind.
 */
function* scoreSuiteExperimentSteps(
  plan: SuiteExperimentPlan,
  result: ExperimentResultInput | undefined,
  states: ReadonlyMap<RunId, RunState | DecisionRun>,
  criteria?: EvaluationCriteriaOverride,
): Generator<void, EvaluationBakeoffAssessment<EvaluationVariantSnapshot>> {
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
  const variants: EvaluationVariantAssessment<EvaluationVariantSnapshot>[] = [];
  for (const variant of parsed.suite.variants as readonly EvaluationVariantSnapshot[]) {
    const assessments = new Map<EvaluationCaseId, EvaluationRepetitionAssessment[]>();
    const repetitionCounts: Record<EvaluationRepetitionClassification, number> = {
      passed: 0, "check-failed": 0, "not-evaluated": 0, "run-failed": 0, "rate-limited": 0,
      cancelled: 0, "not-run": 0, "trace-unavailable": 0,
    };
    const checkCounts = { total: 0, passed: 0, failed: 0, notEvaluated: 0 };
    let retriedAfterRateLimit = 0;
    const durations: number[] = [];
    const totalTokenValues: Array<number | undefined> = [];
    const outputTokenValues: Array<number | undefined> = [];

    for (const cell of parsed.cells.filter((candidate) => candidate.variantId === variant.variantId)) {
      const caseChecks = effectiveChecks.get(cell.caseId)!;
      const disposition = dispositions.get(cell.cellId);
      const state = states.get(cell.runId);
      const evidence = state ? repetitionEvidence(state) : undefined;
      checkCounts.total += caseChecks.length;
      let classification: EvaluationRepetitionClassification;
      let checks: CheckResult[] = [];
      if (disposition?.status === "not-run") {
        classification = "not-run";
        checkCounts.notEvaluated += caseChecks.length;
      } else if (!evidence) {
        classification = parsedResult ? "trace-unavailable" : "not-evaluated";
        checkCounts.notEvaluated += caseChecks.length;
      } else if (evidence.rateLimited) {
        // The run ended before a final answer, so its checks have nothing to read.
        classification = "rate-limited";
        checkCounts.notEvaluated += caseChecks.length;
      } else if (evidence.status === "failed") {
        classification = "run-failed";
        checks = yield* evaluateSubjectChecksSteps(evidence.subject, caseChecks);
      } else if (evidence.status === "cancelled") {
        classification = "cancelled";
        checks = yield* evaluateSubjectChecksSteps(evidence.subject, caseChecks);
      } else if (evidence.status !== "completed") {
        classification = "not-evaluated";
        checkCounts.notEvaluated += caseChecks.length;
      } else {
        checks = yield* evaluateSubjectChecksSteps(evidence.subject, caseChecks);
        const summary = checkOutcomeSummary(checks);
        classification = summary.notEvaluated > 0 ? "not-evaluated" : summary.failed > 0 ? "check-failed" : "passed";
      }
      if (checks.length > 0) {
        const summary = checkOutcomeSummary(checks);
        checkCounts.passed += summary.passed;
        checkCounts.failed += summary.failed;
        checkCounts.notEvaluated += summary.notEvaluated;
      }
      if (evidence && evidence.status !== "pending") {
        const { metrics } = evidence;
        totalTokenValues.push(metrics.totalTokens);
        outputTokenValues.push(metrics.outputTokens);
        if (evidence.status === "completed" && metrics.totalDurationMs !== undefined) durations.push(metrics.totalDurationMs);
      }
      repetitionCounts[classification] += 1;
      if (evidence && evidence.rateLimitRetries > 0) retriedAfterRateLimit += 1;
      assessments.set(cell.caseId, [...(assessments.get(cell.caseId) ?? []), {
        cellId: cell.cellId, runId: cell.runId, repetition: cell.repetition, classification, checks,
      }]);
      yield;
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
      !casePassed && repetitions.some(({ classification }) => isFailingRepetition(classification)),
    ).length;
    variants.push({
      variant,
      lifecycle,
      passed: caseAssessments.length > 0 && passed === caseAssessments.length,
      cases: caseAssessments,
      caseCounts: { total: caseAssessments.length, passed, failed, incomplete: caseAssessments.length - passed - failed },
      repetitionCounts,
      retriedAfterRateLimit,
      checkCounts,
      totalDurationMs: range(durations),
      totalTokens: usage(totalTokenValues),
      outputTokens: usage(outputTokenValues),
    });
  }
  return { lifecycle, variants };
}

export function evaluationVariantAssessment<Variant extends EvaluationVariantSnapshot>(
  aggregate: EvaluationBakeoffAssessment<Variant>,
  variantId: EvaluationVariantId,
): EvaluationVariantAssessment<Variant> {
  const assessment = aggregate.variants.find((item) => item.variant.variantId === variantId);
  if (!assessment) throw new ExperimentValidationError(`Unknown evaluation configuration ${variantId}.`);
  return assessment;
}
