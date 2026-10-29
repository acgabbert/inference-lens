import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  decisionAnswerViews,
  formatDuration,
  formatUsage,
} from "../app/decisions/decision-result-view.ts";
import { systemOneAdapter } from "../packages/core/src/system-one.ts";
import type { DecisionInput, DecisionProviderInput } from "../packages/core/src/decision.ts";

function capturedRun() {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/system-one/llamacpp-all-types.json", import.meta.url), "utf8"),
  );
  const decision: DecisionInput = { state: fixture.request.state, questions: fixture.request.questions };
  const input = {
    target: {
      profileId: "profile_fixture",
      protocol: "systemone",
      endpoint: "http://127.0.0.1/v1",
      model: "all-types",
      capabilities: {},
    },
    decision,
  } as unknown as DecisionProviderInput;
  return { decision, result: systemOneAdapter.normalizeResponse(input, JSON.stringify(fixture.response.body)) };
}

test("choice bars keep authored order and the captured probabilities", () => {
  const { decision, result } = capturedRun();
  const [intent] = decisionAnswerViews(decision, result);
  assert.equal(intent?.type, "choice");
  assert.ok(intent?.type === "choice");
  assert.equal(intent.choice, "billing");
  assert.deepEqual(intent.bars.map(({ label, percent, selected }) => [label, percent, selected]), [
    ["billing", "92.8%", true],
    ["bug", "5.9%", false],
    ["other", "1.3%", false],
  ]);
  assert.equal(intent.confidence, "89.2%");
});

test("a score shows its fractional value, a marker position, and legend labels", () => {
  const { decision, result } = capturedRun();
  const severity = decisionAnswerViews(decision, result)[1];
  assert.ok(severity?.type === "score");
  assert.equal(severity.score, "1.09");
  assert.ok(Math.abs(severity.position - 1.0871479652612954 / 2) < 1e-12);
  assert.deepEqual(severity.bars.map(({ label, percent }) => [label, percent]), [
    ["0 · minor", "7.5%"],
    ["1 · major", "76.2%"],
    ['2 · {"label":"critical","note":"data loss or money lost"}', "16.2%"],
  ]);
  assert.equal(severity.confidence, "64.4%");
});

test("noul shows P(true) and no confidence", () => {
  const { decision, result } = capturedRun();
  const spam = decisionAnswerViews(decision, result)[2];
  assert.ok(spam?.type === "noul");
  assert.equal(spam.bar.percent, "7.8%");
  assert.ok(!("confidence" in spam));
});

test("usage keeps missing counts missing, and duration comes from recorded times", () => {
  const { result } = capturedRun();
  assert.equal(formatUsage(result.usage), "203 input · 0 output · 203 total tokens");
  assert.equal(formatUsage(undefined), "Not reported");
  assert.equal(formatUsage({ inputTokens: 5 }), "5 input tokens");
  assert.equal(formatDuration("2026-10-24T10:00:00.000Z", "2026-10-24T10:00:01.250Z"), "1.25 s");
  assert.equal(formatDuration("2026-10-24T10:00:00.000Z", "2026-10-24T10:00:00.420Z"), "420 ms");
  assert.equal(formatDuration(undefined, "2026-10-24T10:00:00.420Z"), undefined);
});

test("nothing renders as NaN, Infinity, or undefined", () => {
  const { decision, result } = capturedRun();
  const text = JSON.stringify(decisionAnswerViews(decision, result));
  assert.doesNotMatch(text, /NaN|Infinity|undefined/);
});
