"use client";

import { useMemo, useState } from "react";

import type { RunEvent, RunState } from "../packages/core/src/run-kernel";
import { runMetrics } from "../packages/core/src/run-metrics";
import { runTimeline } from "../packages/core/src/run-timeline";
import { RunMetricsView } from "./run-metrics-view.client";
import { PaneTabs, ResizableTracePanel } from "./workbench-shell.client";

type TraceTab = "events" | "metrics";

interface RunTracePanelProps {
  open: boolean;
  runState: RunState | null;
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

/**
 * The run-details panel below the response pane. It owns the choice between raw
 * event evidence and derived metrics so the workbench page composes one
 * element rather than the panel's internals.
 */
export function RunTracePanel({
  open,
  runState,
  onOpenChange,
}: RunTracePanelProps) {
  const [tab, setTab] = useState<TraceTab>("events");

  const events = runState?.events ?? [];
  const metrics = useMemo(
    () => (runState ? runMetrics(runState) : null),
    [runState],
  );
  const timeline = useMemo(
    () => (metrics ? runTimeline(metrics) : null),
    [metrics],
  );

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
      {tab === "metrics" ? (
        <div className="trace">
          <RunMetricsView metrics={metrics} timeline={timeline} />
        </div>
      ) : (
        <div className="trace" aria-live="polite">
          <EventStream events={events} />
        </div>
      )}
    </ResizableTracePanel>
  );
}
