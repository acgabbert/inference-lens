import assert from "node:assert/strict";
import test from "node:test";

import { createRunState } from "../packages/core/src/run-kernel/index.ts";
import type { RunState } from "../packages/core/src/run-kernel/index.ts";
import {
  executableBinding,
  isRetryableRunState,
  isTerminalRunState,
  toolResultDraftsForState,
} from "../app/run/run-session-state.client.ts";

test("classifies terminal and retryable session states", () => {
  const base = createRunState("run_policy");
  assert.equal(isTerminalRunState(base), false);
  assert.equal(isRetryableRunState(base), false);

  const failed = {
    ...base,
    status: { kind: "failed", error: { code: "internal_error", message: "no" } },
  } as RunState;
  assert.equal(isTerminalRunState(failed), true);

  const retryable = {
    ...base,
    status: {
      kind: "paused",
      reason: "attempt_failed",
      turnId: "turn_policy",
      attempt: 1,
      exchangeId: "exchange_policy",
      error: { code: "transport_error", message: "try again", retryable: true },
    },
  } as RunState;
  assert.equal(isRetryableRunState(retryable), true);
});

test("derives manual and mocked drafts only for pending calls", () => {
  const state = {
    ...createRunState("run_drafts"),
    status: {
      kind: "awaiting_tool_results",
      turnId: "turn_drafts",
      pendingToolCallIds: ["tool-call_mock", "tool-call_manual"],
    },
    turns: [{
      turnId: "turn_drafts",
      attempts: [{
        completedToolCalls: [
          { id: "tool-call_mock", name: "weather", arguments: { text: "{}" } },
          { id: "tool-call_manual", name: "time", arguments: { text: "{}" } },
          { id: "tool-call_done", name: "time", arguments: { text: "{}" } },
        ],
      }],
    }],
  } as unknown as RunState;
  const tools = [
    { id: "tool_weather", name: "weather", inputSchema: {} },
    { id: "tool_time", name: "time", inputSchema: {} },
  ] as const;
  const drafts = toolResultDraftsForState(state, tools, (id) =>
    id === "tool_weather"
      ? { id: "tool-mock_weather", toolId: id, name: "weather", enabled: true, match: { kind: "always" }, result: { content: [{ type: "text", text: "sunny" }] } }
      : undefined,
  );
  // The binding is what makes the submitted value an execution, so an edited
  // draft has to stop offering one — otherwise the trace would record that a
  // mock returned text the user typed.
  const mocked = drafts["tool-call_mock"]!;
  assert.equal(executableBinding(mocked)?.executorId, "tool-mock_weather");
  assert.equal(executableBinding({ ...mocked, text: "rainy" }), undefined);
  assert.equal(executableBinding(drafts["tool-call_manual"]!), undefined);

  assert.deepEqual(drafts, {
    "tool-call_mock": {
      text: "sunny",
      prefilledText: "sunny",
      binding: {
        toolId: "tool_weather",
        kind: "mock",
        executorId: "tool-mock_weather",
        label: "weather",
        result: { content: [{ type: "text", text: "sunny" }] },
      },
      resolution: { kind: "mock", ruleId: "tool-mock_weather" },
    },
    "tool-call_manual": { text: "", resolution: { kind: "manual" } },
  });
});
