"use client";

import { useState } from "react";

import type { ExperimentHistoryItem } from "../../packages/core/src/experiment-history.ts";
import type { ConversationRevisionId } from "../../packages/core/src/run-kernel";
import {
  evaluationPassSummary,
  evaluationPassTone,
} from "./evaluation-history-format.client";

/**
 * Past executions of the suite being authored.
 *
 * Supplied by the route: listing immutable artifacts is project-workspace work,
 * not authoring state, and the same listing already backs the run-history
 * drawer. The editor renders what it is handed and owns only the disclosure.
 *
 * `onExpand` exists because building the listing costs a full parse of every
 * artifact in the project folder. The section is collapsed until an author asks
 * for it, so opening a project stays cheap; once loaded the route's cache keeps
 * later expansions instant.
 */
export interface EvaluationSuiteHistoryHandle {
  status: "idle" | "loading" | "loaded" | "failed";
  /** Executions of the selected suite across every input revision, newest first. */
  executions: ExperimentHistoryItem[];
  error?: string;
  /**
   * The revision the suite currently authors against. Executions recorded
   * against a different one still belong to this suite and stay listed; they
   * are marked, because a pass rate that moved with the input is a different
   * finding from one that moved on its own.
   */
  currentRevisionId?: ConversationRevisionId;
  onExpand(): void;
  onRefresh(): void;
  onOpen(item: ExperimentHistoryItem): Promise<void>;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function EvaluationSuiteHistory({ history }: { history: EvaluationSuiteHistoryHandle }) {
  const [expanded, setExpanded] = useState(false);
  const [pendingPlanFileName, setPendingPlanFileName] = useState<string>();
  const [openError, setOpenError] = useState<string>();
  const busy = history.status === "idle" || history.status === "loading";

  async function open(item: ExperimentHistoryItem): Promise<void> {
    setPendingPlanFileName(item.planFileName);
    setOpenError(undefined);
    try {
      await history.onOpen(item);
    } catch (error) {
      setOpenError(
        error instanceof Error ? error.message : "Could not open that evaluation.",
      );
    } finally {
      setPendingPlanFileName(undefined);
    }
  }

  return (
    <details
      className="evaluation-suite-history"
      open={expanded}
      onToggle={(event) => {
        const open = event.currentTarget.open;
        setExpanded(open);
        if (open) history.onExpand();
      }}
    >
      <summary>
        {/* Drawn rather than typed: U+2304's ink sits high in its em box, which
            a bordered square exposes as an off-centre glyph. `currentColor`
            keeps it on the theme tokens. */}
        <span className="evaluation-suite-history-chevron" aria-hidden="true">
          <svg viewBox="0 0 10 10" width="10" height="10" fill="none">
            <path
              d="M2 3.5l3 3 3-3"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className="evaluation-suite-history-title">
          <span className="eyebrow">Evidence</span>
          <strong>Past executions</strong>
        </span>
        {/* Collapsed, the card is two words and no content. Saying what is
            inside it — and that opening costs a read — is what makes it read
            as a disclosure rather than as a heading. */}
        <span className="evaluation-suite-history-hint">
          {expanded ? "Hide" : "Show saved runs of this suite"}
        </span>
      </summary>

      <div className="evaluation-suite-history-body">
        {expanded && (
          <div className="evaluation-suite-history-toolbar">
            <span>
              {busy
                ? "Loading…"
                : `${history.executions.length} saved ${
                    history.executions.length === 1 ? "execution" : "executions"
                  } of this suite`}
            </span>
            <button
              className="text-button"
              type="button"
              disabled={busy || Boolean(pendingPlanFileName)}
              onClick={history.onRefresh}
            >
              Refresh
            </button>
          </div>
        )}

        {history.error && (
          <div className="run-history-notice error" role="alert">
            <strong>History unavailable</strong>
            <span>{history.error}</span>
          </div>
        )}

        {openError && (
          <div className="run-history-notice error" role="alert">
            <strong>Could not open that evaluation</strong>
            <span>{openError}</span>
          </div>
        )}

        {!busy && !history.error && history.executions.length === 0 && (
          <p className="evaluation-empty-inline">
            This suite has not been run yet. Saved executions appear here and stay
            readable after the session ends.
          </p>
        )}

        {history.executions.map((item) => {
          const drifted = Boolean(
            history.currentRevisionId &&
              item.evaluation &&
              item.evaluation.conversationRevisionId !== history.currentRevisionId,
          );
          const pending = item.planFileName === pendingPlanFileName;
          return (
            <button
              aria-busy={pending ? "true" : undefined}
              className="evaluation-suite-history-item"
              disabled={Boolean(pendingPlanFileName)}
              key={item.planFileName}
              type="button"
              onClick={() => void open(item)}
            >
              <span className="evaluation-suite-history-item-heading">
                <time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time>
                <span className={`evaluation-pass ${evaluationPassTone(item.evaluation)}`}>
                  {evaluationPassSummary(item.evaluation)}
                </span>
                <span className={`run-history-status ${item.lifecycle}`}>
                  {pending ? "opening" : item.lifecycle}
                </span>
              </span>
              <span>
                {item.requested} planned {item.requested === 1 ? "run" : "runs"} ·{" "}
                {item.model}
              </span>
              {drifted && (
                <span className="evaluation-suite-history-drift">
                  Ran against a different input revision
                </span>
              )}
            </button>
          );
        })}
      </div>
    </details>
  );
}
