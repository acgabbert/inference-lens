import {
  DEFAULT_EXPERIMENT_TURN_CEILING,
  MAX_EXPERIMENT_TURN_CEILING,
  MIN_EXPERIMENT_TURN_CEILING,
} from "../../core/src/experiment.ts";
import type { RepeatedExperimentPlanV4 } from "../../core/src/experiment.ts";
import { prepareProjectRevisionRun } from "../../core/src/project.ts";
import type { ProjectFile } from "../../core/src/project.ts";
import { supportsProtocol } from "../../core/src/provider-protocols.ts";
import { randomUUID } from "../../core/src/random-id.ts";
import { createResolvedRunInput } from "../../core/src/run-kernel/run-execution.ts";
import { createEntityId } from "../../core/src/run-kernel/types.ts";
import type { ResolvedRunInput, ToolDefinition } from "../../core/src/run-kernel/types.ts";
import type { ProviderCapabilities } from "../../core/src/types.ts";

export const DEFAULT_REPETITION_COUNT = 5;
export const MIN_REPETITION_COUNT = 2;
export const MAX_REPETITION_COUNT = 100;

export function normalizedRepetitionCount(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_REPETITION_COUNT;
  return Math.max(MIN_REPETITION_COUNT, Math.min(MAX_REPETITION_COUNT, Math.trunc(value)));
}

export function normalizedTurnCeiling(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_EXPERIMENT_TURN_CEILING;
  return Math.max(
    MIN_EXPERIMENT_TURN_CEILING,
    Math.min(MAX_EXPERIMENT_TURN_CEILING, Math.trunc(value)),
  );
}

/** Freezes the resolved semantic input and allocates every ordinary run before execution. */
export function createRepeatedExperimentPlan(
  input: ResolvedRunInput,
  repetitionCount: number,
  turnCeiling: number,
): RepeatedExperimentPlanV4 {
  const frozenInput = structuredClone(input);
  const { runId: discardedRunId, ...commonInput } = frozenInput;
  void discardedRunId;
  const experimentId = createEntityId("experiment", randomUUID());
  return {
    schemaVersion: 4,
    experimentId,
    kind: "repeated-request",
    createdAt: new Date().toISOString(),
    commonInput,
    turnCeiling: normalizedTurnCeiling(turnCeiling),
    cells: Array.from({ length: normalizedRepetitionCount(repetitionCount) }, (_, index) => ({
      cellId: createEntityId("experiment-cell", randomUUID()),
      ordinal: index + 1,
      runId: createEntityId("run", randomUUID()),
    })),
  };
}

/** The connection a repeated run will call, as this host resolved it. */
export interface RepeatedLocalConnection {
  requirementId: string;
  requirementName: string;
  endpoint: string;
  capabilities: ProviderCapabilities;
}

/**
 * Why a repeated run of the project's saved defaults cannot start, as data.
 * Each host phrases it for its own medium.
 */
export type RepeatedStartBlocker =
  | { kind: "template_diagnostic"; message: string }
  | { kind: "endpoint_missing"; connection: RepeatedLocalConnection }
  | { kind: "protocol_disabled"; connection: RepeatedLocalConnection; protocol: ResolvedRunInput["target"]["protocol"] }
  | { kind: "streaming_unsupported"; connection: RepeatedLocalConnection }
  | { kind: "tools_unsupported"; connection: RepeatedLocalConnection }
  | { kind: "unbound_tools"; toolNames: string[] };

export interface ProjectDefaultsRunInput {
  project: ProjectFile;
  /** The connection `project.defaults.target` names, resolved on this host. */
  connection: RepeatedLocalConnection;
  responseMode: ResolvedRunInput["responseMode"];
  /** The host-local binding that will serve one of the enabled tools. */
  bindingForTool(tool: ToolDefinition): unknown;
}

/**
 * Resolves the run the project's saved defaults describe — the active
 * conversation revision, its target, and its enabled tools — the way the
 * app's composer resolves a run of the same revision. It reads the project
 * and never writes it.
 *
 * Like the composer, it carries the temperature and no other inference
 * option.
 */
export function resolveProjectDefaultsRun(
  input: ProjectDefaultsRunInput,
): { ok: true; input: ResolvedRunInput } | { ok: false; blocker: RepeatedStartBlocker } {
  const { project, connection } = input;
  const { defaults } = project;
  const revision = project.conversationRevisions.find(({ id }) => id === defaults.conversationRevisionId);
  if (!revision) {
    return { ok: false, blocker: { kind: "template_diagnostic", message: "The project's active conversation revision does not exist." } };
  }
  const prepared = prepareProjectRevisionRun(project, revision);
  if (!prepared.ok) {
    const [first] = prepared.diagnostics;
    return {
      ok: false,
      blocker: {
        kind: "template_diagnostic",
        message: first
          ? `Cannot run template use "${first.templateUseId}": ${first.diagnostic.message}`
          : "Resolve the template diagnostics before running.",
      },
    };
  }
  const tools = project.tools.filter(({ id }) => defaults.enabledToolIds.includes(id));

  if (!connection.endpoint.trim()) return { ok: false, blocker: { kind: "endpoint_missing", connection } };
  if (!supportsProtocol(connection.capabilities, defaults.target.protocol)) {
    return { ok: false, blocker: { kind: "protocol_disabled", connection, protocol: defaults.target.protocol } };
  }
  if (input.responseMode === "streaming" && !connection.capabilities.streaming) {
    return { ok: false, blocker: { kind: "streaming_unsupported", connection } };
  }
  if (tools.length > 0 && !connection.capabilities.tools) {
    return { ok: false, blocker: { kind: "tools_unsupported", connection } };
  }
  // An unbound tool would fail every repetition at a call nobody is present
  // to answer, so it is refused before the plan is written.
  const unbound = tools.filter((tool) => !input.bindingForTool(tool));
  if (unbound.length > 0) return { ok: false, blocker: { kind: "unbound_tools", toolNames: unbound.map(({ name }) => name) } };

  const resolved = createResolvedRunInput(
    {
      provider: "openai-compatible",
      endpoint: connection.endpoint,
      model: defaults.target.model,
      protocol: defaults.target.protocol,
      capabilities: connection.capabilities,
      responseMode: input.responseMode,
      messages: prepared.messages,
      ...(defaults.options.temperature === undefined || defaults.options.temperature === null
        ? {}
        : { temperature: defaults.options.temperature }),
    },
    { conversationId: revision.conversationId, conversationRevisionId: revision.id },
    tools,
    prepared.templateResolutions,
  );
  return {
    ok: true,
    input: { ...resolved, target: { ...resolved.target, profileId: createEntityId("profile", connection.requirementId) } },
  };
}
