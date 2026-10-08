"use client";

import { useEffect, useState } from "react";

import { promoteTraceToEvaluationCase } from "../../packages/core/src/evaluation-case-promotion.ts";
import { upsertEvaluationCaseSource } from "../../packages/core/src/evaluation-case-sources.ts";
import type { EvaluationCaseSource } from "../../packages/core/src/evaluation-case-sources.ts";
import type { ProjectFile } from "../../packages/core/src/project.ts";
import type {
  EvaluationCaseId,
  EvaluationSuiteId,
  ExperimentCellId,
  RunTrace,
} from "../../packages/core/src/run-kernel/types.ts";
import { parseRunTraceJson, traceFileName } from "../../packages/core/src/run-trace.ts";
import type { ToastRequest } from "../notifications/toast-queue.client";
import {
  readEvaluationCaseSourcesWorkspace,
  readRunTraceWorkspace,
  saveEvaluationCaseSourcesWorkspace,
  type ProjectWorkspaceHandle,
} from "../project-workspace.client.ts";

/** A trace waiting in the promote-to-case dialog. */
export interface EvaluationCasePromotion {
  trace: RunTrace;
  experimentCellId?: string;
}

export interface UseEvaluationCaseSourceOptions {
  workspace: ProjectWorkspaceHandle | null;
  project: ProjectFile | null;
  suiteId?: EvaluationSuiteId;
  focusedCaseId?: EvaluationCaseId;
  adoptProjectMutation(project: ProjectFile): void;
  /** Must be stable: the annotation reloads whenever it changes. */
  publishToast(request: ToastRequest): void;
  /** The case now exists in the project; the route navigates to it. */
  onPromoted(suiteId: EvaluationSuiteId, caseId: EvaluationCaseId): void;
  /** A validated source trace; the route decides where it is read. */
  onOpenTrace(trace: RunTrace, origin: { workspace: ProjectWorkspaceHandle; fileName: string }): void;
}

export interface EvaluationCaseSourceHandle {
  /** The focused case's validated source, when the project folder holds one. */
  source?: EvaluationCaseSource;
  openSource(source: EvaluationCaseSource): void;
  promotion?: EvaluationCasePromotion;
  requestPromotion(trace: RunTrace, experimentCellId?: string): void;
  cancelPromotion(): void;
  promote(suiteId: EvaluationSuiteId, name: string): void;
}

/**
 * Owns the link from an evaluation case back to the trace it was promoted
 * from: promoting a trace into a case, saving that link beside the project,
 * and reading it back for the focused case.
 *
 * The link is a device-local annotation, never portable suite content, so
 * every failure here leaves a valid case and only reports the missing link.
 */
export function useEvaluationCaseSource(options: UseEvaluationCaseSourceOptions): EvaluationCaseSourceHandle {
  const { workspace, project, suiteId, focusedCaseId, publishToast } = options;
  const [source, setSource] = useState<EvaluationCaseSource>();
  const [promotion, setPromotion] = useState<EvaluationCasePromotion>();

  useEffect(() => {
    if (!workspace || !suiteId || !focusedCaseId) {
      return;
    }
    let current = true;
    void readEvaluationCaseSourcesWorkspace(workspace)
      .then(async (file) => {
        const found = file.sources.find((item) => item.suiteId === suiteId && item.caseId === focusedCaseId);
        if (!found) return undefined;
        const trace = parseRunTraceJson(await readRunTraceWorkspace(workspace, traceFileName(found.runId)));
        if (trace.runId !== found.runId) throw new Error("The source annotation points to a different trace.");
        return found;
      })
      .then((found) => {
        if (current) setSource(found);
      })
      .catch((error) => {
        if (!current) return;
        setSource(undefined);
        publishToast({
          key: "evaluation-case-source-unreadable",
          title: "Case source link is unavailable",
          detail: error instanceof Error ? error.message : "The local source annotation or its trace could not be read.",
          durableHome: "the portable case, which remains valid without local evidence",
        });
      });
    return () => { current = false; };
  }, [focusedCaseId, suiteId, project, workspace, publishToast]);

  function openSource(target: EvaluationCaseSource): void {
    if (!workspace) return;
    const fileName = traceFileName(target.runId);
    void readRunTraceWorkspace(workspace, fileName)
      .then((contents) => {
        const trace = parseRunTraceJson(contents);
        if (trace.runId !== target.runId) throw new Error("The saved source trace contains a different run.");
        options.onOpenTrace(trace, { workspace, fileName });
      })
      .catch((error) => publishToast({ key: "evaluation-case-source-open-failed", title: "Could not open source trace", detail: error instanceof Error ? error.message : "The saved source trace could not be read.", durableHome: "the case remains valid without its optional source annotation" }));
  }

  function promote(targetSuiteId: EvaluationSuiteId, name: string): void {
    if (!project || !promotion) return;
    try {
      const promoted = promoteTraceToEvaluationCase(project, { suiteId: targetSuiteId, trace: promotion.trace, name });
      options.adoptProjectMutation(promoted.project);
      options.onPromoted(targetSuiteId, promoted.caseId);
      setPromotion(undefined);
      publishToast({ key: "evaluation-case-promoted", title: `Promoted “${name.trim()}” to a case`, detail: "Checks still need to be authored.", durableHome: "the evaluation suite’s focused case" });
      if (workspace) void (async () => {
        try {
          const sources = await readEvaluationCaseSourcesWorkspace(workspace);
          const saved = {
            suiteId: targetSuiteId, caseId: promoted.caseId, runId: promotion.trace.runId, capturedAt: new Date().toISOString(),
            ...(promotion.experimentCellId ? { experimentCellId: promotion.experimentCellId as ExperimentCellId } : {}),
          };
          await saveEvaluationCaseSourcesWorkspace(workspace, upsertEvaluationCaseSource(sources, saved));
          setSource(saved);
        } catch {
          publishToast({ key: "evaluation-case-source-unsaved", title: "Case promoted, but source link was not saved", detail: "The portable case is safe; reopen the trace if you need to keep its evidence link.", durableHome: "the promoted case, which remains valid without the local annotation" });
        }
      })();
    } catch (error) {
      publishToast({ key: "evaluation-case-promotion-failed", title: "Could not promote trace", detail: error instanceof Error ? error.message : "The trace could not be promoted.", durableHome: "the evaluation result evidence" });
    }
  }

  return {
    // A link read for an earlier focus is not shown once the focus is gone.
    ...(workspace && suiteId && focusedCaseId && source ? { source } : {}),
    openSource,
    ...(promotion ? { promotion } : {}),
    requestPromotion(trace, experimentCellId) {
      setPromotion({ trace, ...(experimentCellId ? { experimentCellId } : {}) });
    },
    cancelPromotion() { setPromotion(undefined); },
    promote,
  };
}
