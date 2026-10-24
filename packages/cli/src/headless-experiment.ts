import type { CredentialSelection, DecisionTransport, ProviderTurnTransport } from "../../contracts/src/index.ts";
import type { DecisionRun } from "../../core/src/decision.ts";
import type { DecisionRunTrace } from "../../core/src/decision-trace.ts";
import { ExperimentController } from "../../runner/src/experiment-controller.ts";
import type { ExperimentConnectionPause } from "../../runner/src/experiment-controller.ts";
import { toolBindingFor } from "../../core/src/tool-binding-resolution.ts";
import {
  experimentPlanFileName,
  experimentResultFileName,
  rateLimitRetries,
} from "../../core/src/experiment.ts";
import type {
  ChatExperimentPlan,
  DecisionEvaluationExperimentPlan,
  ExperimentCell,
  ExperimentConcurrencySetting,
  ExperimentPlan,
  ExperimentResult,
} from "../../core/src/experiment.ts";
import type { ConnectionRequirement, ProjectFile } from "../../core/src/project.ts";
import { serializeDecisionRunTrace, serializeRunTrace } from "../../core/src/run-trace.ts";
import type { RunId, RunState, RunTrace } from "../../core/src/run-kernel/index.ts";
import { createEntityId } from "../../core/src/run-kernel/types.ts";
import type { ToolDefinition, ToolId } from "../../core/src/run-kernel/types.ts";
import type { ToolExecutor, ToolBinding } from "../../core/src/tool-execution.ts";
import { resolveProviderCapabilities } from "../../core/src/types.ts";
import type { ProviderCapabilities } from "../../core/src/types.ts";
import { assertDistinctConnectionVariables, resolveConnection } from "./credentials.ts";
import type { ConnectionResolution } from "./credentials.ts";
import type { NodeProjectFolder } from "./project-folder.ts";
import { createHeadlessToolExecutor } from "./tool-executor.ts";
import { resolveToolGrants, verifyHeadlessToolBindings } from "./tool-grants.ts";
import type { HeadlessToolGrant } from "./tool-grants.ts";

/** Anything that stops a run before a plan is written: exit code 2. */
export class HeadlessSetupError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HeadlessSetupError";
  }
}

/**
 * `--concurrency` and `--connection-concurrency`. `limit` caps the whole run
 * and is also every connection's limit unless `connections` lowers it.
 */
export interface HeadlessConcurrency {
  limit?: number;
  /** By connection requirement ID. Each may only lower `limit`. */
  connections?: ReadonlyMap<string, number>;
}

/** What every headless command takes beyond what it runs. */
export interface HeadlessRunOptions {
  projectDirectory: string;
  /** Requirement IDs declared as needing no credential. */
  noAuth?: ReadonlySet<string>;
  environment: Readonly<Record<string, string | undefined>>;
  /** Chat suites and `repeat` send turns; decision suites send decisions. */
  transport: ProviderTurnTransport & DecisionTransport;
  /** How many repetitions may run at once. One at a time when omitted. */
  concurrency?: HeadlessConcurrency;
  /** `--allow-tool`: command and MCP tools this invocation may run. None when omitted. */
  toolGrants?: readonly HeadlessToolGrant[];
  /** `--retry-rate-limits`: retry a 429 up to the bound decision 8 sets. Off when omitted. */
  retryRateLimits?: boolean;
  /** One line per finished repetition, for stderr. */
  onProgress?(line: string): void;
  /** Injected by tests. */
  createExecutor?(binding: ToolBinding): ToolExecutor;
}

export interface HeadlessRun<Outcome> {
  readonly done: Promise<Outcome>;
  /** Stops the active request and every later repetition. */
  cancel(): void;
}

/** A controller of either run kind; the CLI only ever cancels it. */
export type HeadlessController = ExperimentController<RunState> | ExperimentController<DecisionRun>;

/** Starts `execute`, letting a cancel that arrives before the controller exists still reach it. */
export function startCancellable<Outcome>(
  execute: (onController: (controller: HeadlessController) => void) => Promise<Outcome>,
): HeadlessRun<Outcome> {
  let controller: HeadlessController | undefined;
  let cancelled = false;
  const done = execute((created) => {
    controller = created;
    if (cancelled) created.cancel();
  });
  return {
    done,
    cancel() {
      cancelled = true;
      controller?.cancel();
    },
  };
}

/** A connection this run will call, with its key and what the project declares it can do. */
export interface HeadlessConnection {
  requirement: ConnectionRequirement;
  resolution: ConnectionResolution;
  capabilities: ProviderCapabilities;
}

/**
 * Checks the flags that name connections, then resolves a key for each
 * connection the run will call. Only those: resolving others would refuse a
 * run over a credential it never uses.
 */
