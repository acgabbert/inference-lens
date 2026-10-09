import { DEFAULT_EXPERIMENT_TURN_CEILING, repeatedExperimentAggregate } from "../../core/src/experiment.ts";
import { listExperimentToolBindings } from "../../core/src/tool-binding-resolution.ts";
import {
  createRepeatedExperimentPlan,
  DEFAULT_REPETITION_COUNT,
  resolveProjectDefaultsRun,
} from "../../runner/src/repeated-start.ts";
import {
  driveHeadlessExperiment,
  headlessBindingForTool,
  HeadlessSetupError,
  resolveHeadlessConnections,
  startCancellable,
} from "./headless-experiment.ts";
import type { HeadlessRun, HeadlessRunOptions } from "./headless-experiment.ts";
import { openNodeProjectFolder } from "./project-folder.ts";
import { describeRepeatedStartBlocker } from "./start-blockers.ts";
import {
  createHeadlessRepeatedSummary,
  exitCodeForRepeatedOutcome,
  EXIT_INCOMPLETE,
  EXIT_SETUP,
} from "./summary.ts";
import type { HeadlessRepeatedSummaryV1 } from "./summary.ts";

export interface HeadlessRepeatOptions extends HeadlessRunOptions {
  /** `--repetitions`, already checked against the runner's bounds. Five when omitted. */
  repetitions?: number;
  /** `--response-mode`. Buffered when omitted: a headless job seldom has anyone watching output arrive. */
  responseMode?: "streaming" | "buffered";
}

export interface HeadlessRepeatOutcome {
  exitCode: number;
  summary?: HeadlessRepeatedSummaryV1;
  /** Why the run did not start or did not finish, when it did not. */
  error?: string;
}

/** Repeats the run the project's saved defaults describe. Never writes `project.json`. */
export function startHeadlessRepeat(options: HeadlessRepeatOptions): HeadlessRun<HeadlessRepeatOutcome> {
  return startCancellable((onController) => runHeadlessRepeat(options, onController));
}

async function runHeadlessRepeat(
  options: HeadlessRepeatOptions,
  onController: Parameters<Parameters<typeof startCancellable>[0]>[0],
): Promise<HeadlessRepeatOutcome> {
  let prepared: Awaited<ReturnType<typeof prepareHeadlessRepeat>>;
  try {
    prepared = await prepareHeadlessRepeat(options);
  } catch (error) {
    return { exitCode: EXIT_SETUP, error: error instanceof Error ? error.message : String(error) };
  }
  const { folder, plan, connectionRequirementId } = prepared;

  const record = await driveHeadlessExperiment({
    folder,
    plan,
    toolBindings: prepared.toolBindings,
    tools: plan.commonInput.tools,
    connections: prepared.connections,
    concurrency: prepared.concurrency,
    options,
    describeCell: (cell) => `Repetition #${cell.ordinal}`,
    onController,
  });
  // Refused before the plan was written: nothing was sent, nothing was saved.
  if (record.error !== undefined && !record.planSaved) return { exitCode: EXIT_SETUP, error: record.error };

  const summary = createHeadlessRepeatedSummary({
    plan,
    ...(record.result ? { result: record.result } : {}),
    aggregate: repeatedExperimentAggregate(plan, record.result, record.states),
    states: record.states,
    connectionRequirementId,
    projectDirectory: folder.directory,
    planPath: folder.planPath(plan.experimentId),
    ...(record.result ? { resultPath: folder.resultPath(plan.experimentId) } : {}),
    tracePaths: record.tracePaths,
  });
  const exitCode = record.error !== undefined ? EXIT_INCOMPLETE : exitCodeForRepeatedOutcome(summary.outcome);
  return { exitCode, summary, ...(record.error !== undefined ? { error: record.error } : {}) };
}

async function prepareHeadlessRepeat(options: HeadlessRepeatOptions) {
  const folder = await openNodeProjectFolder(options.projectDirectory);
  const { project } = folder;
  const connectionRequirementId = project.defaults.target.connectionRequirementId;
  const { connections, concurrency } = resolveHeadlessConnections(project, new Set([connectionRequirementId]), options);
  const [connection] = connections;
  if (!connection) throw new HeadlessSetupError(`The project's default connection ${connectionRequirementId} is not declared.`);

  const enabled = project.tools.filter(({ id }) => project.defaults.enabledToolIds.includes(id));
  const bindingForTool = headlessBindingForTool(project, enabled, options);
  const resolved = resolveProjectDefaultsRun({
    project,
    connection: {
      requirementId: connection.requirement.id,
      requirementName: connection.requirement.name,
      endpoint: connection.resolution.endpoint,
      capabilities: connection.capabilities,
    },
    responseMode: options.responseMode ?? "buffered",
    bindingForTool,
  });
  if (!resolved.ok) throw new HeadlessSetupError(describeRepeatedStartBlocker(resolved.blocker));

  const plan = createRepeatedExperimentPlan(
    resolved.input,
    options.repetitions ?? DEFAULT_REPETITION_COUNT,
    DEFAULT_EXPERIMENT_TURN_CEILING,
  );
  return {
    folder,
    plan,
    connectionRequirementId,
    toolBindings: listExperimentToolBindings(plan.commonInput.tools, bindingForTool)
      .flatMap(({ binding }) => binding ? [binding] : []),
    connections,
    concurrency,
  };
}
