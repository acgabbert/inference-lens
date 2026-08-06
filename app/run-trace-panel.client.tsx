"use client";

import { useEffect, useMemo, useState } from "react";

import {
  createRunTrace,
} from "../packages/core/src/run-kernel";
import type {
  RedactedProviderRequest,
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

type DiffSelection = {
  runId?: RunId;
  left?: string | null;
  right?: string | null;
};
type DiffSelectionKeys = { left?: string; right?: string };

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
  onPromoteTrace?(trace: RunTrace): void;
}

/**
 * Picks only relationships that the inspector can explain without pretending
 * two ordinary turns replaced one another. The selected keys are local UI
 * state, deliberately outside the RunTrace compatibility boundary.
 */
export function defaultAttemptDiffSelection(
  current: ReturnType<typeof diffCandidates>,
  parent: ReturnType<typeof diffCandidates>,
): Pick<DiffSelection, "left" | "right"> {
  for (let index = 0; index < current.length - 1; index += 1) {
    const failed = current[index]!;
    const retry = current[index + 1]!;
    if (failed.status === "failed" && failed.turnId === retry.turnId) {
      return { left: diffCandidateKey(failed), right: diffCandidateKey(retry) };
    }
  }

  if (parent.length > 0 && current.length > 0) {
    const parentCandidate =
      [...parent].reverse().find((candidate) => candidate.status === "completed") ??
      parent.at(-1);
    const currentCandidate =
      current.find((candidate) => candidate.turnIndex === parentCandidate?.turnIndex) ??
      current[0];
    if (parentCandidate && currentCandidate) {
      return {
        left: diffCandidateKey(parentCandidate),
        right: diffCandidateKey(currentCandidate),
      };
    }
  }

  return {};
}

/** A stale control value must never create a self-comparison. */
export function validAttemptDiffKeys(
  selection: Pick<DiffSelection, "left" | "right">,
  candidates: ReturnType<typeof diffCandidates>,
): DiffSelectionKeys {
  const known = new Set(candidates.map(diffCandidateKey));
  const left =
    selection.left !== null && selection.left !== undefined && known.has(selection.left)
      ? selection.left
      : undefined;
  const right =
    selection.right !== null && selection.right !== undefined && known.has(selection.right)
      ? selection.right
      : undefined;
  return left && left === right ? { left, right: undefined } : { left, right };
}

function formatEvent(event: RunEvent): string {
  return JSON.stringify(event, null, 2);
}

/**
 * Reformats the sent body for reading. The copy action deliberately does not
 * use this: comparing this workbench's request against another client's is only
 * conclusive on the bytes that were actually sent.
 */
function readableRequestBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

/**
 * The exact request handed to the HTTP client, offered as one copy so it can be
 * diffed against whatever another client sends. Only the credential is
 * withheld, and the header block says so rather than omitting it silently.
 */
function RequestEvidence({ request }: { request: RedactedProviderRequest }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");

  async function copyBody(): Promise<void> {
    if (!request.body) return;
    try {
      await navigator.clipboard.writeText(request.body);
      setStatus("copied");
    } catch {
      // Clipboard access is denied on insecure origins, where this workbench
      // is otherwise usable. Say so instead of appearing to have copied.
      setStatus("failed");
    }
  }

  return (
    <div className="request-evidence">
      <div className="request-evidence-header">
        <span>
          {request.method} {request.url}
        </span>
        {request.body && (
          <span className="request-evidence-actions">
            <button className="text-button" type="button" onClick={copyBody}>
              Copy raw request
            </button>
            <span aria-live="polite" className="request-evidence-status">
              {status === "copied"
                ? "Copied the exact bytes sent."
                : status === "failed"
                  ? "Copying needs clipboard access. Select the text below instead."
                  : ""}
            </span>
          </span>
        )}
      </div>
      {request.body && (
        <pre className="request-evidence-body">
          {readableRequestBody(request.body)}
        </pre>
      )}
      <p className="request-evidence-note">
        Reformatted for reading. Copy gives the exact bytes sent. Headers:{" "}
        {Object.entries(request.headers)
          .map(([name, value]) => `${name}: ${value}`)
          .join(", ")}
      </p>
    </div>
  );
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
          // The outbound request is the evidence this tab is usually opened
          // for, so it is disclosed rather than left folded behind a summary.
          open={
            event.type === "run.failed" ||
            event.type === "exchange.requested" ||
            index === events.length - 1
          }
        >
          <summary>
            <span className={`event-dot ${event.type}`} />
            <span>{event.type}</span>
            <span>#{String(index + 1).padStart(2, "0")}</span>
          </summary>
          {event.type === "exchange.requested" && (
            <RequestEvidence request={event.request} />
          )}
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
                messages: resolution.messages,
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
  onPromoteTrace,
}: RunTracePanelProps) {
  const [tab, setTab] = useState<TraceTab>("events");
  const [selection, setSelection] = useState<DiffSelection>({});

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
    () => (runState ? diffCandidates(runState, "Current run") : []),
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
  const hasAttemptDiff = currentCandidates.length >= 2 || Boolean(branchedFrom);
  const effectiveTab =
    tab === "resolution" && templateResolutions.length === 0
      ? "events"
      : tab === "compare" && !hasAttemptDiff
        ? "events"
        : tab;
  const selectionApplies = selection.runId === runState?.runId;
  const defaults = useMemo(
    () => defaultAttemptDiffSelection(currentCandidates, parentCandidates),
    [currentCandidates, parentCandidates],
  );
  const requestedSelection = selectionApplies
    ? {
        left: selection.left === null ? undefined : selection.left ?? defaults.left,
        right: selection.right === null ? undefined : selection.right ?? defaults.right,
      }
    : defaults;
  const { left: leftKey, right: rightKey } = validAttemptDiffKeys(
    requestedSelection,
    candidates,
  );

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

  // With no run evidence, there is no disclosure to offer. Omitting the
  // panel also returns its collapsed height to the response workspace.
  if (!summary) return null;

  return (
    <ResizableTracePanel
      open={open}
      onOpenChange={onOpenChange}
      summary={<>
        <RunInspectionSummary summary={summary} />
        {onPromoteTrace && runState && ["completed", "failed", "cancelled"].includes(runState.status.kind) && (
          <button className="text-button" type="button" onClick={() => onPromoteTrace(createRunTrace(runState, { branchedFrom }))}>Promote to case…</button>
        )}
      </>}
      tabs={
        open && (
          <PaneTabs
            idPrefix="run-details"
            label="Run details"
            value={effectiveTab}
            onChange={(value) => setTab(value as TraceTab)}
            tabs={[
              { id: "events", label: "Events", count: events.length },
              { id: "metrics", label: "Metrics" },
              ...(templateResolutions.length > 0
                ? [
                    {
                      id: "resolution",
                      label: "Templates",
                      count: templateResolutions.length,
                    },
                  ]
                : []),
              ...(hasAttemptDiff ? [{ id: "compare", label: "Attempt diff" }] : []),
            ]}
          />
        )
      }
    >
      {effectiveTab === "compare" ? (
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
      ) : effectiveTab === "metrics" ? (
        <div
          aria-labelledby="run-details-metrics-tab"
          className="trace"
          id="run-details-metrics-panel"
          role="tabpanel"
        >
          <RunMetricsView metrics={metrics} timeline={timeline} />
        </div>
      ) : effectiveTab === "resolution" ? (
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
