"use client";

import { useEffect, useMemo, useState } from "react";

import type {
  ResolvedTemplateUse,
  RunEvent,
  RunId,
  RunState,
  RunTrace,
} from "../packages/core/src/run-kernel";
import {
  diffAttempts,
  diffCandidates,
} from "../packages/core/src/run-diff";
import {
  runInspectionSummary,
  type RunInspectionSummary as RunInspectionSummaryValue,
  type RunInspectionStatus,
} from "../packages/core/src/run-inspection";
import { runMetrics } from "../packages/core/src/run-metrics";
import { runTimeline } from "../packages/core/src/run-timeline";
import { runStateFromTrace } from "../packages/core/src/run-trace";
import {
  diffCandidateKey,
  RunDiffView,
} from "./run-diff-view.client";
import { RunMetricsView } from "./run-metrics-view.client";
import {
  formatDuration,
  formatRate,
  formatTokens,
} from "./run-metrics-format.client";
import { PaneTabs, ResizableTracePanel } from "./workbench-shell.client";

type TraceTab = "events" | "metrics" | "resolution" | "compare";

export interface ParentTraceState {
  status: "idle" | "loading" | "ready" | "error";
  trace?: RunTrace;
  error?: string;
}

interface RunTracePanelProps {
  open: boolean;
  runState: RunState | null;
  branchedFrom?: RunTrace["branchedFrom"];
  parentTrace: ParentTraceState;
  onLoadParentTrace(): void;
  onOpenChange(open: boolean): void;
}

function formatEvent(event: RunEvent): string {
  return JSON.stringify(event, null, 2);
}

function EventStream({ events }: { events: RunEvent[] }) {
  if (events.length === 0) {
    return <p className="trace-empty">Normalized events will appear here.</p>;
  }

  return (
    <>
      {events.map((event, index) => (
        <details
          key={event.eventId}
          open={event.type === "run.failed" || index === events.length - 1}
        >
          <summary>
            <span className={`event-dot ${event.type}`} />
            <span>{event.type}</span>
            <span>#{String(index + 1).padStart(2, "0")}</span>
          </summary>
          <pre>{formatEvent(event)}</pre>
        </details>
      ))}
    </>
  );
}

const STATUS_LABELS: Record<RunInspectionStatus, string> = {
  starting: "Starting",
  running: "Running",
  waiting_for_tools: "Waiting for tools",
  ready_to_continue: "Ready to continue",
  retry_available: "Retry available",
  completed: "Completed",
  cancelled: "Cancelled",
  failed: "Failed",
};

