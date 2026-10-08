"use client";

import { useState } from "react";

import type { EvaluationHistoryItem } from "../../packages/core/src/experiment-history.ts";
import type { ProjectFile } from "../../packages/core/src/project.ts";
import type { ToolDefinition } from "../../packages/core/src/run-kernel/types.ts";
import type { ToolBinding } from "../../packages/core/src/tool-execution.ts";
import { resolveProviderCapabilities } from "../../packages/core/src/types.ts";
import type { EvaluationsLayoutHandle } from "../modes/evaluations-mode.client";
import type { StoredInferenceProfile } from "../profile-store.client.ts";
import type { ProjectWorkspaceHandle } from "../project-workspace.client.ts";
import { listExperimentToolBindings } from "../run/experiment-tool-bindings.client.ts";
import type { ProjectRunHistoryState } from "../use-project-run-history.client.ts";
import {
  createEvaluationStartDraft,
  evaluationWorkspaceExecution,
} from "./evaluation-start.client.ts";
import type { EvaluationSuiteExecutionActions } from "./evaluation-suite-editor.client";
import type { EvaluationSuiteHistoryHandle } from "./evaluation-suite-history.client";
import type { EvaluationBaselinesSession } from "./use-evaluation-baselines.client.ts";
import type { EvaluationExecutionDraft } from "./use-evaluation-execution-session.client.ts";
import type { EvaluationSuiteAuthoringHandle } from "./use-evaluation-suite-authoring.client.ts";

export interface UseEvaluationWorkspaceOptions {
  authoring: Pick<
    EvaluationSuiteAuthoringHandle,
    "suiteId" | "revisionId" | "diagnostics" | "selectedCaseIds" | "selectedVariantIds"
  >;
  project: ProjectFile | null;
  workspace: ProjectWorkspaceHandle | null;
  profiles: readonly StoredInferenceProfile[];
  mappedProfileIds: Readonly<Record<string, string>>;
  /** The device's one answer to what serves a tool, shared with every run surface. */
  bindingForTool(tool: ToolDefinition): ToolBinding | undefined;
  commandToolsUnavailableReason?: string;
  /** Whether a request or another batch is in progress. */
  activityInProgress: boolean;
  /** Whether an evaluation is executing; reported to the editor, not owned here. */
  running: boolean;
  /** Hands a prepared draft to evaluation execution, which owns confirmation. */
  onBegin(draft: EvaluationExecutionDraft): void;
  onError(message: string): void;
  clearError(): void;
  runHistory: Pick<ProjectRunHistoryState, "status" | "experiments" | "error" | "refresh">;
  baselines: EvaluationBaselinesSession;
  /**
   * Reports that the past-executions list was opened. The listing is shared
   * with the run-history drawer and Runs, so whether it loads is decided by
   * the route that joins all three.
   */
  onHistoryRequested(): void;
  onOpenExecution(item: EvaluationHistoryItem): Promise<void>;
  /** A baseline comparison loaded; the route moves it into Runs. */
  onComparisonOpened(): void;
}

export interface EvaluationWorkspace {
  layout: EvaluationsLayoutHandle;
  /** One object for two panes, so preflight and provider input report the same target. */
  execution: EvaluationSuiteExecutionActions;
  /** Absent without a project folder: there is nowhere executions were saved. */
  history?: EvaluationSuiteHistoryHandle;
  /** Read by the topbar button and the run shortcut; `start()` applies the same gate. */
  startDisabledReason?: string;
  start(): void;
}

/**
 * Owns the Evaluations mode's workspace: which regions are open, how the suite
 * being authored joins this device's profiles and tools, and starting it.
 *
 * Called by the route rather than the mode, because the mode unmounts whenever
 * another one is on screen and the open regions have to survive that.
 */
