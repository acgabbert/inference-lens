import type {
  AttemptMetrics,
  AttemptMetricStatus,
  RunMetrics,
} from "./run-metrics.ts";
import type { ExchangeId, RunId, TurnId } from "./run-kernel/types.ts";

/**
 * A run laid out on a single time axis. Like RunMetrics, this is derived
 * state: it is never persisted, never part of the RunTrace envelope, and is
 * reconstructed identically from a live run or an imported trace.
 *
 * It is projected from RunMetrics rather than from RunState, because every
 * landmark a waterfall needs is already collected there. Deriving it a second
 * time from the event stream would let the two views disagree about the same
 * run.
 *
 * The waterfall exists to show the time the metrics deliberately exclude. Run
 * throughput measures model-output spans only, so a run that spent forty seconds
 * parked in `awaiting_tool_results` reports a healthy rate; that pause is
 * invisible in the summary and unmissable on an axis.
 */

/**
 * The phase a segment represents, named for what the run was doing during it:
 *
 * - `wait` — request sent, provider has returned nothing yet.
 * - `prelude` — response open, no assistant content yet. Over the HTTP host
 *   this is usually near zero, because the proxied stream reports
 *   `exchange.response_started` on the first forwarded data rather than on the
 *   provider's response headers. A long prelude means the provider held the
 *   stream open while producing nothing.
 * - `reasoning` — reasoning deltas arriving, no visible answer text yet.
 * - `tooling` — tool-call name or arguments arriving.
 * - `generation` — assistant text arriving.
 */
export type TimelinePhase =
  | "wait"
  | "prelude"
  | "reasoning"
  | "tooling"
  | "generation";

export interface TimelineSegment {
  phase: TimelinePhase;
  /** Elapsed stamps relative to run start, matching AttemptMetrics. */
  startMs: number;
  endMs: number;
  durationMs: number;
}

/**
 * Why the run was not talking to the provider. Both gaps are real elapsed time
 * that no attempt accounts for: `tool_results` is the pause between turns while
 * tool results are supplied, `retry` is the pause between a failed attempt and
 * the attempt that replaced it.
 */
export type TimelineGapReason = "tool_results" | "retry";

export interface TimelineAttemptRow {
  kind: "attempt";
  turnId: TurnId;
  turnIndex: number;
  attempt: number;
  exchangeId: ExchangeId;
  status: AttemptMetricStatus;
  /** Geometry only. Both are 0 when the attempt produced no stamp at all. */
  startMs: number;
  endMs: number;
  /** Absent when the attempt has not produced the evidence for a span. */
  durationMs?: number;
  /**
   * True when the attempt has not ended, so `endMs` is the axis end rather
   * than measured evidence. Callers must not present it as a duration.
   */
  openEnded: boolean;
  segments: TimelineSegment[];
}

export interface TimelineGapRow {
  kind: "gap";
  reason: TimelineGapReason;
  /** The turn the run was waiting to start, or to retry. */
  turnId: TurnId;
  startMs: number;
  endMs: number;
  durationMs: number;
}

export type TimelineRow = TimelineAttemptRow | TimelineGapRow;

export interface RunTimeline {
  runId: RunId;
  /**
   * Axis end, in ms from run start. Zero when nothing has been stamped yet,
   * which callers must treat as "no axis" rather than dividing by it.
   */
  axisEndMs: number;
  rows: TimelineRow[];
}

/**
 * Landmark ordering for ties. Stamps can share a millisecond on a fast local
 * provider, and sorting by time alone would let first output sort ahead of
 * the request that produced it.
 */
const PHASE_ORDER: readonly TimelinePhase[] = [
  "wait",
  "prelude",
  "reasoning",
  "tooling",
  "generation",
];

interface Landmark {
  phase: TimelinePhase;
  atMs: number;
}

/**
 * The stamps that open each phase, in the order they normally occur. A missing
 * landmark is skipped rather than inferred: the following phase then simply
 * starts at whatever landmark did arrive.
 */