export function resolveHeadlessConnections(
  project: ProjectFile,
  usedRequirementIds: ReadonlySet<string>,
  options: HeadlessRunOptions,
): { connections: HeadlessConnection[]; concurrency: ExperimentConcurrencySetting } {
  const declared = (id: string) => project.connectionRequirements.some((requirement) => requirement.id === id);
  const unknownNoAuth = [...(options.noAuth ?? [])].filter((id) => !declared(id));
  if (unknownNoAuth.length > 0) {
    throw new HeadlessSetupError(`--no-auth names ${unknownNoAuth.join(", ")}, which this project does not declare.`);
  }
  const limit = options.concurrency?.limit ?? 1;
  const connectionLimits = options.concurrency?.connections ?? new Map<string, number>();
  const unknownConcurrency = [...connectionLimits.keys()].filter((id) => !declared(id));
  if (unknownConcurrency.length > 0) {
    throw new HeadlessSetupError(
      `--connection-concurrency names ${unknownConcurrency.join(", ")}, which this project does not declare.`,
    );
  }
  for (const [id, connectionLimit] of connectionLimits) {
    // The overall limit caps every connection, so a higher one could never be reached.
    if (connectionLimit > limit) {
      throw new HeadlessSetupError(
        `--connection-concurrency allows ${id} ${connectionLimit} at once, more than the overall --concurrency of ${limit}.`,
      );
    }
  }

  const usedRequirements = project.connectionRequirements.filter(({ id }) => usedRequirementIds.has(id));
  assertDistinctConnectionVariables(usedRequirements);
  // With no device profile, a connection's capabilities are what the project
  // declares it needs — the same snapshot the app takes when it creates one.
  const connections = usedRequirements.map((requirement) => ({
    requirement,
    resolution: resolveConnection(requirement, options.environment, options.noAuth ?? new Set()),
    capabilities: resolveProviderCapabilities(requirement.provider, requirement.capabilityOverrides),
  }));
  return {
    connections,
    concurrency: {
      maxInFlight: limit,
      connectionLimit: limit,
      connections: connections.flatMap(({ resolution: { requirementId, endpoint } }) => {
        const connectionLimit = connectionLimits.get(requirementId);
        return connectionLimit === undefined
          ? []
          : [{ profileId: createEntityId("profile", requirementId), endpoint, limit: connectionLimit }];
      }),
    },
  };
}

/**
 * A grant from `--allow-tool` outranks an enabled project mock, as a grant
 * does in the app. A tool with neither is refused before anything is sent.
 */
export function headlessBindingForTool(
  project: ProjectFile,
  exposed: readonly ToolDefinition[],
  options: HeadlessRunOptions,
) {
  const grants: ReadonlyMap<ToolId, ToolBinding> =
    resolveToolGrants(project, exposed, options.toolGrants ?? [], options.environment);
  return (tool: ToolDefinition): ToolBinding | undefined => {
    const granted = grants.get(tool.id);
    return toolBindingFor(
      tool.id,
      project.toolMocks.find(({ toolId }) => toolId === tool.id),
      granted?.kind === "command" ? granted : undefined,
      granted?.kind === "mcp" ? granted : undefined,
    );
  };
}

/** `State` is the plan kind's run state. */
export interface HeadlessExperimentRecord<State extends RunState | DecisionRun = RunState | DecisionRun> {
  planSaved: boolean;
  /** Present only when the result was written. */
  result?: ExperimentResult;
  states: ReadonlyMap<RunId, State>;
  /** Traces that were actually written, by run ID, relative to the project folder. */
  tracePaths: ReadonlyMap<string, string>;
  /** Why the run did not finish, when it did not. */
  error?: string;
}

/** What each run kind adds to a headless experiment: chat serves tools, decisions have none. */
export type HeadlessExperimentWork =
  | { plan: ChatExperimentPlan; toolBindings: readonly ToolBinding[]; tools: readonly ToolDefinition[] }
  | { plan: DecisionEvaluationExperimentPlan };

interface HeadlessExperimentInput {
  folder: NodeProjectFolder;
  connections: readonly HeadlessConnection[];
  concurrency: ExperimentConcurrencySetting;
  options: HeadlessRunOptions;
  /** Names one finished repetition in the progress line, before its status. */
  describeCell(cell: ExperimentCell): string;
  onController(controller: HeadlessController): void;
}

/**
 * Drives one frozen plan of either run kind to the end, writing its plan,
 * result, and traces under the app's names, and reporting each finished
 * repetition.
 */
