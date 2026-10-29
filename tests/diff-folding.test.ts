import assert from "node:assert/strict";
import test from "node:test";

import type { DiffLine } from "../packages/core/src/text-diff.ts";
import { foldDiffLines } from "../app/templates/diff-folding.ts";

const context = (count: number, from = 1): DiffLine[] =>
  Array.from({ length: count }, (_, index) => ({ kind: "context", text: `line ${from + index}` }));
const removed: DiffLine = { kind: "removed", text: "old" };
const added: DiffLine = { kind: "added", text: "new" };

function shape(lines: DiffLine[]) {
  return foldDiffLines(lines).map((segment) =>
    segment.kind === "fold" ? `fold ${segment.lines.length}` : `show ${segment.lines.length}`,
  );
}

test("foldDiffLines keeps three lines of context around each change", () => {
  // 10 leading, change, 20 between, change, 10 trailing.
  const lines = [...context(10), removed, added, ...context(20, 11), added, ...context(10, 31)];
  assert.deepEqual(shape(lines), ["fold 7", "show 8", "fold 14", "show 7", "fold 7"]);
});

test("foldDiffLines leaves short unchanged runs visible", () => {
  // A fold must hide enough to be worth the extra click.
  assert.deepEqual(shape([...context(5), added, ...context(5, 6)]), ["show 11"]);
  assert.deepEqual(shape([...context(7), added]), ["fold 4", "show 4"]);
});

test("foldDiffLines folds nothing when every line changed", () => {
  assert.deepEqual(shape([removed, removed, added]), ["show 3"]);
});

test("foldDiffLines preserves every line in order", () => {
  const lines = [...context(12), added, ...context(12, 13)];
  assert.deepEqual(foldDiffLines(lines).flatMap((segment) => segment.lines), lines);
});
