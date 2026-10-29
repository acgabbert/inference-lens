import { z } from "zod";

import {
  DECISION_TRACE_ORDER_SENSITIVE_KEYS,
  parseDecisionRunTrace,
  type DecisionRunTrace,
} from "./decision-trace.ts";
import type { RunId, RunState, RunTrace } from "./run-kernel/types.ts";
import {
  createRunTrace,
  reduceRunEvents,
  runTraceSchemaVersionFor,
} from "./run-kernel/reducer.ts";
import { environmentProvenanceIssue } from "./environment.ts";
import { isSensitiveTemplateVariableName } from "./project.ts";
import { RunTraceValidationError } from "./run-trace-error.ts";
import { ORDER_SENSITIVE_KEYS, stableJsonValue } from "./stable-json.ts";
import { renderTemplateMessages } from "./template-engine.ts";

export const RUN_TRACE_SCHEMA_VERSION = 9;
/**
 * Older traces upgrade on read to this version, the last one without value
 * sources: version 9's provenance cannot be inferred from what they recorded.
 */
const LAST_VERSION_WITHOUT_VALUE_SOURCES = 8;
export const RUN_TRACE_FILE_SUFFIX = ".json";
/** The project-folder directory that holds saved run traces. */
export const TRACES_DIRECTORY_NAME = "traces";

export { RunTraceValidationError };

/**
 * Either kind of saved run (D22). Version 8 covers both: a decision trace
 * carries `kind: "decision"`, and a chat trace carries no `kind` at all, so
 * its contents are otherwise those of version 7.
 */
export type SavedRunTrace =
  | { kind: "chat"; trace: RunTrace }
  | { kind: "decision"; trace: DecisionRunTrace };

const traceEnvelopeBaseSchema = z
  .object({
    runId: z.string().regex(/^run_.+/),
    input: z.object({ runId: z.string().regex(/^run_.+/) }).passthrough(),
    status: z
      .object({
        kind: z.enum(["completed", "cancelled", "failed"]),
      })
      .passthrough(),
    events: z.array(
      z
        .object({
          eventId: z.string().regex(/^event_.+/),
          runId: z.string().regex(/^run_.+/),
          sequence: z.number().int().nonnegative(),
          occurredAt: z.string().datetime(),
          elapsedMs: z.number().nonnegative(),
          type: z.enum([
            "run.started",
            "turn.started",
            "turn.attempt_started",
            "turn.attempt_failed",
            "exchange.requested",
            "exchange.response_started",
            "exchange.frame_received",
            "assistant.text_delta",
            "assistant.reasoning_delta",
            "assistant.tool_call_delta",
            "usage.reported",
            "assistant.continuation",
            "assistant.completed",
            "tool.execution_started",
            "tool.execution_completed",
            "tool.execution_failed",
            "tool.result_supplied",
            "run.completed",
            "run.cancelled",
            "run.failed",
          ]),
        })
        .passthrough(),
    ),
    turns: z.array(z.unknown()),
    exchanges: z.record(z.string(), z.unknown()),
    toolResults: z.array(z.unknown()),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime(),
  });

const branchProvenanceSchema = z
  .object({
    runId: z.string().regex(/^run_.+/),
    parentConversationRevisionId: z.string().regex(/^revision_.+/).optional(),
    messageId: z.string().regex(/^message_.+/),
  })
  .strict();

const templateMessageRoleSchema = z.enum(["system", "user", "assistant"]);

const legacyResolvedTemplateContentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fragment"), text: z.string() }).strict(),
  z
    .object({
      kind: z.literal("messages"),
      messages: z
        .array(
          z
            .object({
              role: templateMessageRoleSchema,
              content: z.string(),
            })
            .strict(),
        )
        .min(1),
    })
    .strict(),
]);

/**
 * Template provenance is re-derived during parsing, so its shape is checked by
 * the envelope rather than trusted from the file. An artifact that fails here
 * is rejected as an invalid trace instead of reaching the renderer and
 * surfacing as an internal error.
 */
const resolvedTemplateUseBaseSchema = z.object({
  templateUseId: z.string().regex(/^template-use_.+/),
  templateId: z.string().regex(/^template_.+/),
  templateRevisionId: z.string().regex(/^template-revision_.+/),
  templateName: z.string(),
  variableDefaults: z.record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    z.string(),
  ),
  values: z.record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    z.string(),
  ),
  outputMessageIds: z.array(z.string().regex(/^message_.+/)).min(1),
});

