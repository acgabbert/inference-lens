"use client";

import { EvaluationPreviewWorkspace } from "../evaluations/evaluation-case-preview.client";
import { EvaluationSuiteEditor } from "../evaluations/evaluation-suite-editor.client";
import type {
  EvaluationSuiteExecutionActions,
  ModelFavoritesHandle,
} from "../evaluations/evaluation-suite-editor.client";
import { EvaluationSuiteRail } from "../evaluations/evaluation-suite-rail.client";
import type { EvaluationSuiteHistoryHandle } from "../evaluations/evaluation-suite-history.client";
import type { EvaluationSuiteAuthoringHandle } from "../evaluations/use-evaluation-suite-authoring.client";
import { PaneEmptyState } from "../pane-empty-state.client";
import styles from "./evaluations-mode.module.css";

/**
 * Which of the mode's regions are open. Owned by the route rather than by this
 * component: the Evaluations mode unmounts while another mode is on screen, so
 * state kept here would reset every time an author looked at a result and came
 * back — the exact loss the mode boundary exists to avoid.
 */
export interface EvaluationsLayoutHandle {
  setupOpen: boolean;
  onSetupOpenChange(open: boolean): void;
  previewOpen: boolean;
  onPreviewOpenChange(open: boolean): void;
}

interface EvaluationsModeProps {
  authoring: EvaluationSuiteAuthoringHandle;
  execution: EvaluationSuiteExecutionActions;
  history?: EvaluationSuiteHistoryHandle;
  layout: EvaluationsLayoutHandle;
  modelFavorites?: ModelFavoritesHandle;
  /** Leaves this mode for the request composer's prompt library. */
  onOpenTemplates(): void;
}

/**
 * The Evaluations mode's layout: suite list, suite workspace, provider input.
 *
 * The suites are a standing list rather than a `select`, the workspace stacks a
 * suite header, a bounded setup band, and the cases — so the case list and the
 * case editor keep their height whatever else is expanded — and the provider
 * input is a column the author can put away when they want the case editor's
 * full width back.
 */
export function EvaluationsMode({
  authoring,
  execution,
  history,
  layout,
  modelFavorites,
  onOpenTemplates,
}: EvaluationsModeProps) {
  const project = authoring.project;
  if (!project) {
    return (
      <div className={styles.modeEmpty}>
        <PaneEmptyState
          eyebrow="Evaluations"
          heading="Open or save a project first"
          detail="Evaluation suites are portable project content, so they need a project document."
        />
      </div>
    );
  }

  return (
    <div className={layout.previewOpen ? styles.mode : styles.modeWithoutPreview}>
      <EvaluationSuiteRail
        suites={project.evaluationSuites}
        {...(authoring.suiteId ? { selectedId: authoring.suiteId } : {})}
        onSelect={authoring.selectSuite}
        onCreate={authoring.createSuite}
      />
      {/* The editor labels its own region; wrapping it only supplies scroll. */}
      <div className={styles.editor}>
        <EvaluationSuiteEditor
          authoring={authoring}
          execution={execution}
          {...(history ? { history } : {})}
          {...(modelFavorites ? { modelFavorites } : {})}
          setup={{ open: layout.setupOpen, onOpenChange: layout.onSetupOpenChange }}
          onOpenTemplates={onOpenTemplates}
        />
      </div>
      {layout.previewOpen ? (
        <aside aria-label="Provider input" className={styles.preview}>
          <button
            className={styles.previewToggle}
            type="button"
            onClick={() => layout.onPreviewOpenChange(false)}
          >
            Hide provider input
          </button>
          <EvaluationPreviewWorkspace authoring={authoring} execution={execution} />
        </aside>
      ) : (
        <button
          aria-expanded="false"
          className={styles.previewEdge}
          type="button"
          onClick={() => layout.onPreviewOpenChange(true)}
        >
          Show provider input
        </button>
      )}
    </div>
  );
}
