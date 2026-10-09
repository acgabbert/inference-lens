import type { CredentialSelection, ProviderTurnTransport } from "../../contracts/src/index.ts";
import {
  createEvaluationStartPlan,
  evaluationStartBlocker,
  resolveEvaluationLocalTargets,
} from "../../runner/src/evaluation-start.ts";
import type { EvaluationLocalProfile } from "../../runner/src/evaluation-start.ts";
import { ExperimentController } from "../../runner/src/experiment-controller.ts";
import { toolBindingFor } from "../../core/src/tool-binding-resolution.ts";
import { evaluationSuitePreflight, resolveEvaluationVariant } from "../../core/src/evaluation-suites.ts";
import {
  evaluationParsedExperimentAggregate,
  experimentPlanFileName,
  experimentResultFileName,
  rateLimitRetries,
} from "../../core/src/experiment.ts";
import type {
  EvaluationExperimentPlanV4,
  ExperimentConcurrencySetting,
  ExperimentResult,
} from "../../core/src/experiment.ts";
import type { EvaluationSuite, ProjectFile } from "../../core/src/project.ts";
import { serializeRunTrace } from "../../core/src/run-trace.ts";
import type { RunId, RunState } from "../../core/src/run-kernel/index.ts";
import { createEntityId } from "../../core/src/run-kernel/types.ts";
import type { ToolDefinition, ToolId } from "../../core/src/run-kernel/types.ts";
import type { ToolExecutor, ToolBinding } from "../../core/src/tool-execution.ts";
import { resolveProviderCapabilities } from "../../core/src/types.ts";
import {
  assertDistinctConnectionVariables,
  resolveConnection,
} from "./credentials.ts";
import type { ConnectionResolution } from "./credentials.ts";
import { openNodeProjectFolder } from "./project-folder.ts";
import { describeStartBlocker } from "./start-blockers.ts";
import {
  createHeadlessSummary,
  exitCodeForVerdict,
  EXIT_INCOMPLETE,
  EXIT_SETUP,
} from "./summary.ts";
import type { HeadlessSummaryV1 } from "./summary.ts";
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

export interface HeadlessEvaluationOptions {
  projectDirectory: string;
  /** A suite ID or its exact name. May be omitted when the project has one suite. */
  suite?: string;
  /** `--case`: case IDs or exact names. Every case when omitted. */
  cases?: readonly string[];
  /** `--configuration`: configuration IDs or exact names. Every configuration when omitted. */
  configurations?: readonly string[];
  /** Requirement IDs declared as needing no credential. */
  noAuth?: ReadonlySet<string>;
  environment: Readonly<Record<string, string | undefined>>;
  transport: ProviderTurnTransport;
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

/**
 * `--concurrency` and `--connection-concurrency`. `limit` caps the whole run
 * and is also every connection's limit unless `connections` lowers it.
 */
export interface HeadlessConcurrency {
  limit?: number;
  /** By connection requirement ID. Each may only lower `limit`. */
  connections?: ReadonlyMap<string, number>;
}

export interface HeadlessEvaluationOutcome {
  exitCode: number;
  summary?: HeadlessSummaryV1;
  /** Why the run did not start or did not finish, when it did not. */
  error?: string;
}

export interface HeadlessEvaluationRun {
  readonly done: Promise<HeadlessEvaluationOutcome>;
  /** Stops the active request and every later repetition. */
  cancel(): void;
}

export function selectSuite(project: ProjectFile, requested: string | undefined): EvaluationSuite {
  const suites = project.evaluationSuites;
  if (requested === undefined) {
    if (suites.length === 1) return suites[0];
    if (suites.length === 0) throw new HeadlessSetupError("This project has no evaluation suites.");
    throw new HeadlessSetupError(
      `This project has ${suites.length} evaluation suites; choose one with --suite: ${suites.map(({ id, name }) => `${id} ("${name}")`).join(", ")}.`,
    );
  }
  const byId = suites.find(({ id }) => id === requested);
  if (byId) return byId;
  const byName = suites.filter(({ name }) => name === requested);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new HeadlessSetupError(`${byName.length} suites are named "${requested}"; pass one of their IDs instead: ${byName.map(({ id }) => id).join(", ")}.`);
  }
  throw new HeadlessSetupError(
    `No evaluation suite has the ID or name "${requested}". Available: ${suites.map(({ id, name }) => `${id} ("${name}")`).join(", ") || "none"}.`,
  );
}

/**
 * Resolves `--case` or `--configuration` the way `--suite` resolves: an ID
 * wins, then a unique exact name. Returns IDs in the suite's order, so the
 * plan reads the same whatever order the flags came in.
 */