function rejectSensitiveTemplateProvenance(
  resolution: { variableDefaults: Record<string, string>; values: Record<string, string> },
  context: z.RefinementCtx,
): void {
  for (const field of ["variableDefaults", "values"] as const) {
    Object.keys(resolution[field]).forEach((name) => {
      if (isSensitiveTemplateVariableName(name)) {
        context.addIssue({
          code: "custom",
          path: [field, name],
          message: "Template provenance cannot contain secret-like variables.",
        });
      }
    });
  }
}

const legacyResolvedTemplateUseSchema = resolvedTemplateUseBaseSchema
  .extend({
    content: legacyResolvedTemplateContentSchema,
    fragmentRole: templateMessageRoleSchema.optional(),
  })
  .strict()
  .superRefine(rejectSensitiveTemplateProvenance);

const resolvedTemplateMessagesSchema = z
  .array(
    z
      .object({
        role: templateMessageRoleSchema,
        content: z.string(),
      })
      .strict(),
  )
  .min(1);

const resolvedTemplateUseSchema = resolvedTemplateUseBaseSchema
  .extend({ messages: resolvedTemplateMessagesSchema })
  .strict()
  .superRefine(rejectSensitiveTemplateProvenance);

const templateVariableNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

/** Version 9: every recorded value names the layer that supplied it. */
const sourcedResolvedTemplateUseSchema = resolvedTemplateUseBaseSchema
  .extend({
    messages: resolvedTemplateMessagesSchema,
    valueSources: z.record(
      templateVariableNameSchema,
      z.enum(["template-default", "environment", "authored-use", "run-override", "case"]),
    ),
  })
  .strict()
  .superRefine((resolution, context) => {
    rejectSensitiveTemplateProvenance(resolution, context);
    const valueNames = Object.keys(resolution.values).sort();
    const sourceNames = Object.keys(resolution.valueSources).sort();
    if (JSON.stringify(valueNames) !== JSON.stringify(sourceNames)) {
      context.addIssue({
        code: "custom",
        path: ["valueSources"],
        message: "Template provenance must name a source for every value, and only for values.",
      });
    }
  });

const runEnvironmentSnapshotSchema = z
  .object({
    environmentId: z.string().regex(/^environment_.+/),
    name: z.string(),
    consumed: z.record(templateVariableNameSchema, z.string()),
  })
  .strict()
  .superRefine((environment, context) => {
    Object.keys(environment.consumed).forEach((name) => {
      if (isSensitiveTemplateVariableName(name)) {
        context.addIssue({
          code: "custom",
          path: ["consumed", name],
          message: "Environment provenance cannot contain secret-like entries.",
        });
      }
    });
  });

const traceV1EnvelopeSchema = traceEnvelopeBaseSchema
  .extend({ schemaVersion: z.literal(1) })
  .strict();

const traceV2EnvelopeSchema = traceEnvelopeBaseSchema
  .extend({
    schemaVersion: z.literal(2),
    branchedFrom: branchProvenanceSchema.optional(),
  })
  .strict();

const traceV3EnvelopeSchema = traceEnvelopeBaseSchema
  .extend({
    schemaVersion: z.literal(3),
    input: z
      .object({
        runId: z.string().regex(/^run_.+/),
        templateResolutions: z.array(legacyResolvedTemplateUseSchema),
      })
      .passthrough(),
    branchedFrom: branchProvenanceSchema.optional(),
  })
  .strict();

const traceV4EnvelopeSchema = traceEnvelopeBaseSchema
  .extend({
    schemaVersion: z.literal(4),
    input: z
      .object({
        runId: z.string().regex(/^run_.+/),
        templateResolutions: z.array(legacyResolvedTemplateUseSchema),
        responseMode: z.enum(["streaming", "buffered"]),
      })
      .passthrough(),
    branchedFrom: branchProvenanceSchema.optional(),
  })
  .strict();

const traceV5EnvelopeSchema = traceEnvelopeBaseSchema
  .extend({
    schemaVersion: z.literal(5),
    input: z
      .object({
        runId: z.string().regex(/^run_.+/),
        templateResolutions: z.array(resolvedTemplateUseSchema),
        responseMode: z.enum(["streaming", "buffered"]),
      })
      .passthrough(),
    branchedFrom: branchProvenanceSchema.optional(),
  })
  .strict();

