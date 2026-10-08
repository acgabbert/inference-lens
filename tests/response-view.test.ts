import assert from "node:assert/strict";
import test from "node:test";

import { displayStatus, responseContentOf } from "../app/run/response-view.ts";
import type {
  ExchangeId,
  ModelTurnAttemptState,
  RunError,
  RunId,
  RunState,
  RunStatus,
  ToolCall,
  ToolCallId,
  TurnId,
} from "../packages/core/src/run-kernel/types.ts";

const exchangeId = "exchange_a" as ExchangeId;
const turnId = "turn_a" as TurnId;
const error = { message: "boom" } as RunError;

function toolCall(id: string): ToolCall {
  return { id: id as ToolCallId, name: "lookup", arguments: { text: "{}" } };
}

function attempt(
  text: string,
  reasoning: string,
  completedToolCalls?: ToolCall[],
): ModelTurnAttemptState {
  return {
    attempt: 1,
    exchangeId,
    input: {} as ModelTurnAttemptState["input"],
    status: "completed",
    text,
    reasoning,
    toolCalls: [],
    ...(completedToolCalls ? { completedToolCalls } : {}),
  };
}

function state(status: RunStatus, turns: RunState["turns"] = []): RunState {
  return {
    runId: "run_a" as RunId,
    status,
    events: [],
    turns,
    exchanges: {},
    toolExecutions: [],
    toolResults: [],
    lastSequence: 0,
  };
}

test("display status maps each run status to what the response pane shows", () => {
  assert.equal(displayStatus(null), "idle");
  assert.equal(displayStatus(state({ kind: "not_started" })), "running");
  assert.equal(displayStatus(state({ kind: "starting" })), "running");
  assert.equal(displayStatus(state({ kind: "running", turnId, attempt: 1, exchangeId })), "running");
  assert.equal(
    displayStatus(state({ kind: "awaiting_tool_results", turnId, pendingToolCallIds: [] })),
    "waiting",
  );
  assert.equal(displayStatus(state({ kind: "paused", reason: "tool_results_ready" })), "waiting");
  assert.equal(
    displayStatus(state({ kind: "paused", reason: "attempt_failed", turnId, attempt: 1, exchangeId, error })),
    "failed",
  );
  assert.equal(displayStatus(state({ kind: "completed", completedAt: "t" })), "complete");
  assert.equal(displayStatus(state({ kind: "cancelled", cancelledAt: "t" })), "failed");
  assert.equal(displayStatus(state({ kind: "failed", failedAt: "t", error })), "failed");
});

test("no run shows empty idle content", () => {
  assert.deepEqual(responseContentOf(null), {
    output: "",
    reasoning: "",
    status: "idle",
    completedToolCalls: [],
  });
});

test("content joins the latest attempt of each turn and ignores superseded attempts", () => {
  const first = toolCall("call_1");
  const second = toolCall("call_2");
  const content = responseContentOf(state({ kind: "completed", completedAt: "t" }, [
    { turnId, attempts: [attempt("retried away ", "stale ", [toolCall("call_0")]), attempt("Hello, ", "think ", [first])] },
    { turnId: "turn_b" as TurnId, attempts: [] },
    { turnId: "turn_c" as TurnId, attempts: [attempt("world.", "more", [second])] },
    { turnId: "turn_d" as TurnId, attempts: [attempt("", "")] },
  ]));
  assert.deepEqual(content, {
    output: "Hello, world.",
    reasoning: "think more",
    status: "complete",
    completedToolCalls: [first, second],
  });
});