export function selectSuiteItems<Id extends string>(
  suite: EvaluationSuite,
  items: ReadonlyArray<{ id: Id; name: string }>,
  requested: readonly string[] | undefined,
  noun: "case" | "configuration",
): Id[] {
  if (requested === undefined || requested.length === 0) return items.map(({ id }) => id);
  const flag = `--${noun}`;
  const describe = ({ id, name }: { id: Id; name: string }) => `${id} ("${name}")`;
  const selected = new Set<Id>();
  for (const value of requested) {
    let item = items.find(({ id }) => id === value);
    if (!item) {
      const byName = items.filter(({ name }) => name === value);
      if (byName.length > 1) {
        throw new HeadlessSetupError(
          `${byName.length} ${noun}s are named "${value}"; pass one of their IDs instead: ${byName.map(({ id }) => id).join(", ")}.`,
        );
      }
      item = byName[0];
    }
    if (!item) {
      throw new HeadlessSetupError(
        `No ${noun} in suite "${suite.name}" has the ID or name "${value}". Available: ${items.map(describe).join(", ") || "none"}.`,
      );
    }
    if (selected.has(item.id)) throw new HeadlessSetupError(`${flag} selects ${describe(item)} more than once.`);
    selected.add(item.id);
  }
  return items.filter(({ id }) => selected.has(id)).map(({ id }) => id);
}

/**
 * A grant from `--allow-tool` outranks an enabled project mock, as a grant
 * does in the app. A tool with neither is refused before anything is sent.
 */
