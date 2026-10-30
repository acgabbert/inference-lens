import {
  createDecisionEvaluationStartPlan,
  createEvaluationStartPlan,
  decisionEvaluationStartBlocker,
  evaluationStartBlocker,
  resolveDecisionEvaluationLocalTargets,
  resolveEvaluationLocalTargets,
} from "../../runner/src/evaluation-start.ts";
import type { EvaluationLocalProfile } from "../../runner/src/evaluation-start.ts";
import {
  evaluationSuitePreflight,
  isChatEvaluationSuite,
  resolveDecisionEvaluationVariant,
  resolveEvaluationVariant,
} from "../../core/src/evaluation-suites.ts";
import type { ChatEvaluationSuite, DecisionEvaluationSuite } from "../../core/src/evaluation-suites.ts";
import { evaluationParsedExperimentAggregate } from "../../core/src/experiment.ts";
import type { EvaluationBakeoffAssessment, EvaluationVariantSnapshot, PromptFileSnapshot } from "../../core/src/experiment.ts";
import { projectWithPromptFileSnapshots } from "../../core/src/prompt-file-override.ts";
import type { EvaluationSuite, ProjectFile } from "../../core/src/project.ts";
import type { DecisionRun } from "../../core/src/decision.ts";
import type { RunId, RunState } from "../../core/src/run-kernel/index.ts";
import {
  driveHeadlessExperiment,
  headlessBindingForTool,
  HeadlessSetupError,
  resolveHeadlessConnections,
  startCancellable,
} from "./headless-experiment.ts";
import type { HeadlessConnection, HeadlessRun, HeadlessRunOptions } from "./headless-experiment.ts";
import { openNodeProjectFolder } from "./project-folder.ts";
import { namePromptFileDiagnostics, promptSourceSummaries, readPromptFileSnapshots } from "./prompt-sources.ts";
import { describeDecisionStartBlocker, describeStartBlocker } from "./start-blockers.ts";
import {
  createHeadlessSummary,
  exitCodeForVerdict,
  EXIT_INCOMPLETE,
  EXIT_SETUP,
} from "./summary.ts";
import type { HeadlessSummaryV1 } from "./summary.ts";

export { HeadlessSetupError } from "./headless-experiment.ts";
export type { HeadlessConcurrency } from "./headless-experiment.ts";

export interface HeadlessEvaluationOptions extends HeadlessRunOptions {
  /** A suite ID or its exact name. May be omitted when the project has one suite. */
  suite?: string;
  /** `--case`: case IDs or exact names. Every case when omitted. */
  cases?: readonly string[];
  /** `--configuration`: configuration IDs or exact names. Every configuration when omitted. */
  configurations?: readonly string[];
  /**
   * `--prompts-from-files`: run every linked prompt the suite uses from its
   * file's text, for this run only (E4). Off when omitted.
   */
  promptsFromFiles?: boolean;
  /** `--source-root <name>=<path>`: folders for the project's source roots, over the catalog's. */
  sourceRoots?: ReadonlyMap<string, string>;
}

export interface HeadlessEvaluationOutcome {
  exitCode: number;
  summary?: HeadlessSummaryV1;
  /** Why the run did not start or did not finish, when it did not. */
  error?: string;
}

export type HeadlessEvaluationRun = HeadlessRun<HeadlessEvaluationOutcome>;

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

export function startHeadlessEvaluation(options: HeadlessEvaluationOptions): HeadlessEvaluationRun {
  return startCancellable((onController) => runHeadlessEvaluation(options, onController));
}