export function RunInspectionSummary({
  summary,
}: {
  summary: RunInspectionSummaryValue;
}) {
  const metrics = [
    summary.totalDurationMs === undefined
      ? undefined
      : {
          label: summary.phase === "active" ? "Elapsed" : "Duration",
          value: formatDuration(summary.totalDurationMs),
        },
    summary.ttfoMs === undefined
      ? undefined
      : {
          label: "First output",
          value: formatDuration(summary.ttfoMs),
        },
    summary.totalTokens === undefined
      ? undefined
      : {
          label: "Tokens",
          value: formatTokens(summary.totalTokens),
        },
    summary.outputTokensPerSecond === undefined
      ? undefined
      : {
          label: "Rate",
          value: formatRate(summary.outputTokensPerSecond),
        },
  ].filter((metric): metric is { label: string; value: string } =>
    Boolean(metric),
  );

  return (
    <dl className="run-inspection-summary" aria-label="Run summary">
      <div>
        <dt className="visually-hidden">Status</dt>
        {/*
          Only the status announces. The measurements beside it change on every
          streamed event, so a live region around the whole summary would read
          the row out once per delta.
        */}
        <dd aria-atomic="true" aria-live="polite">
          <span
            className={`run-inspection-status ${summary.status}`}
          >
            {STATUS_LABELS[summary.status]}
          </span>
        </dd>
      </div>
      {metrics.map((metric) => (
        <div key={metric.label}>
          <dt>{metric.label}</dt>
          <dd>{metric.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function TemplateProvenance({
  resolutions,
}: {
  resolutions: ResolvedTemplateUse[];
}) {
  if (resolutions.length === 0) {
    return (
      <p className="trace-empty">
        This run has no project-template provenance.
      </p>
    );
  }

  return (
    <>
      {resolutions.map((resolution) => (
        <details key={resolution.templateUseId}>
          <summary>
            <span className="event-dot run.completed" />
            <span>{resolution.templateName}</span>
            <span>{resolution.templateRevisionId}</span>
          </summary>
          <pre>
            {JSON.stringify(
              {
                templateUseId: resolution.templateUseId,
                templateId: resolution.templateId,
                templateRevisionId: resolution.templateRevisionId,
                values: resolution.values,
                variableDefaults: resolution.variableDefaults,
                outputMessageIds: resolution.outputMessageIds,
                fragmentRole: resolution.fragmentRole,
                content: resolution.content,
              },
              null,
              2,
            )}
          </pre>
        </details>
      ))}
    </>
  );
}

/**
 * The run-details panel below the response pane. It owns the choice between raw
 * event evidence and derived metrics so the workbench page composes one
 * element rather than the panel's internals.
 */
export function RunTracePanel({
  open,
  runState,
  branchedFrom,
  parentTrace,
  onLoadParentTrace,
  onOpenChange,
}: RunTracePanelProps) {
  const [tab, setTab] = useState<TraceTab>("events");
  const [selection, setSelection] = useState<{
    runId?: RunId;
    left?: string | null;
    right?: string | null;
  }>({});

  const events = runState?.events ?? [];
  const templateResolutions = runState?.input?.templateResolutions ?? [];
  const metrics = useMemo(
    () => (runState ? runMetrics(runState) : null),
    [runState],
  );
  const summary = useMemo(
    () => runInspectionSummary(runState),
    [runState],
  );
  const timeline = useMemo(
    () => (metrics ? runTimeline(metrics) : null),
    [metrics],
  );
  const parentState = useMemo(
    () =>
      parentTrace.status === "ready" && parentTrace.trace
        ? runStateFromTrace(parentTrace.trace)
        : null,
    [parentTrace],
  );
  const currentCandidates = useMemo(
    () => (runState ? diffCandidates(runState, "This run") : []),
    [runState],
  );
  const parentCandidates = useMemo(
    () => (parentState ? diffCandidates(parentState, "Parent run") : []),
    [parentState],
  );
  const candidates = useMemo(
    () => [...currentCandidates, ...parentCandidates],
    [currentCandidates, parentCandidates],
  );
  const selectionApplies = selection.runId === runState?.runId;
  const defaultLeft =
    currentCandidates.at(-2) ?? parentCandidates.at(-1);
  const defaultRight = currentCandidates.at(-1);
  const leftKey = selectionApplies
    ? selection.left === null
      ? undefined
      : selection.left ?? (defaultLeft && diffCandidateKey(defaultLeft))
    : defaultLeft && diffCandidateKey(defaultLeft);
  const rightKey = selectionApplies
    ? selection.right === null
      ? undefined
      : selection.right ?? (defaultRight && diffCandidateKey(defaultRight))
    : defaultRight && diffCandidateKey(defaultRight);

  const diff = useMemo(() => {
    if (!leftKey || !rightKey || !runState) return null;
    const findSelection = (key: string) => {
      const candidate = candidates.find(
        (item) => diffCandidateKey(item) === key,
      );
      if (!candidate) return undefined;
      const state =
        candidate.runId === runState.runId ? runState : parentState ?? undefined;
      return state ? { state, candidate } : undefined;
    };
    const left = findSelection(leftKey);
    const right = findSelection(rightKey);
    return left && right ? diffAttempts(left, right) : null;
  }, [candidates, leftKey, parentState, rightKey, runState]);

  // Clearing the run leaves no evidence to disclose. Retiring the disclosure
  // here rather than at each reset call site keeps a later run from opening
  // the full inspector on its own.
  useEffect(() => {
    if (!summary && open) onOpenChange(false);
  }, [onOpenChange, open, summary]);

  return (
    <ResizableTracePanel
      open={Boolean(summary) && open}
      canOpen={Boolean(summary)}
      onOpenChange={onOpenChange}
      summary={summary ? <RunInspectionSummary summary={summary} /> : undefined}
      tabs={
        summary && open && (
          <PaneTabs
            idPrefix="run-details"
            label="Run details"
            value={tab}
            onChange={(value) => setTab(value as TraceTab)}
            tabs={[
              { id: "events", label: "Events", count: events.length },
              { id: "metrics", label: "Metrics" },
              {
                id: "resolution",
                label: "Resolution",
                count: templateResolutions.length,
              },
              { id: "compare", label: "Compare" },
            ]}
          />
        )
      }
    >
      {tab === "compare" ? (
        <div
          aria-labelledby="run-details-compare-tab"
          aria-live="polite"
          className="trace"
          id="run-details-compare-panel"
          role="tabpanel"
        >
          <RunDiffView
            diff={diff}
            candidates={candidates}
            leftKey={leftKey}
            rightKey={rightKey}
            onSelect={(side, key) => {
              setSelection((current) => ({
                ...(current.runId === runState?.runId ? current : {}),
                runId: runState?.runId,
                [side]: key || null,
              }));
            }}
            parent={{
              available: Boolean(branchedFrom),
              runId: branchedFrom?.runId as RunId | undefined,
              status: parentTrace.status,
              error: parentTrace.error,
            }}
            onLoadParent={onLoadParentTrace}
          />
        </div>
      ) : tab === "metrics" ? (
        <div
          aria-labelledby="run-details-metrics-tab"
          className="trace"
          id="run-details-metrics-panel"
          role="tabpanel"
        >
          <RunMetricsView metrics={metrics} timeline={timeline} />
        </div>
      ) : tab === "resolution" ? (
        <div
          aria-labelledby="run-details-resolution-tab"
          aria-live="polite"
          className="trace"
          id="run-details-resolution-panel"
          role="tabpanel"
        >
          <TemplateProvenance resolutions={templateResolutions} />
        </div>
      ) : (
        <div
          aria-labelledby="run-details-events-tab"
          aria-live="polite"
          className="trace"
          id="run-details-events-panel"
          role="tabpanel"
        >
          <EventStream events={events} />
        </div>
      )}
    </ResizableTracePanel>
  );
}
