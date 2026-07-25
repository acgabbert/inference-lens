"use client";

/**
 * Formatting shared by the metrics tab's views. The waterfall and the attempt
 * table label the same underlying numbers, so they format them in one place
 * rather than each keeping a copy that can drift into different units.
 */

/** Rendered in place of a value the run never produced evidence for. */
export const ABSENT = "—";

/**
 * Formats a millisecond duration. Absent values render as a dash rather than
 * zero: a run that never reported a timing is not a run that took no time.
 */
export function formatDuration(value?: number): string {
  if (value === undefined) return ABSENT;
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(2)} s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = (value % 60_000) / 1000;
  return `${minutes}m ${seconds.toFixed(1)}s`;
}

export function formatRate(value?: number): string {
  if (value === undefined) return ABSENT;
  return `${value.toFixed(1)} tok/s`;
}

export function formatTokens(value?: number): string {
  if (value === undefined) return ABSENT;
  return value.toLocaleString();
}

/** Turn IDs are opaque, so attempts are labelled by position instead. */
export function attemptLabel({
  turnIndex,
  attempt,
}: {
  turnIndex: number;
  attempt: number;
}): string {
  return attempt === 1
    ? `Turn ${turnIndex}`
    : `Turn ${turnIndex} · retry ${attempt - 1}`;
}
