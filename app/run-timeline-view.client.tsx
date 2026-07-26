"use client";

import type {
  RunTimeline,
  TimelineAttemptRow,
  TimelineGapRow,
  TimelinePhase,
  TimelineRow,
} from "../packages/core/src/run-timeline";
import { attemptLabel, formatDuration } from "./run-metrics-format.client";

interface RunTimelineViewProps {
  timeline: RunTimeline;
}

const PHASE_LABELS: Record<TimelinePhase, string> = {
  wait: "Waiting",
  prelude: "Stream open",
  reasoning: "Reasoning",
  tooling: "Tool calling",
  generation: "Generating",
};

const GAP_LABELS: Record<TimelineGapRow["reason"], string> = {
  tool_results: "Tool results",
  retry: "Awaiting retry",
};

/** Legend order follows the order phases occur within an attempt. */
const PHASE_ORDER: readonly TimelinePhase[] = [
  "wait",
  "prelude",
  "reasoning",
  "tooling",
  "generation",
];

/**
 * Position along the axis, as a percentage. An axis of zero length has no
 * geometry to offer, so it yields 0 rather than a division by zero — the
 * NaN that would otherwise reach the style attribute.
 */
function percent(value: number, axisEndMs: number): number {
  if (!(axisEndMs > 0)) return 0;
  return (value / axisEndMs) * 100;
}

function rowKey(row: TimelineRow): string {
  return row.kind === "attempt"
    ? row.exchangeId
    : `gap-${row.reason}-${row.turnId}-${row.startMs}`;
}

/** The phases this run actually produced, so the legend claims nothing more. */
function presentPhases(timeline: RunTimeline): TimelinePhase[] {
  const present = new Set<TimelinePhase>();
  for (const row of timeline.rows) {
    if (row.kind !== "attempt") continue;
    for (const segment of row.segments) present.add(segment.phase);
  }
  return PHASE_ORDER.filter((phase) => present.has(phase));
}

function AttemptRow({
  row,
  axisEndMs,
}: {
  row: TimelineAttemptRow;
  axisEndMs: number;
}) {
  // Screen readers get the same breakdown the bars convey visually, and the
  // text is greppable when driving the UI in a browser.
  const spoken = row.segments
    .map(
      ({ phase, durationMs }) =>
        `${PHASE_LABELS[phase]} ${formatDuration(durationMs)}`,
    )
    .join(", ");

  return (
    <li className={`run-timeline-row ${row.status}`}>
      <span className="run-timeline-label">{attemptLabel(row)}</span>
      <span className="run-timeline-track">
        {row.segments.map((segment) => (
          <span
            key={`${segment.phase}-${segment.startMs}`}
            className={`run-timeline-bar ${segment.phase}${
              row.openEnded ? " open-ended" : ""
            }`}
            style={{
              left: `${percent(segment.startMs, axisEndMs)}%`,
              width: `${percent(segment.durationMs, axisEndMs)}%`,
            }}
            title={`${PHASE_LABELS[segment.phase]} · ${formatDuration(
              segment.durationMs,
            )}`}
          />
        ))}
        {row.status === "failed" && row.segments.length > 0 && (
          <span
            className="run-timeline-fail-mark"
            style={{ left: `${percent(row.endMs, axisEndMs)}%` }}
            title={`Failed at ${formatDuration(row.endMs)}`}
          />
        )}
      </span>
      <span className="run-timeline-duration">
        {formatDuration(row.durationMs)}
      </span>
      {spoken && <span className="visually-hidden">{spoken}</span>}
    </li>
  );
}

function GapRow({ row, axisEndMs }: { row: TimelineGapRow; axisEndMs: number }) {
  return (
    <li className="run-timeline-row gap">
      <span className="run-timeline-label">{GAP_LABELS[row.reason]}</span>
      <span className="run-timeline-track">
        <span
          className="run-timeline-bar gap"
          style={{
            left: `${percent(row.startMs, axisEndMs)}%`,
            width: `${percent(row.durationMs, axisEndMs)}%`,
          }}
          title={`${GAP_LABELS[row.reason]} · ${formatDuration(row.durationMs)}`}
        />
      </span>
      <span className="run-timeline-duration">
        {formatDuration(row.durationMs)}
      </span>
    </li>
  );
}

/**
 * A waterfall of the run on one linear axis, from run start to the last stamp.
 *
 * Bars are positioned proportionally, but every value is also printed, because
 * a short phase next to a long tool pause collapses to a hairline. The numbers
 * are the record; the bars are the shape.
 */
export function RunTimelineView({ timeline }: RunTimelineViewProps) {
  if (timeline.rows.length === 0) return null;

  const { axisEndMs } = timeline;
  const phases = presentPhases(timeline);

  return (
    <section className="run-timeline" aria-label="Run timeline">
      <div className="run-timeline-head">
        <h3 className="run-timeline-title">Timeline</h3>
        <ul className="run-timeline-legend">
          {phases.map((phase) => (
            <li key={phase}>
              <span className={`run-timeline-key ${phase}`} />
              {PHASE_LABELS[phase]}
            </li>
          ))}
        </ul>
      </div>

      <ol className="run-timeline-rows">
        {timeline.rows.map((row) =>
          row.kind === "attempt" ? (
            <AttemptRow key={rowKey(row)} row={row} axisEndMs={axisEndMs} />
          ) : (
            <GapRow key={rowKey(row)} row={row} axisEndMs={axisEndMs} />
          ),
        )}
      </ol>

      <p className="run-timeline-axis">
        <span>0</span>
        <span>{formatDuration(axisEndMs)}</span>
      </p>
    </section>
  );
}
