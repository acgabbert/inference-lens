import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluationBatchGuardrail,
  LARGE_EVALUATION_BATCH_WARNING_THRESHOLD,
  MAX_EVALUATION_PROVIDER_CALLS,
  MAX_EVALUATION_REPETITIONS,
} from "../app/evaluations/evaluation-batch.client.ts";

test("warns on a large evaluation without changing its paid call count", () => {
  const guardrail = evaluationBatchGuardrail(5, 5);
  assert.equal(guardrail.plannedCalls, LARGE_EVALUATION_BATCH_WARNING_THRESHOLD);
  assert.match(guardrail.warning ?? "", /25 provider calls/);
  assert.equal(guardrail.error, undefined);
});

test("reports repetition and total-call maxima instead of clamping", () => {
  const repetitions = evaluationBatchGuardrail(1, MAX_EVALUATION_REPETITIONS + 1);
  assert.equal(repetitions.plannedCalls, MAX_EVALUATION_REPETITIONS + 1);
  assert.match(repetitions.error ?? "", /value was not changed/i);

  const total = evaluationBatchGuardrail(MAX_EVALUATION_PROVIDER_CALLS, 2);
  assert.equal(total.plannedCalls, MAX_EVALUATION_PROVIDER_CALLS * 2);
  assert.match(total.error ?? "", /safety maximum/i);
});

test("rejects non-integer repetitions without inventing a replacement", () => {
  const guardrail = evaluationBatchGuardrail(3, 1.5);
  assert.equal(guardrail.plannedCalls, 4.5);
  assert.match(guardrail.error ?? "", /whole number/i);
});
