import assert from "node:assert/strict";
import test from "node:test";

import {
  diffLines,
  TEXT_DIFF_LINE_CAP,
} from "../packages/core/src/text-diff.ts";

test("reports identical and empty texts without fabricated edits", () => {
  assert.deepEqual(diffLines("", ""), {
    lines: [],
    addedCount: 0,
    removedCount: 0,
    identical: true,
    truncated: false,
  });
  const identical = diffLines("one\ntwo", "one\ntwo");
  assert.equal(identical.identical, true);
  assert.deepEqual(
    identical.lines.map(({ kind, leftLine, rightLine }) => [
      kind,
      leftLine,
      rightLine,
    ]),
    [
      ["context", 1, 1],
      ["context", 2, 2],
    ],
  );
});

test("diffs additions, removals, and interleaved edits", () => {
  const diff = diffLines("keep\nremove\nlast", "keep\nadd\nlast");
  assert.equal(diff.identical, false);
  assert.equal(diff.addedCount, 1);
  assert.equal(diff.removedCount, 1);
  assert.deepEqual(
    diff.lines.map(({ kind, text }) => [kind, text]),
    [
      ["context", "keep"],
      ["removed", "remove"],
      ["added", "add"],
      ["context", "last"],
    ],
  );

  assert.deepEqual(
    diffLines("", "new").lines.map(({ kind, text }) => [kind, text]),
    [["added", "new"]],
  );
  assert.deepEqual(
    diffLines("old", "").lines.map(({ kind, text }) => [kind, text]),
    [["removed", "old"]],
  );
});

test("preserves a trailing newline as a comparable empty line", () => {
  const diff = diffLines("line", "line\n");
  assert.equal(diff.addedCount, 1);
  assert.deepEqual(diff.lines.at(-1), {
    kind: "added",
    text: "",
    rightLine: 2,
  });
});

test("degrades explicitly to a whole-block replacement above the line cap", () => {
  const tooMany = Array.from(
    { length: TEXT_DIFF_LINE_CAP + 1 },
    (_, index) => `line ${index}`,
  ).join("\n");
  const diff = diffLines(tooMany, "replacement");
  assert.equal(diff.truncated, true);
  assert.equal(diff.removedCount, TEXT_DIFF_LINE_CAP + 1);
  assert.equal(diff.addedCount, 1);
  assert.equal(diff.lines[0]?.kind, "removed");
  assert.equal(diff.lines.at(-1)?.kind, "added");
});
