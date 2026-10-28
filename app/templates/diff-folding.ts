import type { DiffLine } from "../../packages/core/src/text-diff";

/** Unchanged lines kept visible on each side of a change. */
export const DIFF_FOLD_CONTEXT = 3;
/** Shorter unchanged runs stay visible: a fold must hide enough to earn its click. */
const MIN_FOLDED_LINES = 4;

export type DiffSegment =
  | { kind: "shown"; start: number; lines: DiffLine[] }
  | { kind: "fold"; start: number; lines: DiffLine[] };

/**
 * Splits a line diff into visible runs and folds of unchanged lines far from
 * any change. Every line lands in exactly one segment, in order; `start` is
 * the segment's first index, a stable key for remembering an expanded fold.
 */
export function foldDiffLines(lines: readonly DiffLine[]): DiffSegment[] {
  const near = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.kind === "context") return;
    const from = Math.max(0, index - DIFF_FOLD_CONTEXT);
    const to = Math.min(lines.length - 1, index + DIFF_FOLD_CONTEXT);
    for (let at = from; at <= to; at += 1) near[at] = true;
  });

  const segments: DiffSegment[] = [];
  let index = 0;
  while (index < lines.length) {
    let end = index;
    while (end < lines.length && near[end] === near[index]) end += 1;
    const run = lines.slice(index, end);
    const kind = !near[index] && run.length >= MIN_FOLDED_LINES ? "fold" : "shown";
    const previous = segments.at(-1);
    // A run too short to fold merges into its visible neighbor.
    if (kind === "shown" && previous?.kind === "shown") previous.lines.push(...run);
    else segments.push({ kind, start: index, lines: run });
    index = end;
  }
  return segments;
}