export async function driveHeadlessExperiment(
  input: Extract<HeadlessExperimentWork, { tools: unknown }> & HeadlessExperimentInput,
): Promise<HeadlessExperimentRecord<RunState>>;
export async function driveHeadlessExperiment(
  input: HeadlessExperimentWork & HeadlessExperimentInput,
): Promise<HeadlessExperimentRecord>;
export async function driveHeadlessExperiment(
  input: HeadlessExperimentWork & HeadlessExperimentInput,
): Promise<HeadlessExperimentRecord> {
  const { folder, plan, options } = input;
  const credentials = new Map<string, ConnectionResolution>(
    input.connections.map(({ resolution }) => [createEntityId("profile", resolution.requirementId), resolution]),
  );
  let planSaved = false;
  let result: ExperimentResult | undefined;
  let resultSaved = false;
  let states: ReadonlyMap<RunId, RunState | DecisionRun> = new Map();
  const tracePaths = new Map<string, string>();
  let finished = 0;
  /** When each paused connection resumes, as last announced, by profile and endpoint. */
  const announcedPauses = new Map<string, number>();

  const shared = {
    async prepareCredential(target: { profileId: string; endpoint: string }): Promise<CredentialSelection> {
      const resolution = credentials.get(target.profileId);
      if (!resolution || resolution.endpoint !== target.endpoint) {
        throw new HeadlessSetupError(`No credential was resolved for ${target.profileId} at ${target.endpoint}.`);
      }
      return resolution.credential;
    },
    concurrency: input.concurrency,
    ...(options.retryRateLimits ? { retryPolicy: rateLimitRetries() } : {}),
    async savePlan(frozen: ExperimentPlan, serialized: string) {
      await folder.saveExperimentArtifact(experimentPlanFileName(frozen.experimentId), serialized);
      planSaved = true;
    },
    async saveResult(saved: ExperimentResult, serialized: string) {
      await folder.saveExperimentArtifact(experimentResultFileName(saved.experimentId), serialized);
      resultSaved = true;
    },
    onProgress(progress: { states: ReadonlyMap<RunId, RunState | DecisionRun>; pausedConnections: readonly ExperimentConnectionPause[] }) {
      states = progress.states;
      for (const pause of progress.pausedConnections) {
        // Announced when a pause starts or a later 429 lengthens it, so a run
        // that goes quiet reads as waiting rather than hung.
        const key = `${pause.profileId} ${pause.endpoint}`;
        if ((announcedPauses.get(key) ?? 0) >= pause.until) continue;
        announcedPauses.set(key, pause.until);
        const connection = credentials.get(pause.profileId)?.requirementId ?? pause.profileId;
        const seconds = Math.max(1, Math.ceil((pause.until - Date.now()) / 1_000));
        options.onProgress?.(
          `Rate limited on ${connection} (${pause.endpoint}); new repetitions there wait ${seconds} s.`,
        );
      }
    },
  };
  async function recordTrace(trace: RunTrace | DecisionRunTrace, serialized: string, cell: ExperimentCell) {
    await folder.saveTrace(trace.runId, serialized);
    tracePaths.set(trace.runId, folder.tracePath(trace.runId));
    finished += 1;
    options.onProgress?.(
      `[${finished}/${plan.cells.length}] ${input.describeCell(cell)}: ${trace.status.kind}`,
    );
  }

  let controller: HeadlessController;
  if (input.plan.kind === "decision-evaluation") {
    controller = new ExperimentController<DecisionRun>({
      ...shared,
      plan: input.plan,
      decisionTransport: options.transport,
      onTerminalTrace: (trace, cell) => recordTrace(trace, serializeDecisionRunTrace(trace), cell),
    });
  } else {
    // The plan's kind decides the work's shape; TypeScript cannot narrow the
    // union through a nested discriminant.
    const { plan: chatPlan, toolBindings, tools } = input as Extract<HeadlessExperimentWork, { tools: unknown }>;
    controller = new ExperimentController<RunState>({
      ...shared,
      plan: chatPlan,
      transport: options.transport,
      toolBindings: [...toolBindings],
      createExecutor: options.createExecutor ?? createHeadlessToolExecutor(options.environment),
      verifyToolBindings: (bindings) => verifyHeadlessToolBindings(
        bindings,
        (toolId) => tools.find(({ id }) => id === toolId)?.name ?? toolId,
        options.environment,
      ),
      onTerminalTrace: (trace, cell) => recordTrace(trace, serializeRunTrace(trace), cell),
    });
  }
  input.onController(controller);

  let error: string | undefined;
  try {
    result = await controller.run();
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  return {
    planSaved,
    ...(resultSaved && result ? { result } : {}),
    states,
    tracePaths,
    ...(error === undefined ? {} : { error }),
  };
}
