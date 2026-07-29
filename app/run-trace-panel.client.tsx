"use client";

import { useMemo, useState } from "react";

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
import { runMetrics } from "../packages/core/src/run-metrics";
import { runTimeline } from "../packages/core/src/run-timeline";
import { runStateFromTrace } from "../packages/core/src/run-trace";
import {
  diffCandidateKey,
  RunDiffView,
} from "./run-diff-view.client";
import { RunMetricsView } from "./run-metrics-view.client";
import { PaneTabs, ResizableTracePanel } from "./workbench-shell.client";

type TraceTab = "events" | "metrics" | "templates" | "compare";

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

  return (
    <ResizableTracePanel
      open={open}
      onOpenChange={onOpenChange}
      tabs={
        open && (
          <PaneTabs
            label="Run details"
            value={tab}
            onChange={(value) => setTab(value as TraceTab)}
            tabs={[
              { id: "events", label: "Events", count: events.length },
              { id: "metrics", label: "Metrics" },
              {
                id: "templates",
                label: "Templates",
                count: templateResolutions.length,
              },
              { id: "compare", label: "Compare" },
            ]}
          />
        )
      }
      meta={
        metrics?.usage.totalTokens !== undefined ? (
          <span>{metrics.usage.totalTokens.toLocaleString()} tokens</span>
        ) : undefined
      }
    >
      {tab === "compare" ? (
        <div className="trace" aria-live="polite">
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
        <div className="trace">
          <RunMetricsView metrics={metrics} timeline={timeline} />
        </div>
      ) : tab === "templates" ? (
        <div className="trace" aria-live="polite">
          <TemplateProvenance resolutions={templateResolutions} />
        </div>
      ) : (
        <div className="trace" aria-live="polite">
          <EventStream events={events} />
        </div>
      )}
    </ResizableTracePanel>
  );
}