async function runHeadlessEvaluation(
  options: HeadlessEvaluationOptions,
  onController: Parameters<Parameters<typeof startCancellable>[0]>[0],
): Promise<HeadlessEvaluationOutcome> {
  let prepared: Awaited<ReturnType<typeof prepareHeadlessEvaluation>>;
  try {
    prepared = await prepareHeadlessEvaluation(options);
  } catch (error) {
    return { exitCode: EXIT_SETUP, error: error instanceof Error ? error.message : String(error) };
  }
  const { folder, scope, work } = prepared;
  const { plan } = work;
  const variantNames = new Map(plan.suite.variants.map(({ variantId, name }) => [variantId as string, name]));
  const caseNames = new Map(plan.suite.cases.map(({ caseId, name }) => [caseId as string, name]));

  const record = await driveHeadlessExperiment({
    ...work,
    folder,
    connections: prepared.connections,
    concurrency: prepared.concurrency,
    options,
    describeCell(cell) {
      const variant = "variantId" in cell ? variantNames.get(cell.variantId) : undefined;
      const caseName = "caseId" in cell ? caseNames.get(cell.caseId) : undefined;
      const repetition = "repetition" in cell ? ` #${cell.repetition}` : "";
      return `${variant ?? "configuration"} · ${caseName ?? "case"}${repetition}`;
    },
    onController,
  });
  // Refused before the plan was written: nothing was sent, nothing was saved.
  if (record.error !== undefined && !record.planSaved) return { exitCode: EXIT_SETUP, error: record.error };

  const assessment: EvaluationBakeoffAssessment<EvaluationVariantSnapshot> = plan.kind === "decision-evaluation"
    ? evaluationParsedExperimentAggregate(plan, record.result, record.states as ReadonlyMap<RunId, DecisionRun>)
    : evaluationParsedExperimentAggregate(plan, record.result, record.states as ReadonlyMap<RunId, RunState>);
  const summary = createHeadlessSummary({
    plan,
    scope,
    ...(record.result ? { result: record.result } : {}),
    assessment,
    projectDirectory: folder.directory,
    planPath: folder.planPath(plan.experimentId),
    ...(record.result ? { resultPath: folder.resultPath(plan.experimentId) } : {}),
    tracePaths: record.tracePaths,
    ...(prepared.promptSources ? { promptSources: promptSourceSummaries(folder.project, prepared.promptSources) } : {}),
  });
  const exitCode = record.error !== undefined ? EXIT_INCOMPLETE : exitCodeForVerdict(summary.verdict);
  return { exitCode, summary, ...(record.error !== undefined ? { error: record.error } : {}) };
}

/** The connections a run will call, as the runner's local profiles, each mapped to itself. */
function localProfiles(connections: readonly HeadlessConnection[], systemOne: boolean) {
  const profiles: EvaluationLocalProfile[] = connections.map(({ requirement, resolution, capabilities }) => ({
    id: requirement.id,
    name: requirement.name,
    endpoint: resolution.endpoint,
    capabilities,
    ...(systemOne ? { systemOne: true } : {}),
  }));
  return { profiles, mappedProfileIds: Object.fromEntries(profiles.map(({ id }) => [id, id])) };
}

async function prepareHeadlessEvaluation(options: HeadlessEvaluationOptions) {
  const folder = await openNodeProjectFolder(options.projectDirectory);
  const { project } = folder;
  const suite = selectSuite(project, options.suite);
  const selectedCaseIds = selectSuiteItems(suite, suite.cases, options.cases, "case");
  const selectedVariantIds = selectSuiteItems(suite, suite.variants, options.configurations, "configuration");
  const scope = {
    cases: { selected: selectedCaseIds.length, total: suite.cases.length },
    configurations: { selected: selectedVariantIds.length, total: suite.variants.length },
  };
  const selection = { selectedCaseIds, selectedVariantIds };
  // `run` dispatches on the suite's kind (D36).
  if (options.promptsFromFiles && !isChatEvaluationSuite(suite)) {
    throw new HeadlessSetupError(`Suite “${suite.name}” runs decisions; --prompts-from-files reads chat prompts only.`);
  }
  const prepared = isChatEvaluationSuite(suite)
    ? await prepareChatEvaluation(project, suite, selection, options)
    : { ...prepareDecisionEvaluation(project, suite, selection, options), promptSources: undefined };
  return { folder, scope, ...prepared };
}