function headlessBindingForTool(project: ProjectFile, grants: ReadonlyMap<ToolId, ToolBinding>) {
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

export function startHeadlessEvaluation(options: HeadlessEvaluationOptions): HeadlessEvaluationRun {
  let controller: ExperimentController | undefined;
  let cancelled = false;
  const done = runHeadlessEvaluation(options, (created) => {
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

async function runHeadlessEvaluation(
  options: HeadlessEvaluationOptions,
  onController: (controller: ExperimentController) => void,
): Promise<HeadlessEvaluationOutcome> {
  let prepared: Awaited<ReturnType<typeof prepareHeadlessEvaluation>>;
  try {
    prepared = await prepareHeadlessEvaluation(options);
  } catch (error) {
    return { exitCode: EXIT_SETUP, error: error instanceof Error ? error.message : String(error) };
  }
  const { folder, plan, scope, toolBindings, credentials, concurrency } = prepared;

  let planSaved = false;
  let result: ExperimentResult | undefined;
  let resultSaved = false;
  let states: ReadonlyMap<RunId, RunState> = new Map();
  const tracePaths = new Map<string, string>();
  const variantNames = new Map(plan.suite.variants.map(({ variantId, name }) => [variantId, name]));
  const caseNames = new Map(plan.suite.cases.map(({ caseId, name }) => [caseId, name]));
  let finished = 0;
  /** When each paused connection resumes, as last announced, by profile and endpoint. */
  const announcedPauses = new Map<string, number>();

  const controller = new ExperimentController({
    plan,
    transport: options.transport,
    async prepareCredential(target): Promise<CredentialSelection> {
      const resolution = credentials.get(target.profileId);
      if (!resolution || resolution.endpoint !== target.endpoint) {
        throw new HeadlessSetupError(`No credential was resolved for ${target.profileId} at ${target.endpoint}.`);
      }
      return resolution.credential;
    },
    toolBindings,
    createExecutor: options.createExecutor ?? createHeadlessToolExecutor(options.environment),
    verifyToolBindings: (bindings) => verifyHeadlessToolBindings(
      bindings,
      (toolId) => plan.suite.tools.find(({ id }) => id === toolId)?.name ?? toolId,
      options.environment,
    ),
    concurrency,
    ...(options.retryRateLimits ? { retryPolicy: rateLimitRetries() } : {}),
    async savePlan(frozen, serialized) {
      await folder.saveExperimentArtifact(experimentPlanFileName(frozen.experimentId), serialized);
      planSaved = true;
    },
    async saveResult(saved, serialized) {
      await folder.saveExperimentArtifact(experimentResultFileName(saved.experimentId), serialized);
      resultSaved = true;
    },
    onProgress(progress) {
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
    async onTerminalTrace(trace, cell) {
      await folder.saveTrace(trace.runId, serializeRunTrace(trace));
      tracePaths.set(trace.runId, folder.tracePath(trace.runId));
      finished += 1;
      const variant = "variantId" in cell ? variantNames.get(cell.variantId) : undefined;
      const caseName = "caseId" in cell ? caseNames.get(cell.caseId) : undefined;
      const repetition = "repetition" in cell ? ` #${cell.repetition}` : "";
      const status = trace.status.kind;
      options.onProgress?.(
        `[${finished}/${plan.cells.length}] ${variant ?? "configuration"} · ${caseName ?? "case"}${repetition}: ${status}`,
      );
    },
  });
  onController(controller);

  let error: string | undefined;
  try {
    result = await controller.run();
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    // Refused before the plan was written: nothing was sent, nothing was saved.
    if (!planSaved) return { exitCode: EXIT_SETUP, error };
  }

  const assessment = evaluationParsedExperimentAggregate(plan, resultSaved ? result : undefined, states);
  const summary = createHeadlessSummary({
    plan,
    scope,
    ...(resultSaved && result ? { result } : {}),
    assessment,
    projectDirectory: folder.directory,
    planPath: folder.planPath(plan.experimentId),
    ...(resultSaved ? { resultPath: folder.resultPath(plan.experimentId) } : {}),
    tracePaths,
  });
  const exitCode = error ? EXIT_INCOMPLETE : exitCodeForVerdict(summary.verdict);
  return { exitCode, summary, ...(error ? { error } : {}) };
}

async function prepareHeadlessEvaluation(options: HeadlessEvaluationOptions) {
  const folder = await openNodeProjectFolder(options.projectDirectory);
  const { project } = folder;
  const suite = selectSuite(project, options.suite);
  const revisionId = suite.input.conversationRevisionId;
  const selectedCaseIds = selectSuiteItems(suite, suite.cases, options.cases, "case");
  const selectedVariantIds = selectSuiteItems(suite, suite.variants, options.configurations, "configuration");

  const unknownNoAuth = [...(options.noAuth ?? [])].filter(
    (id) => !project.connectionRequirements.some((requirement) => requirement.id === id),
  );
  if (unknownNoAuth.length > 0) {
    throw new HeadlessSetupError(`--no-auth names ${unknownNoAuth.join(", ")}, which this project does not declare.`);
  }
  const limit = options.concurrency?.limit ?? 1;
  const connectionLimits = options.concurrency?.connections ?? new Map<string, number>();
  const unknownConcurrency = [...connectionLimits.keys()].filter(
    (id) => !project.connectionRequirements.some((requirement) => requirement.id === id),
  );
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

  // Only the connections the selected configurations will call need a key.
  // Resolving others would refuse a run over a credential it never uses.
  const usedRequirementIds = new Set(
    suite.variants
      .filter(({ id }) => selectedVariantIds.includes(id))
      .map((variant) => resolveEvaluationVariant(suite, variant).target.connectionRequirementId),
  );
  const usedRequirements = project.connectionRequirements.filter(({ id }) => usedRequirementIds.has(id));
  assertDistinctConnectionVariables(usedRequirements);
  const resolutions = usedRequirements.map((requirement) =>
    resolveConnection(requirement, options.environment, options.noAuth ?? new Set()));

  // With no device profile, a connection's capabilities are what the project
  // declares it needs — the same snapshot the app takes when it creates one.
  const profiles: EvaluationLocalProfile[] = resolutions.map((resolution) => {
    const requirement = usedRequirements.find(({ id }) => id === resolution.requirementId)!;
    return {
      id: requirement.id,
      name: requirement.name,
      endpoint: resolution.endpoint,
      capabilities: resolveProviderCapabilities(requirement.provider, requirement.capabilityOverrides),
    };
  });
  const mappedProfileIds = Object.fromEntries(profiles.map(({ id }) => [id, id]));

  const exposed = project.tools.filter(({ id }) => suite.execution.toolIds.includes(id));
  const bindingForTool = headlessBindingForTool(
    project,
    resolveToolGrants(project, exposed, options.toolGrants ?? [], options.environment),
  );
  const blocker = evaluationStartBlocker({
    diagnostics: evaluationSuitePreflight(project, suite.id, revisionId, selectedCaseIds),
    selectedCaseCount: selectedCaseIds.length,
    selectedVariantCount: selectedVariantIds.length,
    repetitions: suite.execution.repetitions,
    toolBindings: exposed.map((tool) => ({ name: tool.name, bound: Boolean(bindingForTool(tool)) })),
    ...(suite.execution.turnCeiling === undefined ? {} : { turnCeiling: suite.execution.turnCeiling }),
    targets: resolveEvaluationLocalTargets({ project, suiteId: suite.id, selectedVariantIds, profiles, mappedProfileIds }),
  });
  if (blocker) throw new HeadlessSetupError(describeStartBlocker(blocker));

  const draft = createEvaluationStartPlan({
    project,
    suiteId: suite.id,
    selectedCaseIds,
    selectedVariantIds,
    profiles,
    mappedProfileIds,
    bindingForTool,
  });
  const plan: EvaluationExperimentPlanV4 = draft.plan;
  const credentials = new Map<string, ConnectionResolution>(
    resolutions.map((resolution) => [createEntityId("profile", resolution.requirementId), resolution]),
  );
  const concurrency: ExperimentConcurrencySetting = {
    maxInFlight: limit,
    connectionLimit: limit,
    connections: resolutions.flatMap(({ requirementId, endpoint }) => {
      const connectionLimit = connectionLimits.get(requirementId);
      return connectionLimit === undefined
        ? []
        : [{ profileId: createEntityId("profile", requirementId), endpoint, limit: connectionLimit }];
    }),
  };
  return {
    folder,
    plan,
    scope: {
      cases: { selected: selectedCaseIds.length, total: suite.cases.length },
      configurations: { selected: selectedVariantIds.length, total: suite.variants.length },
    },
    toolBindings: draft.toolBindings.flatMap(({ binding }) => binding ? [binding] : []),
    credentials,
    concurrency,
  };
}
