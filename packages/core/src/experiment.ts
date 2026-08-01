import { z } from "zod";

import { isSensitiveTemplateVariableName } from "./project.ts";
import { runMetrics } from "./run-metrics.ts";
import { finalAssistantOutput, outputCharacterCount } from "./run-output.ts";
import { stableJsonValue } from "./stable-json.ts";
import type {
  ConversationMessage,
  EntityId,
  EntityIdKind,
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
} from "./run-kernel/types.ts";

export const EXPERIMENT_SCHEMA_VERSION = 2;
export const EXPERIMENT_PLAN_FILE_SUFFIX = ".plan.json";
export const EXPERIMENT_RESULT_FILE_SUFFIX = ".result.json";

export class ExperimentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExperimentValidationError";
  }
}

export interface RepeatedExperimentCell {
  cellId: ExperimentCellId;
  ordinal: number;
  runId: RunId;
}

export interface RepeatedExperimentPlanV2 {
  schemaVersion: 2;
  experimentId: ExperimentId;
  kind: "repeated-request";
  createdAt: string;
  commonInput: Omit<ResolvedRunInput, "runId">;
  cells: RepeatedExperimentCell[];
}

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

export interface ExperimentResultV2 {
  schemaVersion: 2;
  experimentId: ExperimentId;
  status: "completed" | "cancelled";
  endedAt: string;
  cells: ExperimentCellResult[];
}

/** @deprecated Prefer RepeatedExperimentPlanV2. */
export type RepeatedExperimentPlanV1 = RepeatedExperimentPlanV2;
/** @deprecated Prefer ExperimentResultV2. */
export type ExperimentResultV1 = ExperimentResultV2;

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
    name: z.string().trim().min(1),
    description: z.string().optional(),
    inputSchema: jsonObjectSchema,
    providerOptions: jsonObjectSchema.optional(),
  })
  .strict();

const legacyTemplateContentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fragment"), text: z.string() }).strict(),
  z
    .object({
      kind: z.literal("messages"),
      messages: z
        .array(
          z
            .object({
              role: z.enum(["system", "user", "assistant"]),
              content: z.string(),
            })
            .strict(),
        )
        .min(1),
    })
    .strict(),
]);

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

const resolvedTemplateUseSchema: z.ZodType<ResolvedTemplateUse> = z.union([
  resolvedTemplateUseBaseSchema
    .extend({ messages: templateMessagesSchema })
    .strict(),
  resolvedTemplateUseBaseSchema
    .extend({
      content: legacyTemplateContentSchema,
      fragmentRole: z.enum(["system", "user", "assistant"]).optional(),
    })
    .strict()
    .transform(({ content, fragmentRole, ...resolution }, context) => {
      if (content.kind === "fragment" && !fragmentRole) {
        context.addIssue({
          code: "custom",
          path: ["fragmentRole"],
          message: "Fragment template provenance requires a role.",
        });
        return z.NEVER;
      }
      return {
        ...resolution,
        messages:
          content.kind === "fragment"
            ? [{ role: fragmentRole!, content: content.text }]
            : content.messages,
      } as ResolvedTemplateUse;
    }),
]);

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

const commonInputSchema = z
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
    templateResolutions: z.array(resolvedTemplateUseSchema),
    responseMode: z.enum(["streaming", "buffered"]),
    options: inferenceOptionsSchema,
    tools: z.array(toolDefinitionSchema),
    resolvedAt: z.string().datetime(),
  })
  .strict();

const planSchema = z
  .object({
    schemaVersion: z.literal(EXPERIMENT_SCHEMA_VERSION),
    experimentId: entityId("experiment"),
    kind: z.literal("repeated-request"),
    createdAt: z.string().datetime(),
    commonInput: commonInputSchema,
    cells: z
      .array(
        z
          .object({
            cellId: entityId("experiment-cell"),
            ordinal: z.number().int().positive(),
            runId: entityId("run"),
          })
          .strict(),
      )
      .min(2),
  })
  .strict();

const planV1Schema = planSchema.extend({ schemaVersion: z.literal(1) }).strict();

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

const resultV1Schema = resultSchema
  .extend({ schemaVersion: z.literal(1) })
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

