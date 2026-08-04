"use client";

import { EvaluationPreviewWorkspace } from "../evaluations/evaluation-case-preview.client";
import { EvaluationSuiteEditor } from "../evaluations/evaluation-suite-editor.client";
import type {
  EvaluationSuiteExecutionActions,
  ModelFavoritesHandle,
} from "../evaluations/evaluation-suite-editor.client";
import type { EvaluationSuiteHistoryHandle } from "../evaluations/evaluation-suite-history.client";
import type { EvaluationSuiteAuthoringHandle } from "../evaluations/use-evaluation-suite-authoring.client";
import styles from "./evaluations-mode.module.css";

interface EvaluationsModeProps {
  authoring: EvaluationSuiteAuthoringHandle;
  execution: EvaluationSuiteExecutionActions;
  history?: EvaluationSuiteHistoryHandle;
  modelFavorites?: ModelFavoritesHandle;
  /** Leaves this mode for the request composer's prompt library. */
  onOpenTemplates(): void;
}

/**
 * The Evaluations mode's layout. The suite editor no longer shares a half-pane
 * with the request composer, and the provider-input preview no longer has to
 * evict the response pane to be seen — it sits beside the case it describes.
 *
 * PR 1 gives the editor the space; re-laying its internals for that space is
 * the next step, not this one.
 */
export function EvaluationsMode({
  authoring,
  execution,
  history,
  modelFavorites,
  onOpenTemplates,
}: EvaluationsModeProps) {
  return (
    <div className={styles.mode}>
      {/* The editor labels its own region; wrapping it only supplies scroll. */}
      <div className={styles.editor}>
        <EvaluationSuiteEditor
          authoring={authoring}
          execution={execution}
          {...(history ? { history } : {})}
          {...(modelFavorites ? { modelFavorites } : {})}
          onOpenTemplates={onOpenTemplates}
        />
      </div>
      <aside aria-label="Provider input" className={styles.preview}>
        <EvaluationPreviewWorkspace authoring={authoring} execution={execution} />
      </aside>
    </div>
  );
}