/**
 * Version 6 adds tool-execution evidence. It is a required collection rather
 * than an optional one so that an artifact cannot be ambiguous between "this
 * run executed no tools" and "this file predates the field": the former is an
 * empty array, the latter is a version-5 envelope.
 */
const traceV6EnvelopeSchema = traceEnvelopeBaseSchema
  .extend({
    schemaVersion: z.literal(6),
    input: z
      .object({
        runId: z.string().regex(/^run_.+/),
        templateResolutions: z.array(resolvedTemplateUseSchema),
        responseMode: z.enum(["streaming", "buffered"]),
      })
      .passthrough(),
    toolExecutions: z.array(z.unknown()),
    branchedFrom: branchProvenanceSchema.optional(),
  })
  .strict();

/**
 * Version 7 adds `assistant.continuation` events: the opaque provider state a
 * later turn replays. Otherwise identical to version 6.
 */
const traceV7EnvelopeSchema = traceV6EnvelopeSchema.extend({
  schemaVersion: z.literal(7),
});

/**
 * Version 8 introduces decision traces beside chat ones. A chat trace is
 * otherwise identical to version 7 and still has no `kind`.
 */
const traceV8EnvelopeSchema = traceV6EnvelopeSchema.extend({
  schemaVersion: z.literal(8),
});

/**
 * Version 9 adds prompt environments: each template use names the source of
 * every value, and the input records the environment entries it consumed.
 */
const traceV9EnvelopeSchema = traceV6EnvelopeSchema.extend({
  schemaVersion: z.literal(9),
  input: z
    .object({
      runId: z.string().regex(/^run_.+/),
      templateResolutions: z.array(sourcedResolvedTemplateUseSchema),
      responseMode: z.enum(["streaming", "buffered"]),
      environment: runEnvironmentSnapshotSchema.optional(),
    })
    .passthrough(),
});

// Discriminated on the version so a rejection reports the offending field in
// the matching envelope, rather than collapsing every branch's complaint into
// one union error.
const traceEnvelopeSchema = z.discriminatedUnion("schemaVersion", [
  traceV1EnvelopeSchema,
  traceV2EnvelopeSchema,
  traceV3EnvelopeSchema,
  traceV4EnvelopeSchema,
  traceV5EnvelopeSchema,
  traceV6EnvelopeSchema,
  traceV7EnvelopeSchema,
  traceV8EnvelopeSchema,
  traceV9EnvelopeSchema,
]);

