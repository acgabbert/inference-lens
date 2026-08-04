import assert from "node:assert/strict";
import test from "node:test";

import type { ToolExecutionRecord } from "../packages/core/src/run-kernel/index.ts";
import {
  describeToolExecution,
  latestToolExecution,
} from "../app/tool-execution-format.client.ts";

const base: ToolExecutionRecord = {
  id: "tool-execution_weather-1-1",
  turnId: "turn_1",
  toolCallId: "tool-call_weather-1",
  executor: { kind: "mock", executorId: "tool-mock_sunny", label: "sunny default" },
  status: "completed",
  startedAt: "2026-08-04T12:00:00.000Z",
  startedElapsedMs: 120,
  endedAt: "2026-08-04T12:00:00.003Z",
  durationMs: 3,
  content: [{ type: "text", text: "72°F and clear" }],
  projection: { projectedParts: [] },
  isError: false,
};

/**
 * The three strings a formatting or divide-by-zero bug looks like once it
 * reaches a user. Worth asserting here as well as in the browser, because this
 * text is assembled from optional fields.
 */
function scanForPlaceholders(value: string): string[] {
  return value.match(/NaN|Infinity|undefined|null|\[object/g) ?? [];
}

test("names the executor that produced a result, with its duration", () => {
  const summary = describeToolExecution(base);
  assert.equal(summary.pill, "Resolved by mock");
  assert.equal(summary.detail, "Returned by mock “sunny default” in 3 ms.");
  assert.equal(summary.projectionNote, undefined);
  assert.deepEqual(scanForPlaceholders(summary.detail), []);
});

test("an unlabelled binding still names its kind", () => {
  const summary = describeToolExecution({
    ...base,
    executor: { kind: "command", executorId: "binding_local" },
  });
  assert.equal(summary.detail, "Returned by command tool in 3 ms.");
  assert.deepEqual(scanForPlaceholders(summary.detail), []);
});

test("a tool-reported error reads differently from a failed execution", () => {
  const reported = describeToolExecution({ ...base, isError: true });
  assert.equal(reported.pill, "Tool reported an error");
  assert.match(reported.detail, /^Error returned by mock/);

  const failed = describeToolExecution({
    ...base,
    status: "failed",
    content: undefined,
    projection: undefined,
    isError: undefined,
    failure: { kind: "timeout", message: "No response after 30s." },
  });
  assert.equal(failed.pill, "Execution failed");
  assert.equal(
    failed.detail,
    "Timed out after running mock “sunny default” in 3 ms. No response after 30s.",
  );
  assert.deepEqual(scanForPlaceholders(failed.detail), []);
});

test("an in-flight execution reports itself without inventing a duration", () => {
  const summary = describeToolExecution({
    ...base,
    status: "executing",
    endedAt: undefined,
    durationMs: undefined,
    content: undefined,
    projection: undefined,
    isError: undefined,
  });
  assert.equal(summary.pill, "Executing");
  assert.equal(summary.detail, "Running mock “sunny default”…");
  assert.deepEqual(scanForPlaceholders(summary.detail), []);
});

test("projected content is disclosed rather than left to be noticed", () => {
  const summary = describeToolExecution({
    ...base,
    content: [
      { type: "text", text: "[image content not sent — image/png]" },
    ],
    projection: {
      projectedParts: [
        {
          type: "image",
          mimeType: "image/png",
          placeholder: "[image content not sent — image/png]",
        },
      ],
    },
  });
  assert.equal(
    summary.projectionNote,
    "1 part was replaced with placeholder text before the model saw this result: [image content not sent — image/png]",
  );
  assert.deepEqual(scanForPlaceholders(summary.projectionNote!), []);
});

test("a call reads its most recent execution, not its first", () => {
  const retried: ToolExecutionRecord = {
    ...base,
    id: "tool-execution_weather-1-2",
    durationMs: 9,
  };
  assert.equal(
    latestToolExecution(
      [{ ...base, status: "failed" }, retried],
      "tool-call_weather-1",
    )?.id,
    "tool-execution_weather-1-2",
  );
  assert.equal(latestToolExecution([base], "tool-call_other"), undefined);
});
