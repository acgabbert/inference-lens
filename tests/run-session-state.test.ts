import assert from "node:assert/strict";
import test from "node:test";

import {
  isRetryableTransportFailure,
  isTerminalRunState,
} from "../app/features/run-session/run-session-state.client.ts";
import type { RunState } from "../packages/core/src/run-kernel/index.ts";

test("classifies protocol, transient HTTP, and permanent HTTP failures", () => {
  assert.equal(isRetryableTransportFailure(new SyntaxError("bad frame")), false);
  assert.equal(isRetryableTransportFailure(new Error("timeout"), 408), true);
  assert.equal(isRetryableTransportFailure(new Error("rate limit"), 429), true);
  assert.equal(isRetryableTransportFailure(new Error("server"), 503), true);
  assert.equal(isRetryableTransportFailure(new Error("bad request"), 400), false);
});

test("recognizes only terminal run states", () => {
  const base = { runId: "run_test", events: [], turns: [], exchanges: {}, toolResults: [], lastSequence: 0 } as unknown as Omit<RunState, "status">;
  assert.equal(isTerminalRunState({ ...base, status: { kind: "running", turnId: "turn_test", attempt: 1, exchangeId: "exchange_test" } }), false);
  assert.equal(isTerminalRunState({ ...base, status: { kind: "completed", completedAt: "2026-07-27T00:00:00.000Z" } }), true);
  assert.equal(isTerminalRunState({ ...base, status: { kind: "failed", failedAt: "2026-07-27T00:00:00.000Z", error: { code: "internal_error", message: "failed" } } }), true);
});
