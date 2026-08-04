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
  ConversationMessage,
  ConversationRevisionId,
  EntityId,
  EntityIdKind,
  EvaluationCaseId,
  EvaluationInputBindingId,
  EvaluationSuiteId,
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

export const EXPERIMENT_SCHEMA_VERSION = 3;
export const EXPERIMENT_PLAN_FILE_SUFFIX = ".plan.json";
export const EXPERIMENT_RESULT_FILE_SUFFIX = ".result.json";

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

export interface RepeatedExperimentPlanV3 {
  schemaVersion: 3;
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

export interface EvaluationCaseSnapshot {
  caseId: EvaluationCaseId;
  name: string;
  values: Record<EvaluationInputBindingId, string>;
  checks: CheckDefinition[];
  referenceAnswer?: string;
  /** Fully resolved authored input. A cell adds only its preallocated run ID. */
  input: Omit<ResolvedRunInput, "runId">;
}

export interface EvaluationExperimentCell extends ExperimentCellBase {
  caseId: EvaluationCaseId;
  repetition: number;
}

export interface EvaluationExperimentPlanV3 {
  schemaVersion: 3;
  experimentId: ExperimentId;
  kind: "evaluation";
  createdAt: string;
  checkSchemaVersion: typeof CHECK_SCHEMA_VERSION;
  scoringPolicy: "strict";
  repetitions: number;
  /** See `RepeatedExperimentPlanV3.turnCeiling`; the controller reads both. */
  turnCeiling?: number;
  suite: {
    suiteId: EvaluationSuiteId;
    name: string;
    conversationRevisionId: ConversationRevisionId;
    inputBindings: EvaluationInputBindingSnapshot[];
    cases: EvaluationCaseSnapshot[];
  };
  cells: EvaluationExperimentCell[];
}

export type ExperimentPlanV3 = RepeatedExperimentPlanV3 | EvaluationExperimentPlanV3;
export type ExperimentCell = RepeatedExperimentCell | EvaluationExperimentCell;

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

export interface ExperimentResultV3 {
  schemaVersion: 3;
  experimentId: ExperimentId;
  status: "completed" | "cancelled";
  endedAt: string;
  cells: ExperimentCellResult[];
}

export type EvaluationRepetitionClassification =
  | "passed"
  | "check-failed"
  | "not-evaluated"
  | "run-failed"
  | "cancelled"
  | "not-run"
  | "missing-trace";

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

export interface EvaluationAggregate {
  lifecycle: ExperimentLifecycle;
  passed: boolean;
  cases: EvaluationCaseAssessment[];
  caseCounts: { total: number; passed: number; failed: number };
  repetitionCounts: Record<EvaluationRepetitionClassification, number>;
  checkCounts: { total: number; passed: number; failed: number; notEvaluated: number };
  totalTokens: ExperimentUsageAggregate;
  outputTokens: ExperimentUsageAggregate;
}

export type ExperimentLifecycle = "interrupted" | "completed" | "cancelled";

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
        protocol: z.enum(["openai-compatible-chat-completions", "mock"]),
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
  input: commonInputSchema,
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
    cases: z.array(evaluationCaseSnapshotSchema).min(1),
  }).strict(),
  cells: z.array(experimentCellBaseSchema.extend({
    caseId: entityId("evaluation-case"),
    repetition: z.number().int().positive(),
  }).strict()).min(1),
}).strict();

const planSchema: z.ZodType<ExperimentPlanV3> = z.discriminatedUnion("kind", [
  repeatedPlanSchema,
  evaluationPlanSchema,
]);

// Kept only as schemas for clear rejection diagnostics when stale artifacts
// are encountered. PR10 intentionally does not migrate pre-v3 artifacts.
const unsupportedPlanVersionSchema = z.object({ schemaVersion: z.number().int() }).passthrough();

