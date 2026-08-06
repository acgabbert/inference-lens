"use client";

import { useState } from "react";

import type { EvaluationBaseline } from "../../packages/core/src/evaluation-baselines.ts";
import type { EvaluationHistoryItem } from "../../packages/core/src/experiment-history.ts";
import type {
  ConversationRevisionId,
  EvaluationBaselineId,
} from "../../packages/core/src/run-kernel";
import {
  evaluationPassSummary,
  evaluationPassTone,
} from "./evaluation-history-format.client";
import { DisclosureChevron } from "../disclosure-chevron.client";

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
  executions: EvaluationHistoryItem[];
  error?: string;
  /**
   * The revision the suite currently authors against. Executions recorded
   * against a different one still belong to this suite and stay listed; they
   * are marked, because a pass rate that moved with the input is a different
   * finding from one that moved on its own.
   */
  currentRevisionId?: ConversationRevisionId;
  /**
   * Whether the disclosure is open. Owned by the route rather than by this
   * component because the Evaluations mode unmounts when another mode is on
   * screen: state kept here would silently collapse on the way back, which is
   * exactly the loss the mode boundary is supposed to avoid.
   */
  expanded: boolean;
  onExpandedChange(expanded: boolean): void;
  onExpand(): void;
  onRefresh(): void;
  onOpen(item: EvaluationHistoryItem): Promise<void>;
  /**
   * Named baselines for this suite, newest first. Absent when the project has
   * no folder to write annotations to, which is what hides the pinning
   * controls rather than a disabled button with nothing to explain it.
   */
  baselines?: EvaluationSuiteBaselinesHandle;
}

export interface EvaluationSuiteBaselinesHandle {
  items: EvaluationBaseline[];
  error?: string;
  busy: boolean;
  onPin(item: EvaluationHistoryItem, name: string): Promise<void>;
  onUnpin(baselineId: EvaluationBaselineId): Promise<void>;
  onCompare(baseline: EvaluationBaseline, candidate: EvaluationHistoryItem): Promise<void>;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function EvaluationSuiteHistory({ history }: { history: EvaluationSuiteHistoryHandle }) {
  const expanded = history.expanded;
  const [pendingPlanFileName, setPendingPlanFileName] = useState<string>();
  const [openError, setOpenError] = useState<string>();
  const [namingPlanFileName, setNamingPlanFileName] = useState<string>();
  const [pinName, setPinName] = useState("");
  const [baselineError, setBaselineError] = useState<string>();
  const [comparisonSelection, setComparisonSelection] = useState<Record<string, string>>({});
  const busy = history.status === "idle" || history.status === "loading";
  const baselines = history.baselines;

  /** One reporting path for every baseline mutation, including comparison. */
  async function act(operation: () => Promise<void>): Promise<void> {
    setBaselineError(undefined);
    try {
      await operation();
    } catch (error) {
      setBaselineError(
        error instanceof Error ? error.message : "That baseline action did not complete.",
      );
    }
  }

  async function open(item: EvaluationHistoryItem): Promise<void> {
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
        history.onExpandedChange(open);
        if (open) history.onExpand();
      }}
    >
      <summary>
        <DisclosureChevron className="evaluation-suite-history-chevron" />
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

        {baselines?.error && (
          <div className="run-history-notice error" role="alert">
            <strong>Baselines unavailable</strong>
            <span>{baselines.error}</span>
          </div>
        )}

        {baselineError && (
          <div className="run-history-notice error" role="alert">
            <strong>Could not update baselines</strong>
            <span>{baselineError}</span>
          </div>
        )}