export function traceFileName(runId: RunId): string {
  if (!/^run_[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || runId.includes("..")) {
    throw new RunTraceValidationError("Run ID cannot be used as a trace filename.");
  }
  return `${runId}${RUN_TRACE_FILE_SUFFIX}`;
}

/**
 * Guards a name that will be joined onto the traces directory. History entries
 * are discovered rather than derived from a validated run ID, so the name is
 * treated as untrusted input on the way back to the filesystem. The rule is
 * deliberately narrower than the platform's: no separators, no traversal, and
 * no leading dot, so it holds identically in the browser and in Rust.
 */
export function isTraceEntryName(fileName: string): boolean {
  return (
    fileName.endsWith(RUN_TRACE_FILE_SUFFIX) &&
    fileName.length > RUN_TRACE_FILE_SUFFIX.length &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(fileName) &&
    !fileName.includes("..")
  );
}

export function assertTraceEntryName(fileName: string): string {
  if (!isTraceEntryName(fileName)) {
    throw new RunTraceValidationError(
      `${fileName} is not a run trace file name.`,
    );
  }
  return fileName;
}

export function serializeRunTrace(trace: RunTrace): string {
  const parsed = parseRunTraceFile(trace);
  const current: RunTrace = { ...parsed, schemaVersion: runTraceSchemaVersionFor(parsed.input) };
  return `${JSON.stringify(stableJsonValue(current), null, 2)}\n`;
}

function parseTraceJson(contents: string): unknown {
  try {
    return JSON.parse(contents);
  } catch {
    throw new RunTraceValidationError("Run trace is not valid JSON.");
  }
}

export function parseRunTraceJson(contents: string): RunTrace {
  return parseRunTraceFile(parseTraceJson(contents));
}

/** The kind a saved trace claims; absent means chat. */
function traceKind(value: unknown): "chat" | "decision" {
  if (!value || typeof value !== "object" || !("kind" in value)) return "chat";
  if (value.kind === "decision") return "decision";
  throw new RunTraceValidationError(
    `Invalid run trace at kind: ${JSON.stringify(value.kind)} is not a run kind this version reads.`,
  );
}

/** Parses a saved run of either kind, for history, import, and export. */
export function parseSavedRunTrace(value: unknown): SavedRunTrace {
  if (traceKind(value) === "chat") return { kind: "chat", trace: parseRunTraceFile(value) };
  const trace = parseDecisionRunTrace(value);
  traceFileName(trace.runId);
  return { kind: "decision", trace };
}

export function parseSavedRunTraceJson(contents: string): SavedRunTrace {
  return parseSavedRunTrace(parseTraceJson(contents));
}

export function serializeDecisionRunTrace(trace: DecisionRunTrace): string {
  const parsed = parseSavedRunTrace(trace);
  if (parsed.kind !== "decision") {
    throw new RunTraceValidationError("A chat trace is serialized with serializeRunTrace.");
  }
  const value = stableJsonValue(parsed.trace, {
    orderSensitiveKeys: new Set([
      ...ORDER_SENSITIVE_KEYS,
      ...DECISION_TRACE_ORDER_SENSITIVE_KEYS,
    ]),
  });
  return `${JSON.stringify(value, null, 2)}\n`;
}

function migrateTemplateResolutionShape(
  input: RunTrace["input"],
): RunTrace["input"] {
  const templateResolutions = input.templateResolutions.map((resolution) => {
    if ("messages" in resolution) return resolution;
    const legacy = resolution as unknown as z.infer<
      typeof legacyResolvedTemplateUseSchema
    >;
    const { content, fragmentRole, ...shared } = legacy;
    if (content.kind === "fragment" && !fragmentRole) {
      throw new RunTraceValidationError(
        `Template provenance for "${legacy.templateUseId}" is missing its fragment role.`,
      );
    }
    return {
      ...shared,
      messages:
        content.kind === "fragment"
          ? [{ role: fragmentRole!, content: content.text }]
          : content.messages,
    };
  });
  return { ...input, templateResolutions } as RunTrace["input"];
}

/** Parses a chat trace; a decision trace is refused rather than misread. */
export function parseRunTraceFile(value: unknown): RunTrace {
  if (traceKind(value) === "decision") {
    throw new RunTraceValidationError(
      "This is a decision run trace, not a chat run, so it cannot be opened here.",
    );
  }
  const result = traceEnvelopeSchema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new RunTraceValidationError(
      first
        ? `Invalid run trace at ${first.path.join(".") || "root"}: ${first.message}`
        : "Run trace is invalid.",
    );
  }

  const envelope = value as unknown as RunTrace;
  let trace = envelope;
  if (trace.schemaVersion < 3) {
    trace = {
      ...trace,
      schemaVersion: LAST_VERSION_WITHOUT_VALUE_SOURCES,
      input: {
        ...trace.input,
        templateResolutions: [],
      },
      events: trace.events.map((event) =>
        event.type === "run.started"
          ? {
              ...event,
              input: {
                ...event.input,
                templateResolutions: [],
              },
            }
          : event,
      ),
    };
  }
  if (envelope.schemaVersion < 4) {
    trace = {
      ...trace,
      schemaVersion: LAST_VERSION_WITHOUT_VALUE_SOURCES,
      input: { ...trace.input, responseMode: "streaming" },
      events: trace.events.map((event) => {
        if (event.type === "run.started") {
          return {
            ...event,
            input: { ...event.input, responseMode: "streaming" as const },
          };
        }
        if (event.type === "turn.started") {
          return {
            ...event,
            input: { ...event.input, responseMode: "streaming" as const },
          };
        }
        return event;
      }),
      turns: trace.turns.map((turn) => ({
        ...turn,
        attempts: turn.attempts.map((attempt) => ({
          ...attempt,
          input: { ...attempt.input, responseMode: "streaming" as const },
        })),
      })),
    };
  }
  if (envelope.schemaVersion < 5) {
    trace = {
      ...trace,
      schemaVersion: LAST_VERSION_WITHOUT_VALUE_SOURCES,
      input: migrateTemplateResolutionShape(trace.input),
      events: trace.events.map((event) =>
        event.type === "run.started"
          ? { ...event, input: migrateTemplateResolutionShape(event.input) }
          : event,
      ),
    };
  }
  if (envelope.schemaVersion < 6) {
    trace = {
      ...trace,
      schemaVersion: LAST_VERSION_WITHOUT_VALUE_SOURCES,
      toolExecutions: [],
    };
  }
  if (
    envelope.schemaVersion < 7 &&
    trace.events.some((event) => event.type === "assistant.continuation")
  ) {
    throw new RunTraceValidationError(
      "Run trace contains an event its schema version does not define.",
    );
  }
  if (envelope.schemaVersion < 9 && Object.hasOwn(trace.input, "environment")) {
    throw new RunTraceValidationError(
      "Run trace input contains a field its schema version does not define.",
    );
  }
  const environmentIssue = envelope.schemaVersion >= 9 ? environmentProvenanceIssue(trace.input) : undefined;
  if (environmentIssue) throw new RunTraceValidationError(environmentIssue);
  if (trace.runId !== trace.input.runId) {
    throw new RunTraceValidationError("Run trace input has a different run ID.");
  }
  if (trace.events.some((event) => event.runId !== trace.runId)) {
    throw new RunTraceValidationError("Run trace contains an event for another run.");
  }
  const firstSequence = trace.events[0]?.sequence ?? 0;
  if (trace.events.some((event, index) => event.sequence !== firstSequence + index)) {
    throw new RunTraceValidationError("Run trace event sequence is not contiguous.");
  }
  if (trace.events[0]?.type !== "run.started") {
    throw new RunTraceValidationError("Run trace must begin with run.started.");
  }
  const terminal = trace.events.at(-1);
  const expectedTerminal = `run.${trace.status.kind}`;
  if (terminal?.type !== expectedTerminal) {
    throw new RunTraceValidationError(
      `Run trace must end with ${expectedTerminal}.`,
    );
  }
  if (trace.startedAt !== trace.events[0].occurredAt) {
    throw new RunTraceValidationError("Run trace start time does not match its events.");
  }
  if (trace.endedAt !== terminal.occurredAt) {
    throw new RunTraceValidationError("Run trace end time does not match its events.");
  }
  traceFileName(trace.runId);

  const templateUseIds = new Set<string>();
  const templateOutputMessageIds = new Set<string>();
  for (const resolution of trace.input.templateResolutions) {
    if (templateUseIds.has(resolution.templateUseId)) {
      throw new RunTraceValidationError(
        `Template provenance repeats use "${resolution.templateUseId}".`,
      );
    }
    templateUseIds.add(resolution.templateUseId);
    for (const messageId of resolution.outputMessageIds) {
      if (templateOutputMessageIds.has(messageId)) {
        throw new RunTraceValidationError(
          `Template provenance repeats output message "${messageId}".`,
        );
      }
      templateOutputMessageIds.add(messageId);
    }

    const rendered = renderTemplateMessages(
      resolution.messages,
      resolution.values,
    );
    if (rendered.diagnostics.length > 0) {
      throw new RunTraceValidationError(
        `Template provenance for "${resolution.templateUseId}" is unresolved.`,
      );
    }
    const expected = rendered.messages.map((message, index) => ({
      id: resolution.outputMessageIds[index],
      role: message.role,
      text: message.content,
    }));
    if (
      expected.length !== resolution.outputMessageIds.length ||
      expected.some(({ id, role, text }) => {
        const message = trace.input.messages.find(
          (candidate) => candidate.id === id,
        );
        return (
          !message ||
          message.role !== role ||
          message.content.length !== 1 ||
          message.content[0]?.type !== "text" ||
          message.content[0].text !== text ||
          (message.role === "assistant" && Boolean(message.toolCalls?.length))
        );
      })
    ) {
      throw new RunTraceValidationError(
        `Template provenance for "${resolution.templateUseId}" does not match resolved input messages.`,
      );
    }
  }

  let canonical: RunTrace;
  try {
    canonical = createRunTrace(reduceRunEvents(trace.runId, trace.events));
  } catch (error) {
    throw new RunTraceValidationError(
      `Run trace events are inconsistent: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }
  for (const key of [
    "input",
    "status",
    "turns",
    "exchanges",
    "toolExecutions",
    "toolResults",
    "startedAt",
    "endedAt",
  ] as const) {
    if (
      JSON.stringify(stableJsonValue(trace[key])) !==
      JSON.stringify(stableJsonValue(canonical[key]))
    ) {
      throw new RunTraceValidationError(
        `Run trace ${key} does not match its event stream.`,
      );
    }
  }
  return trace;
}

/** Restores an imported immutable trace as inspectable, non-running state. */
export function runStateFromTrace(trace: RunTrace): RunState {
  const parsed = parseRunTraceFile(trace);
  return reduceRunEvents(parsed.runId, parsed.events);
}