const resultSchema = z
  .object({
    schemaVersion: z.literal(EXPERIMENT_SCHEMA_VERSION),
    experimentId: entityId("experiment"),
    status: z.enum(["completed", "cancelled"]),
    endedAt: z.string().datetime(),
    cells: z.array(
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

function planInputs(plan: ExperimentPlanV3): Array<Omit<ResolvedRunInput, "runId">> {
  return plan.kind === "repeated-request"
    ? [plan.commonInput]
    : plan.suite.cases.map(({ input }) => input);
}

function assertNoSensitiveProviderOptions(plan: ExperimentPlanV3): void {
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
    const prefix = plan.kind === "repeated-request" ? "commonInput" : `suite.cases.${inputIndex}.input`;
    inspect(input.options.providerOptions, `${prefix}.options.providerOptions`);
    input.tools.forEach((tool, toolIndex) =>
      inspect(tool.providerOptions, `${prefix}.tools.${toolIndex}.providerOptions`),
    );
  });
}

function assertPlanReferences(plan: ExperimentPlanV3): void {
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
  const cases = new Map<EvaluationCaseId, EvaluationCaseSnapshot>();
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
  if (plan.cells.length !== plan.suite.cases.length * plan.repetitions) {
    throw new ExperimentValidationError("Evaluation cells must include every planned case repetition exactly once.");
  }
  plan.suite.cases.forEach((evaluationCase, caseIndex) => {
    for (let repetition = 1; repetition <= plan.repetitions; repetition += 1) {
      const cell = plan.cells[caseIndex * plan.repetitions + repetition - 1];
      if (cell?.caseId !== evaluationCase.caseId || cell.repetition !== repetition) {
        throw new ExperimentValidationError("Evaluation cells must retain suite case order and contiguous one-based repetitions.");
      }
    }
  });
}

function assertResultReferences(
  result: ExperimentResultV3,
  plan: ExperimentPlanV3,
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
  if (result.status === "completed" && result.cells.some((cell) => cell.status === "not-run")) {
    throw new ExperimentValidationError("A completed experiment cannot contain unstarted cells.");
  }
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
  return /^(?:experiment_[A-Za-z0-9][A-Za-z0-9._-]*\.(?:plan|result)\.json)$/.test(fileName)
    && !fileName.includes("..");
}

export function assertExperimentEntryName(fileName: string): string {
  if (!isExperimentEntryName(fileName)) {
    throw new ExperimentValidationError(`${fileName} is not an experiment artifact file name.`);
  }
  return fileName;
}

export function experimentArtifactIdentity(fileName: string): {
  experimentId: ExperimentId;
  kind: "plan" | "result";
} {
  const safeName = assertExperimentEntryName(fileName);
  const kind = safeName.endsWith(EXPERIMENT_PLAN_FILE_SUFFIX) ? "plan" : "result";
  const suffix = kind === "plan" ? EXPERIMENT_PLAN_FILE_SUFFIX : EXPERIMENT_RESULT_FILE_SUFFIX;
  return {
    experimentId: safeName.slice(0, -suffix.length) as ExperimentId,
    kind,
  };
}

export function parseExperimentPlanFile(value: unknown): ExperimentPlanV3 {
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

export function parseExperimentPlanJson(contents: string): ExperimentPlanV3 {
  try {
    return parseExperimentPlanFile(JSON.parse(contents));
  } catch (error) {
    if (error instanceof ExperimentValidationError) throw error;
    throw new ExperimentValidationError("Experiment plan is not valid JSON.");
  }
}

export function parseExperimentResultFile(
  value: unknown,
  plan: ExperimentPlanV3,
): ExperimentResultV3 {
  const parsedPlan = parseExperimentPlanFile(plan);
  const version = unsupportedPlanVersionSchema.safeParse(value);
  if (version.success && version.data.schemaVersion !== EXPERIMENT_SCHEMA_VERSION) {
    throw new ExperimentValidationError(
      `Experiment result schema Version ${version.data.schemaVersion} is unsupported; expected Version ${EXPERIMENT_SCHEMA_VERSION}.`,
    );
  }
  const result = parseWith(resultSchema, value, "experiment result") as ExperimentResultV3;
  assertResultReferences(result, parsedPlan);
  return result;
}

export function parseExperimentResultJson(
  contents: string,
  plan: ExperimentPlanV3,
): ExperimentResultV3 {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new ExperimentValidationError("Experiment result is not valid JSON.");
  }
  return parseExperimentResultFile(value, plan);
}

export function serializeExperimentPlan(plan: ExperimentPlanV3): string {
  return serializeParsedExperimentPlan(parseExperimentPlanFile(plan));
}

/**
 * Serializes a plan that was already accepted by `parseExperimentPlanFile`.
 * This is useful to execution owners that must validate an ad hoc plan before
 * starting, but must not re-parse the full frozen input for every cell.
 */
export function serializeParsedExperimentPlan(plan: ExperimentPlanV3): string {
  return `${JSON.stringify(stableJsonValue(plan), null, 2)}\n`;
}

export function serializeExperimentResult(
  result: ExperimentResultV3,
  plan: ExperimentPlanV3,
): string {
  return `${JSON.stringify(stableJsonValue(parseExperimentResultFile(result, plan)), null, 2)}\n`;
}

/** The cost bound this plan runs under, whether or not it recorded one. */
export function experimentTurnCeiling(plan: ExperimentPlanV3): number {
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
export function experimentExposedTools(plan: ExperimentPlanV3): ToolDefinition[] {
  const inputs = plan.kind === "repeated-request"
    ? [plan.commonInput]
    : plan.suite.cases.map(({ input }) => input);
  const byId = new Map<ToolDefinition["id"], ToolDefinition>();
  for (const input of inputs) {
    for (const tool of input.tools) if (!byId.has(tool.id)) byId.set(tool.id, tool);
  }
  return [...byId.values()];
}

/** Materializes exactly one preallocated repetition without changing its frozen input. */
export function materializeExperimentCellInput(
  plan: ExperimentPlanV3,
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
  plan: ExperimentPlanV3,
  cell: ExperimentCell,
): ResolvedRunInput {
  const plannedCell = plan.cells.find((candidate) => candidate.cellId === cell.cellId);
  if (!plannedCell || plannedCell.runId !== cell.runId) {
    throw new ExperimentValidationError(`Unknown experiment cell ${cell.cellId}.`);
  }
  if (plan.kind === "repeated-request") {
    return { ...plan.commonInput, runId: plannedCell.runId };
  }
  const evaluationCell = plannedCell as EvaluationExperimentCell;
  const evaluationCase = plan.suite.cases.find(({ caseId }) => caseId === evaluationCell.caseId);
  if (!evaluationCase) throw new ExperimentValidationError(`Unknown evaluation case ${evaluationCell.caseId}.`);
  return { ...evaluationCase.input, runId: plannedCell.runId };
}

/** A plan with no result survived an interrupted application session. */
export function experimentLifecycle(
  _plan: ExperimentPlanV3,
  result?: ExperimentResultV3,
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
  plan: RepeatedExperimentPlanV3,
  result: ExperimentResultV3 | undefined,
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
  plan: EvaluationExperimentPlanV3,
  result: ExperimentResultV3 | undefined,
  states: ReadonlyMap<RunId, RunState> = new Map(),
): EvaluationAggregate {
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
 */
export function evaluationParsedExperimentAggregate(
  plan: EvaluationExperimentPlanV3,
  result: ExperimentResultV3 | undefined,
  states: ReadonlyMap<RunId, RunState> = new Map(),
): EvaluationAggregate {
  const parsed = plan;
  const parsedResult = result ? parseExperimentResultFile(result, parsed) : undefined;
  const dispositions = new Map(parsedResult?.cells.map((cell) => [cell.cellId, cell]));
  const cases = new Map(parsed.suite.cases.map((evaluationCase) => [evaluationCase.caseId, evaluationCase]));
  const assessments = new Map<EvaluationCaseId, EvaluationRepetitionAssessment[]>();
  const repetitionCounts: Record<EvaluationRepetitionClassification, number> = {
    passed: 0,
    "check-failed": 0,
    "not-evaluated": 0,
    "run-failed": 0,
    cancelled: 0,
    "not-run": 0,
    "missing-trace": 0,
  };
  const checkCounts = { total: 0, passed: 0, failed: 0, notEvaluated: 0 };
  const totalTokenValues: Array<number | undefined> = [];
  const outputTokenValues: Array<number | undefined> = [];

  for (const cell of parsed.cells) {
    const evaluationCase = cases.get(cell.caseId)!;
    const disposition = dispositions.get(cell.cellId);
    const state = states.get(cell.runId);
    checkCounts.total += evaluationCase.checks.length;
    let classification: EvaluationRepetitionClassification;
    let checks: CheckResult[] = [];

    if (disposition?.status === "not-run" || (!disposition && !state)) {
      classification = "not-run";
      checkCounts.notEvaluated += evaluationCase.checks.length;
    } else if (!state) {
      classification = "missing-trace";
      checkCounts.notEvaluated += evaluationCase.checks.length;
    } else if (state.status.kind === "failed") {
      classification = "run-failed";
      checks = evaluateChecks(state, evaluationCase.checks);
    } else if (state.status.kind === "cancelled") {
      classification = "cancelled";
      checks = evaluateChecks(state, evaluationCase.checks);
    } else if (state.status.kind !== "completed") {
      classification = "not-evaluated";
      checkCounts.notEvaluated += evaluationCase.checks.length;
    } else {
      checks = evaluateChecks(state, evaluationCase.checks);
      const summary = checkOutcomeSummary(checks);
      classification = summary.notEvaluated > 0
        ? "not-evaluated"
        : summary.failed > 0
          ? "check-failed"
          : "passed";
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
    }
    repetitionCounts[classification] += 1;
    const repetition: EvaluationRepetitionAssessment = {
      cellId: cell.cellId,
      runId: cell.runId,
      repetition: cell.repetition,
      classification,
      checks,
    };
    assessments.set(cell.caseId, [...(assessments.get(cell.caseId) ?? []), repetition]);
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
  const passedCases = caseAssessments.filter(({ passed }) => passed).length;
  const terminalCases = caseAssessments.filter(({ repetitions }) =>
    repetitions.every(({ classification }) => ![
      "not-evaluated",
      "not-run",
      "missing-trace",
    ].includes(classification)),
  ).length;
  return {
    lifecycle: experimentLifecycle(parsed, parsedResult),
    passed: caseAssessments.length > 0 && passedCases === caseAssessments.length,
    cases: caseAssessments,
    caseCounts: {
      total: caseAssessments.length,
      passed: passedCases,
      failed: terminalCases - passedCases,
    },
    repetitionCounts,
    checkCounts,
    totalTokens: usage(totalTokenValues),
    outputTokens: usage(outputTokenValues),
  };
}
