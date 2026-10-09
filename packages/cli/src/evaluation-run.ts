import type { CredentialSelection, ProviderTurnTransport } from "../../contracts/src/index.ts";
import {
  createEvaluationStartDraft,
  evaluationWorkspaceExecution,
} from "../../../app/evaluations/evaluation-start.client.ts";
import type { EvaluationLocalProfile } from "../../../app/evaluations/evaluation-start.client.ts";
import { SequentialExperimentController } from "../../../app/run/sequential-experiment-controller.client.ts";
import { toolBindingForMock } from "../../../app/run/run-session-state.client.ts";
import { evaluationSuitePreflight, resolveEvaluationVariant } from "../../core/src/evaluation-suites.ts";
import {
  evaluationParsedExperimentAggregate,
  experimentPlanFileName,
  experimentResultFileName,
} from "../../core/src/experiment.ts";
import type { EvaluationExperimentPlanV4, ExperimentResult } from "../../core/src/experiment.ts";
import type { EvaluationSuite, ProjectFile } from "../../core/src/project.ts";
import { serializeRunTrace } from "../../core/src/run-trace.ts";
import type { RunId, RunState } from "../../core/src/run-kernel/index.ts";
import { createEntityId } from "../../core/src/run-kernel/types.ts";
import type { ToolDefinition } from "../../core/src/run-kernel/types.ts";
import type { ToolExecutor, ToolBinding } from "../../core/src/tool-execution.ts";
import { resolveProviderCapabilities } from "../../core/src/types.ts";
import {
  assertDistinctConnectionVariables,
  resolveConnection,
} from "./credentials.ts";
import type { ConnectionResolution } from "./credentials.ts";
import { openNodeProjectFolder } from "./project-folder.ts";
import {
  createHeadlessSummary,
  exitCodeForVerdict,
  EXIT_INCOMPLETE,
  EXIT_SETUP,
} from "./summary.ts";
import type { HeadlessSummaryV1 } from "./summary.ts";

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
  /** Requirement IDs declared as needing no credential. */
  noAuth?: ReadonlySet<string>;
  environment: Readonly<Record<string, string | undefined>>;
  transport: ProviderTurnTransport;
  /** One line per finished repetition, for stderr. */
  onProgress?(line: string): void;
  /** Injected by tests. */
  createExecutor?(binding: ToolBinding): ToolExecutor;
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
 * Mocks only, for now. Command and MCP tools need explicit per-run grants,
 * which arrive with `--allow-tool`; until then a suite exposing one is refused
 * before anything is sent, naming the tool.
 */
function headlessBindingForTool(project: ProjectFile) {
  return (tool: ToolDefinition): ToolBinding | undefined =>
    toolBindingForMock(tool.id, project.toolMocks.find(({ toolId }) => toolId === tool.id));
}

export function startHeadlessEvaluation(options: HeadlessEvaluationOptions): HeadlessEvaluationRun {
  let controller: SequentialExperimentController | undefined;
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
  onController: (controller: SequentialExperimentController) => void,
): Promise<HeadlessEvaluationOutcome> {
  let prepared: Awaited<ReturnType<typeof prepareHeadlessEvaluation>>;
  try {
    prepared = await prepareHeadlessEvaluation(options);
  } catch (error) {
    return { exitCode: EXIT_SETUP, error: error instanceof Error ? error.message : String(error) };
  }
  const { folder, plan, toolBindings, credentials } = prepared;

  let planSaved = false;
  let result: ExperimentResult | undefined;
  let resultSaved = false;
  let states: ReadonlyMap<RunId, RunState> = new Map();
  const tracePaths = new Map<string, string>();
  const variantNames = new Map(plan.suite.variants.map(({ variantId, name }) => [variantId, name]));
  const caseNames = new Map(plan.suite.cases.map(({ caseId, name }) => [caseId, name]));
  let finished = 0;

  const controller = new SequentialExperimentController({
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
    ...(options.createExecutor ? { createExecutor: options.createExecutor } : {}),
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
  const selectedCaseIds = suite.cases.map(({ id }) => id);
  const selectedVariantIds = suite.variants.map(({ id }) => id);

  const unknownNoAuth = [...(options.noAuth ?? [])].filter(
    (id) => !project.connectionRequirements.some((requirement) => requirement.id === id),
  );
  if (unknownNoAuth.length > 0) {
    throw new HeadlessSetupError(`--no-auth names ${unknownNoAuth.join(", ")}, which this project does not declare.`);
  }

  // Only the connections this suite will call need a key. Resolving others
  // would refuse a run over a credential it never uses.
  const usedRequirementIds = new Set(
    suite.variants.map((variant) => resolveEvaluationVariant(suite, variant).target.connectionRequirementId),
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

  const bindingForTool = headlessBindingForTool(project);
  const exposed = project.tools.filter(({ id }) => suite.execution.toolIds.includes(id));
  const unserved = exposed.filter((tool) => !bindingForTool(tool));
  if (unserved.length > 0) {
    throw new HeadlessSetupError(
      `This suite exposes ${unserved.map(({ name }) => name).join(", ")}, and headless runs can serve only enabled project mocks so far. ` +
        `Enable a mock for ${unserved.length === 1 ? "that tool" : "those tools"} in the app, or remove ${unserved.length === 1 ? "it" : "them"} from the suite.`,
    );
  }

  const gate = evaluationWorkspaceExecution({
    project,
    suiteId: suite.id,
    revisionId,
    diagnostics: evaluationSuitePreflight(project, suite.id, revisionId, selectedCaseIds),
    selectedCaseCount: selectedCaseIds.length,
    selectedVariantIds,
    profiles,
    mappedProfileIds,
    toolBindings: exposed.map((tool) => {
      const binding = bindingForTool(tool);
      return { tool, ...(binding ? { binding } : {}) };
    }),
    activityInProgress: false,
  });
  if (gate.disabledReason) throw new HeadlessSetupError(gate.disabledReason);

  const draft = createEvaluationStartDraft({
    project,
    suiteId: suite.id,
    selectedCaseIds,
    selectedVariantIds,
    profiles,
    mappedProfileIds,
    durable: true,
    bindingForTool,
  });
  const plan: EvaluationExperimentPlanV4 = draft.plan;
  const credentials = new Map<string, ConnectionResolution>(
    resolutions.map((resolution) => [createEntityId("profile", resolution.requirementId), resolution]),
  );
  return {
    folder,
    plan,
    toolBindings: draft.toolBindings.flatMap(({ binding }) => binding ? [binding] : []),
    credentials,
  };
}
