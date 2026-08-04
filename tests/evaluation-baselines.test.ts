import assert from "node:assert/strict";
import test from "node:test";

import {
  EvaluationBaselineError,
  emptyEvaluationBaselines,
  parseEvaluationBaselinesJson,
  pinEvaluationBaseline,
  renameEvaluationBaseline,
  serializeEvaluationBaselines,
  suiteEvaluationBaselines,
  unpinEvaluationBaseline,
} from "../packages/core/src/evaluation-baselines.ts";

const suiteId = "evaluation-suite_topics" as const;

function pinned() {
  let file = emptyEvaluationBaselines();
  file = pinEvaluationBaseline(file, {
    baselineId: "evaluation-baseline_first",
    suiteId,
    experimentId: "experiment_one",
    name: "  Before   refactor ",
    pinnedAt: "2026-08-01T12:00:00.000Z",
  });
  return pinEvaluationBaseline(file, {
    baselineId: "evaluation-baseline_second",
    suiteId,
    experimentId: "experiment_two",
    name: "After refactor",
    pinnedAt: "2026-08-02T12:00:00.000Z",
  });
}

test("a pinned name is normalized and survives a serialize round trip", () => {
  const file = pinned();
  assert.equal(file.baselines[0]?.name, "Before refactor");
  assert.deepEqual(parseEvaluationBaselinesJson(serializeEvaluationBaselines(file)), file);
});

test("suite baselines list most recently pinned first", () => {
  assert.deepEqual(
    suiteEvaluationBaselines(pinned(), suiteId).map(({ name }) => name),
    ["After refactor", "Before refactor"],
  );
  assert.deepEqual(suiteEvaluationBaselines(pinned(), "evaluation-suite_other"), []);
});

test("names stay unambiguous within a suite and each execution pins once", () => {
  const file = pinned();
  assert.throws(
    () =>
      pinEvaluationBaseline(file, {
        baselineId: "evaluation-baseline_third",
        suiteId,
        experimentId: "experiment_three",
        name: "after refactor",
        pinnedAt: "2026-08-03T12:00:00.000Z",
      }),
    (error: EvaluationBaselineError) => error.code === "duplicate-name",
  );
  assert.throws(
    () =>
      pinEvaluationBaseline(file, {
        baselineId: "evaluation-baseline_third",
        suiteId,
        experimentId: "experiment_two",
        name: "Another name",
        pinnedAt: "2026-08-03T12:00:00.000Z",
      }),
    (error: EvaluationBaselineError) => error.code === "duplicate-experiment",
  );
  assert.throws(
    () =>
      pinEvaluationBaseline(file, {
        baselineId: "evaluation-baseline_third",
        suiteId,
        experimentId: "experiment_three",
        name: "   ",
        pinnedAt: "2026-08-03T12:00:00.000Z",
      }),
    (error: EvaluationBaselineError) => error.code === "empty-name",
  );
  // The same name in another suite is a different suite's business.
  assert.equal(
    pinEvaluationBaseline(file, {
      baselineId: "evaluation-baseline_third",
      suiteId: "evaluation-suite_other",
      experimentId: "experiment_two",
      name: "After refactor",
      pinnedAt: "2026-08-03T12:00:00.000Z",
    }).baselines.length,
    3,
  );
});

test("renaming keeps its own name and unpinning removes only the annotation", () => {
  const file = pinned();
  const renamed = renameEvaluationBaseline(file, "evaluation-baseline_second", "After refactor");
  assert.equal(renamed.baselines[1]?.name, "After refactor");
  assert.throws(
    () => renameEvaluationBaseline(file, "evaluation-baseline_second", "Before refactor"),
    (error: EvaluationBaselineError) => error.code === "duplicate-name",
  );
  assert.throws(
    () => renameEvaluationBaseline(file, "evaluation-baseline_missing", "Anything"),
    (error: EvaluationBaselineError) => error.code === "unknown-baseline",
  );
  const unpinned = unpinEvaluationBaseline(file, "evaluation-baseline_first");
  assert.deepEqual(unpinned.baselines.map(({ experimentId }) => experimentId), ["experiment_two"]);
});

test("a damaged baselines file is reported rather than silently emptied", () => {
  assert.throws(
    () => parseEvaluationBaselinesJson("{ not json"),
    (error: EvaluationBaselineError) => error.code === "invalid-file",
  );
  assert.throws(
    () => parseEvaluationBaselinesJson(JSON.stringify({ schemaVersion: 2, baselines: [] })),
    (error: EvaluationBaselineError) => error.code === "invalid-file",
  );
  assert.throws(
    () =>
      parseEvaluationBaselinesJson(
        JSON.stringify({
          schemaVersion: 1,
          baselines: [
            {
              baselineId: "evaluation-baseline_a",
              suiteId,
              experimentId: "experiment_one",
              name: "One",
              pinnedAt: "2026-08-01T12:00:00.000Z",
            },
            {
              baselineId: "evaluation-baseline_a",
              suiteId,
              experimentId: "experiment_two",
              name: "Two",
              pinnedAt: "2026-08-01T12:00:00.000Z",
            },
          ],
        }),
      ),
    (error: EvaluationBaselineError) => error.code === "invalid-file",
  );
});
