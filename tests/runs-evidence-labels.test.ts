import assert from "node:assert/strict";
import test from "node:test";

import {
  batchMemberLabel,
  batchTitle,
  currentRunStorageLabel,
  protocolName,
} from "../app/run/runs-evidence-labels.ts";
import type { ExperimentPlanV3 } from "../packages/core/src/experiment.ts";
import type { RunId } from "../packages/core/src/run-kernel/types.ts";

const run = (suffix: string) => `run_${suffix}` as RunId;

/** Only the fields the labels read; the rest of a plan cannot change them. */
function evaluationPlan(options: { variants: number; repetitions: number }): ExperimentPlanV3 {
  const variants = Array.from({ length: options.variants }, (_unused, index) => ({
    variantId: `evaluation-variant_${index}`,
    name: index === 0 ? "Careful" : "Fast",
  }));
  return {
    kind: "evaluation",
    repetitions: options.repetitions,
    suite: {
      name: "Triage checks",
      cases: [
        { caseId: "evaluation-case_simple", name: "Simple response" },
        { caseId: "evaluation-case_rollback", name: "Rollback" },
      ],
      variants,
    },
    cells: [
      { runId: run("a"), ordinal: 1, caseId: "evaluation-case_simple", variantId: "evaluation-variant_0", repetition: 1 },
      { runId: run("b"), ordinal: 2, caseId: "evaluation-case_rollback", variantId: variants.at(-1)!.variantId, repetition: options.repetitions },
    ],
  } as unknown as ExperimentPlanV3;
}

test("names a batch member by its case, adding configuration and repetition only when they distinguish it", () => {
  const single = evaluationPlan({ variants: 1, repetitions: 1 });
  assert.equal(batchTitle(single), "Evaluation · Triage checks");
  assert.equal(batchMemberLabel(single, run("a")), "Simple response");

  const matrix = evaluationPlan({ variants: 2, repetitions: 3 });
  assert.equal(batchMemberLabel(matrix, run("b")), "Rollback · Fast · repetition 3");
  assert.equal(batchMemberLabel(matrix, run("missing")), undefined);

  const repeated = {
    kind: "repeated-request",
    commonInput: { target: { model: "buffered-test-model" } },
    cells: [{ runId: run("r1"), ordinal: 1 }, { runId: run("r2"), ordinal: 2 }],
  } as unknown as ExperimentPlanV3;
  assert.equal(batchTitle(repeated), "Repeated experiment · buffered-test-model");
  assert.equal(batchMemberLabel(repeated, run("r2")), "Repetition 2");
});

test("never describes an unsaved finished run as recoverable", () => {
  assert.equal(currentRunStorageLabel("completed", { kind: "unsaved" }), "Not saved · replaced by the next run");
  assert.equal(currentRunStorageLabel("failed", null), "Not saved · replaced by the next run");
  assert.equal(
    currentRunStorageLabel("completed", { kind: "error", message: "denied" }),
    "Not saved · could not write to the folder",
  );
  assert.equal(currentRunStorageLabel("completed", { kind: "saved", location: "traces/run_a.json" }), "Saved to folder");
  assert.equal(currentRunStorageLabel("cancelled", { kind: "saving" }), "Saving to folder…");
  // Still running: nothing has been decided about where it goes yet.
  assert.equal(currentRunStorageLabel("running", null), "Current session");
});

test("names each protocol a row can carry", () => {
  assert.equal(protocolName("openai-compatible-chat-completions"), "Chat Completions");
  assert.equal(protocolName("anthropic-messages"), "Anthropic Messages");
  assert.equal(protocolName("mock"), "Mock");
  assert.equal(protocolName(undefined), undefined);
});