export function useEvaluationWorkspace(options: UseEvaluationWorkspaceOptions): EvaluationWorkspace {
  const { authoring, project, workspace } = options;
  const [setupOpen, setSetupOpen] = useState(true);
  const [previewPreference, setPreviewPreference] =
    useState<"auto" | "open" | "closed">("auto");
  // The listing stays cached once requested, but the disclosure can be closed
  // again, so whether it is open is separate from whether it was ever opened.
  const [historyExpanded, setHistoryExpanded] = useState(false);

  const suite = project?.evaluationSuites.find(({ id }) => id === authoring.suiteId);
  const profiles = options.profiles.map((profile) => ({
    id: profile.id,
    name: profile.name,
    endpoint: profile.endpoint,
    capabilities: resolveProviderCapabilities(profile.provider, profile.capabilityOverrides),
  }));
  // Every project tool is resolved, not only the exposed ones, so the editor
  // can say what a tool would be served by before it is checked.
  const toolBindings = listExperimentToolBindings(project?.tools ?? [], options.bindingForTool);
  const resolved = evaluationWorkspaceExecution({
    project,
    ...(authoring.suiteId ? { suiteId: authoring.suiteId } : {}),
    ...(authoring.revisionId ? { revisionId: authoring.revisionId } : {}),
    diagnostics: authoring.diagnostics,
    selectedCaseCount: authoring.selectedCaseIds.size,
    selectedVariantIds: [...authoring.selectedVariantIds],
    profiles,
    mappedProfileIds: options.mappedProfileIds,
    toolBindings,
    ...(options.commandToolsUnavailableReason
      ? { commandToolsUnavailableReason: options.commandToolsUnavailableReason }
      : {}),
    activityInProgress: options.activityInProgress,
  });

  function start(): void {
    options.clearError();
    if (resolved.disabledReason) {
      options.onError(resolved.disabledReason);
      return;
    }
    if (!project || !suite || !authoring.revisionId) return;
    try {
      options.onBegin(createEvaluationStartDraft({
        project,
        suiteId: suite.id,
        selectedCaseIds: [...authoring.selectedCaseIds],
        selectedVariantIds: [...authoring.selectedVariantIds],
        profiles,
        mappedProfileIds: options.mappedProfileIds,
        durable: Boolean(workspace),
        bindingForTool: options.bindingForTool,
      }));
    } catch (error) {
      options.onError(error instanceof Error ? error.message : "Could not prepare the evaluation.");
    }
  }

  const execution: EvaluationSuiteExecutionActions = {
    storage: workspace ? "durable" : "unsaved",
    running: options.running,
    preview: { targets: resolved.previewTargets },
    ...(resolved.disabledReason ? { disabledReason: resolved.disabledReason } : {}),
    onStart: start,
    toolBindings,
    ...(options.commandToolsUnavailableReason
      ? { commandToolsUnavailableReason: options.commandToolsUnavailableReason }
      : {}),
  };

  // Executions are matched by suite identity across every input revision — a
  // run against an older revision is still this suite's evidence, and the
  // editor marks it as drifted rather than hiding it.
  const { runHistory, baselines } = options;
  const history: EvaluationSuiteHistoryHandle | undefined = workspace
    ? {
        status: runHistory.status,
        executions: runHistory.experiments.filter(
          (item): item is Extract<typeof item, { kind: "evaluation" }> =>
            item.kind === "evaluation" && item.evaluation.suiteId === suite?.id,
        ),
        ...(runHistory.error ? { error: runHistory.error } : {}),
        ...(authoring.revisionId ? { currentRevisionId: authoring.revisionId } : {}),
        expanded: historyExpanded,
        onExpandedChange: setHistoryExpanded,
        onExpand: () => {
          options.onHistoryRequested();
          baselines.load();
        },
        onRefresh: () => void runHistory.refresh(),
        onOpen: (item) => options.onOpenExecution(item),
        baselines: {
          items: baselines.forSuite(suite?.id),
          ...(baselines.error ? { error: baselines.error } : {}),
          busy: baselines.comparing,
          onPin: (item, variantId, name) => baselines.pin(item, variantId, name),
          onUnpin: (baselineId) => baselines.unpin(baselineId),
          onCompare: async (baseline, candidate, candidateVariantId) => {
            await baselines.compare(baseline, candidate, candidateVariantId);
            options.onComparisonOpened();
          },
        },
      }
    : undefined;

  return {
    layout: {
      setupOpen,
      onSetupOpenChange: setSetupOpen,
      previewPreference,
      onPreviewPreferenceChange: setPreviewPreference,
    },
    execution,
    ...(history ? { history } : {}),
    ...(resolved.disabledReason ? { startDisabledReason: resolved.disabledReason } : {}),
    start,
  };
}