interface SuiteSelection {
  selectedCaseIds: EvaluationSuite["cases"][number]["id"][];
  selectedVariantIds: EvaluationSuite["variants"][number]["id"][];
}

async function prepareChatEvaluation(
  project: ProjectFile,
  suite: ChatEvaluationSuite,
  { selectedCaseIds, selectedVariantIds }: SuiteSelection,
  options: HeadlessEvaluationOptions,
) {
  const revisionId = suite.input.conversationRevisionId;
  // Read before anything else is checked, so a file problem is named first
  // and nothing is sent when one cannot be used.
  const promptSources: PromptFileSnapshot[] | undefined = options.promptsFromFiles
    ? await readPromptFileSnapshots(project, suite, options)
    : undefined;
  // Preflight sees the files' text, exactly as the plan will freeze it.
  const effective = projectWithPromptFileSnapshots(project, promptSources ?? []);

  // Only the connections the selected configurations will call need a key.
  const { connections, concurrency } = resolveHeadlessConnections(
    project,
    new Set(
      suite.variants
        .filter(({ id }) => selectedVariantIds.includes(id))
        .map((variant) => resolveEvaluationVariant(suite, variant).target.connectionRequirementId),
    ),
    options,
  );
  const { profiles, mappedProfileIds } = localProfiles(connections, false);

  const exposed = project.tools.filter(({ id }) => suite.execution.toolIds.includes(id));
  const bindingForTool = headlessBindingForTool(project, exposed, options);
  const blocker = evaluationStartBlocker({
    diagnostics: namePromptFileDiagnostics(
      project,
      suite,
      promptSources ?? [],
      evaluationSuitePreflight(effective, suite.id, revisionId, selectedCaseIds),
    ),
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
    ...(promptSources ? { promptSources } : {}),
  });
  return {
    promptSources,
    work: {
      plan: draft.plan,
      toolBindings: draft.toolBindings.flatMap(({ binding }) => binding ? [binding] : []),
      tools: draft.plan.suite.tools,
    },
    connections,
    concurrency,
  };
}

function prepareDecisionEvaluation(
  project: ProjectFile,
  suite: DecisionEvaluationSuite,
  { selectedCaseIds, selectedVariantIds }: SuiteSelection,
  options: HeadlessEvaluationOptions,
) {
  const { connections, concurrency } = resolveHeadlessConnections(
    project,
    new Set(
      suite.variants
        .filter(({ id }) => selectedVariantIds.includes(id))
        .map((variant) => resolveDecisionEvaluationVariant(suite, variant).connectionRequirementId),
    ),
    options,
  );
  // With no device profile, the suite is the System One declaration (D54):
  // a connection it names is taken to serve decisions, as a chat suite's
  // connection is taken to have the capabilities the project declares.
  const { profiles, mappedProfileIds } = localProfiles(connections, true);
  const blocker = decisionEvaluationStartBlocker({
    // A decision suite's preflight reads its own pinned revision; the
    // conversation revision argument is ignored for it.
    diagnostics: evaluationSuitePreflight(project, suite.id, project.defaults.conversationRevisionId, selectedCaseIds),
    selectedCaseCount: selectedCaseIds.length,
    selectedVariantCount: selectedVariantIds.length,
    repetitions: suite.execution.repetitions,
    targets: resolveDecisionEvaluationLocalTargets({ project, suiteId: suite.id, selectedVariantIds, profiles, mappedProfileIds }),
  });
  if (blocker) throw new HeadlessSetupError(describeDecisionStartBlocker(blocker));

  const { plan } = createDecisionEvaluationStartPlan({
    project,
    suiteId: suite.id,
    selectedCaseIds,
    selectedVariantIds,
    profiles,
    mappedProfileIds,
  });
  return { work: { plan }, connections, concurrency };
}