function landmarks(attempt: AttemptMetrics): Landmark[] {
  const present: Landmark[] = [];
  const add = (phase: TimelinePhase, atMs?: number) => {
    if (atMs !== undefined) present.push({ phase, atMs });
  };

  add("wait", attempt.requestedAtMs);
  add("prelude", attempt.firstByteAtMs);
  add("reasoning", attempt.firstReasoningAtMs);
  add("tooling", attempt.firstToolCallAtMs);
  add("generation", attempt.firstTextAtMs);

  return present.sort(
    (a, b) =>
      a.atMs - b.atMs ||
      PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase),
  );
}

/**
 * Slices an attempt into consecutive phases. Zero-length phases are dropped
 * rather than emitted as invisible segments, so a segment always represents
 * time that actually passed.
 */
function segments(present: Landmark[], endMs: number): TimelineSegment[] {
  const spans: TimelineSegment[] = [];

  for (const [index, landmark] of present.entries()) {
    const startMs = landmark.atMs;
    const nextMs = present[index + 1]?.atMs ?? endMs;
    if (nextMs <= startMs) continue;
    spans.push({
      phase: landmark.phase,
      startMs,
      endMs: nextMs,
      durationMs: nextMs - startMs,
    });
  }

  return spans;
}

function attemptRow(attempt: AttemptMetrics, axisEndMs: number): TimelineAttemptRow {
  const present = landmarks(attempt);
  const startMs = present[0]?.atMs ?? 0;
  const openEnded = attempt.endedAtMs === undefined;

  // A running attempt is drawn to the axis end so the bar keeps pace with the
  // stream, but that edge is not evidence and is never reported as a duration.
  const endMs = openEnded
    ? Math.max(startMs, axisEndMs)
    : (attempt.endedAtMs ?? startMs);

  return {
    kind: "attempt",
    turnId: attempt.turnId,
    turnIndex: attempt.turnIndex,
    attempt: attempt.attempt,
    exchangeId: attempt.exchangeId,
    status: attempt.status,
    startMs: present.length > 0 ? startMs : 0,
    endMs: present.length > 0 ? endMs : 0,
    durationMs: attempt.durationMs,
    openEnded,
    segments: present.length > 0 ? segments(present, endMs) : [],
  };
}

/**
 * The unattributed pause between two consecutive attempts, if there was one.
 * A gap between attempts of the same turn is a retry wait; a gap across turns
 * is the run waiting for tool results.
 */
function gapRow(
  previous: AttemptMetrics,
  next: AttemptMetrics,
): TimelineGapRow | undefined {
  const startMs = previous.endedAtMs;
  const endMs = next.requestedAtMs;
  if (startMs === undefined || endMs === undefined || endMs <= startMs) {
    return undefined;
  }

  return {
    kind: "gap",
    reason: previous.turnId === next.turnId ? "retry" : "tool_results",
    turnId: next.turnId,
    startMs,
    endMs,
    durationMs: endMs - startMs,
  };
}

/**
 * Projects a waterfall from run metrics. Pure: no clock, no I/O, and no
 * mutation of the projection passed in.
 */
export function runTimeline(metrics: RunMetrics): RunTimeline {
  // The last event's stamp normally ends the axis, but a still-streaming
  // attempt can carry a later landmark than the last event the reducer saw.
  const axisEndMs = metrics.attempts.reduce(
    (end, attempt) =>
      Math.max(
        end,
        attempt.requestedAtMs ?? 0,
        attempt.firstByteAtMs ?? 0,
        attempt.firstReasoningAtMs ?? 0,
        attempt.firstToolCallAtMs ?? 0,
        attempt.firstTextAtMs ?? 0,
        attempt.endedAtMs ?? 0,
      ),
    metrics.totalDurationMs ?? 0,
  );

  const rows: TimelineRow[] = [];
  let previous: AttemptMetrics | undefined;

  for (const attempt of metrics.attempts) {
    if (previous) {
      const gap = gapRow(previous, attempt);
      if (gap) rows.push(gap);
    }
    rows.push(attemptRow(attempt, axisEndMs));
    previous = attempt;
  }

  return { runId: metrics.runId, axisEndMs, rows };
}