        {history.executions.map((item) => {
          const drifted = Boolean(
            history.currentRevisionId &&
              item.evaluation &&
              item.evaluation.conversationRevisionId !== history.currentRevisionId,
          );
          const pending = item.planFileName === pendingPlanFileName;
          const pinnedAs = baselines?.items.find(
            (baseline) => baseline.experimentId === item.experimentId,
          );
          const comparable = (baselines?.items ?? []).filter(
            (baseline) => baseline.experimentId !== item.experimentId,
          );
          return (
            <div className="evaluation-suite-history-entry" key={item.planFileName}>
              <button
                aria-busy={pending ? "true" : undefined}
                className="evaluation-suite-history-item"
                disabled={Boolean(pendingPlanFileName)}
                type="button"
                onClick={() => void open(item)}
              >
                <span className="evaluation-suite-history-item-heading">
                  <time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time>
                  <span className={`evaluation-pass ${evaluationPassTone(item.evaluation.variants[0])}`}>
                    {item.evaluation.variants.length === 0
                      ? evaluationPassSummary(undefined)
                      : item.evaluation.variants.length === 1
                        ? evaluationPassSummary(item.evaluation.variants[0])
                        : `${item.evaluation.variants.length} configurations`}
                  </span>
                  <span className={`run-history-status ${item.lifecycle}`}>
                    {pending ? "opening" : item.lifecycle}
                  </span>
                </span>
                <span>
                  {item.requested} planned {item.requested === 1 ? "run" : "runs"} ·{" "}
                  {item.evaluation.variants.map((variant) => `${variant.name} · ${variant.model}`).join("; ") || "not scored"}
                </span>
                {drifted && (
                  <span className="evaluation-suite-history-drift">
                    Ran against a different input revision
                  </span>
                )}
                {pinnedAs && (
                  <span className="evaluation-suite-history-baseline">
                    Baseline · {pinnedAs.name}
                  </span>
                )}
              </button>

              {baselines && (
                <div className="evaluation-suite-history-actions">
                  {pinnedAs ? (
                    <button
                      className="text-button"
                      disabled={baselines.busy}
                      type="button"
                      onClick={() => void act(() => baselines.onUnpin(pinnedAs.baselineId))}
                    >
                      Unpin baseline
                    </button>
                  ) : namingPlanFileName === item.planFileName ? (
                    <form
                      className="evaluation-suite-history-pin-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void act(async () => {
                          await baselines.onPin(item, pinName);
                          setNamingPlanFileName(undefined);
                          setPinName("");
                        });
                      }}
                    >
                      <label className="visually-hidden" htmlFor="evaluation-baseline-name">
                        Baseline name
                      </label>
                      <input
                        autoFocus
                        id="evaluation-baseline-name"
                        maxLength={80}
                        placeholder="Name this baseline"
                        value={pinName}
                        onChange={(event) => setPinName(event.target.value)}
                      />
                      <button
                        className="text-button"
                        disabled={baselines.busy || !pinName.trim()}
                        type="submit"
                      >
                        Save baseline
                      </button>
                      <button
                        className="text-button"
                        type="button"
                        onClick={() => {
                          setNamingPlanFileName(undefined);
                          setBaselineError(undefined);
                        }}
                      >
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <button
                      className="text-button"
                      disabled={!item.evaluation || baselines.busy}
                      type="button"
                      onClick={() => {
                        setBaselineError(undefined);
                        setPinName("");
                        setNamingPlanFileName(item.planFileName);
                      }}
                    >
                      Pin as baseline…
                    </button>
                  )}

                  {comparable.length > 0 && (
                    <span className="evaluation-suite-history-compare">
                      <label
                        className="visually-hidden"
                        htmlFor={`compare-${item.planFileName}`}
                      >
                        Compare against baseline
                      </label>
                      <select
                        id={`compare-${item.planFileName}`}
                        value={comparisonSelection[item.planFileName] ?? ""}
                        onChange={(event) =>
                          setComparisonSelection((current) => ({
                            ...current,
                            [item.planFileName]: event.target.value,
                          }))
                        }
                      >
                        <option value="">Compare against…</option>
                        {comparable.map((baseline) => (
                          <option key={baseline.baselineId} value={baseline.baselineId}>
                            {baseline.name}
                          </option>
                        ))}
                      </select>
                      <button
                        className="text-button"
                        disabled={baselines.busy || !comparisonSelection[item.planFileName]}
                        type="button"
                        onClick={() => {
                          const selected = comparable.find(
                            (baseline) =>
                              baseline.baselineId === comparisonSelection[item.planFileName],
                          );
                          if (selected) void act(() => baselines.onCompare(selected, item));
                        }}
                      >
                        Compare
                      </button>
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </details>
  );
}
