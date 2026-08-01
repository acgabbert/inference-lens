import { z } from "zod";

import type { RunId, RunState, RunTrace } from "./run-kernel/types.ts";
import {
  createRunTrace,
  reduceRunEvents,
} from "./run-kernel/reducer.ts";
import { isSensitiveTemplateVariableName } from "./project.ts";
import { stableJsonValue } from "./stable-json.ts";
import { renderTemplateMessages } from "./template-engine.ts";

export const RUN_TRACE_SCHEMA_VERSION = 5;
export const RUN_TRACE_FILE_SUFFIX = ".json";

/**
 * Run traces are diagnostic evidence, not authored project state. The parser
 * validates the versioned envelope and reconstructs canonical state from its
 * event stream. Incompatible or internally inconsistent artifacts are
 * rejected instead of being displayed as trustworthy evidence.
 */
export class RunTraceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunTraceValidationError";
  }
}

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
            "assistant.completed",
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

const resolvedTemplateUseSchema = resolvedTemplateUseBaseSchema
  .extend({
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
  .strict()
  .superRefine(rejectSensitiveTemplateProvenance);

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

// Discriminated on the version so a rejection reports the offending field in
// the matching envelope, rather than collapsing every branch's complaint into
// one union error.
const traceEnvelopeSchema = z.discriminatedUnion("schemaVersion", [
  traceV1EnvelopeSchema,
  traceV2EnvelopeSchema,
  traceV3EnvelopeSchema,
  traceV4EnvelopeSchema,
  traceV5EnvelopeSchema,
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
  const current: RunTrace = { ...parsed, schemaVersion: RUN_TRACE_SCHEMA_VERSION };
  return `${JSON.stringify(stableJsonValue(current), null, 2)}\n`;
}

export function parseRunTraceJson(contents: string): RunTrace {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new RunTraceValidationError("Run trace is not valid JSON.");
  }
  return parseRunTraceFile(value);
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

export function parseRunTraceFile(value: unknown): RunTrace {
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
      schemaVersion: RUN_TRACE_SCHEMA_VERSION,
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
      schemaVersion: RUN_TRACE_SCHEMA_VERSION,
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
      schemaVersion: RUN_TRACE_SCHEMA_VERSION,
      input: migrateTemplateResolutionShape(trace.input),
      events: trace.events.map((event) =>
        event.type === "run.started"
          ? { ...event, input: migrateTemplateResolutionShape(event.input) }
          : event,
      ),
    };
  }
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