function assertNoSensitiveProviderOptions(plan: RepeatedExperimentPlanV1): void {
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

  inspect(plan.commonInput.options.providerOptions, "commonInput.options.providerOptions");
  plan.commonInput.tools.forEach((tool, index) =>
    inspect(tool.providerOptions, `commonInput.tools.${index}.providerOptions`),
  );
}

function assertPlanReferences(plan: RepeatedExperimentPlanV1): void {
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
}

function assertResultReferences(
  result: ExperimentResultV1,
  plan: RepeatedExperimentPlanV1,
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

export function parseExperimentPlanFile(value: unknown): RepeatedExperimentPlanV1 {
  const source =
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    value.schemaVersion === 1
      ? {
          ...parseWith(planV1Schema, value, "experiment plan"),
          schemaVersion: EXPERIMENT_SCHEMA_VERSION,
        }
      : value;
  const plan = parseWith(planSchema, source, "experiment plan") as RepeatedExperimentPlanV1;
  assertPlanReferences(plan);
  assertNoSensitiveProviderOptions(plan);
  return plan;
}

export function parseExperimentPlanJson(contents: string): RepeatedExperimentPlanV1 {
  try {
    return parseExperimentPlanFile(JSON.parse(contents));
  } catch (error) {
    if (error instanceof ExperimentValidationError) throw error;
    throw new ExperimentValidationError("Experiment plan is not valid JSON.");
  }
}

export function parseExperimentResultFile(
  value: unknown,
  plan: RepeatedExperimentPlanV1,
): ExperimentResultV1 {
  const parsedPlan = parseExperimentPlanFile(plan);
  const source =
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    value.schemaVersion === 1
      ? {
          ...parseWith(resultV1Schema, value, "experiment result"),
          schemaVersion: EXPERIMENT_SCHEMA_VERSION,
        }
      : value;
  const result = parseWith(resultSchema, source, "experiment result") as ExperimentResultV1;
  assertResultReferences(result, parsedPlan);
  return result;
}

export function parseExperimentResultJson(
  contents: string,
  plan: RepeatedExperimentPlanV1,
): ExperimentResultV1 {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new ExperimentValidationError("Experiment result is not valid JSON.");
  }
  return parseExperimentResultFile(value, plan);
}

export function serializeExperimentPlan(plan: RepeatedExperimentPlanV1): string {
  return serializeParsedExperimentPlan(parseExperimentPlanFile(plan));
}

/**
 * Serializes a plan that was already accepted by `parseExperimentPlanFile`.
 * This is useful to execution owners that must validate an ad hoc plan before
 * starting, but must not re-parse the full frozen input for every cell.
 */
export function serializeParsedExperimentPlan(plan: RepeatedExperimentPlanV1): string {
  return `${JSON.stringify(stableJsonValue(plan), null, 2)}\n`;
}

export function serializeExperimentResult(
  result: ExperimentResultV1,
  plan: RepeatedExperimentPlanV1,
): string {
  return `${JSON.stringify(stableJsonValue(parseExperimentResultFile(result, plan)), null, 2)}\n`;
}

/** Materializes exactly one preallocated repetition without changing its frozen input. */
export function materializeExperimentCellInput(
  plan: RepeatedExperimentPlanV1,
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
  plan: RepeatedExperimentPlanV1,
  cell: RepeatedExperimentCell,
): ResolvedRunInput {
  const plannedCell = plan.cells.find((candidate) => candidate.cellId === cell.cellId);
  if (!plannedCell || plannedCell.runId !== cell.runId) {
    throw new ExperimentValidationError(`Unknown experiment cell ${cell.cellId}.`);
  }
  return { ...plan.commonInput, runId: plannedCell.runId };
}

/** A plan with no result survived an interrupted application session. */
export function experimentLifecycle(
  _plan: RepeatedExperimentPlanV1,
  result?: ExperimentResultV1,
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
  plan: RepeatedExperimentPlanV1,
  result: ExperimentResultV1 | undefined,
  states: ReadonlyMap<RunId, RunState> = new Map(),
): RepeatedExperimentAggregate {
  const parsedPlan = parseExperimentPlanFile(plan);
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
    distinctFinalAssistantOutputs: new Set(outputs).size,
    outputCharacterCount: range(outputs.map(outputCharacterCount)),
  };
}
