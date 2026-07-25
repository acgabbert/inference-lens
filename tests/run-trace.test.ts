import assert from "node:assert/strict";
import test from "node:test";

import {
  createResolvedRunInput,
} from "../packages/core/src/run-kernel/run-execution.ts";
import { RunCoordinator } from "../packages/core/src/run-kernel/coordinator.ts";
import { createRunTrace } from "../packages/core/src/run-kernel/reducer.ts";
import type { RunTrace } from "../packages/core/src/run-kernel/types.ts";
import {
  parseRunTraceJson,
  runStateFromTrace,
  serializeRunTrace,
  traceFileName,
} from "../packages/core/src/run-trace.ts";

function completedTrace(): RunTrace {
  const input = createResolvedRunInput(
    {
      provider: "openai-compatible",
      endpoint: "https://api.example.com/v1",
      model: "example-model",
      messages: [{ role: "user", content: "Hello" }],
    },
    [],
    "trace-test",
    "2026-07-24T12:00:00.000Z",
  );
  const coordinator = new RunCoordinator(input);
  const { execution } = coordinator.start();
  coordinator.accept({
    type: "request",
    request: {
      url: "https://api.example.com/v1/chat/completions",
      method: "POST",
      headers: {
        authorization: "Bearer ••••••••",
        "content-type": "application/json",
      },
      body: '{"model":"example-model","stream":true}',
    },
  });
  coordinator.accept({
    type: "response_started",
    response: {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  });
  coordinator.accept({
    type: "frame",
    frame: {
      index: 0,
      raw: 'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}',
    },
  });
  coordinator.accept({
    type: "text_delta",
    text: "Hi",
    source: { exchangeId: execution.exchangeId, frameIndex: 0 },
  });
  coordinator.accept({
    type: "completed",
    finishReason: { normalized: "stop", raw: "stop" },
    source: { exchangeId: execution.exchangeId, frameIndex: 0 },
  });
  coordinator.finishTurnStream();
  return createRunTrace(coordinator.state);
}

test("serializes and parses a deterministic run trace", () => {
  const trace = completedTrace();
  const serialized = serializeRunTrace(trace);
  assert.deepEqual(parseRunTraceJson(serialized), trace);
  assert.equal(serializeRunTrace(parseRunTraceJson(serialized)), serialized);
  assert.deepEqual(runStateFromTrace(trace).events, trace.events);
  assert.match(serialized, /"raw": "data: \{/);
  assert.match(serialized, /"body": "\{\\"model\\"/);
});

test("rejects a trace whose projection disagrees with its events", () => {
  const trace = structuredClone(completedTrace());
  trace.turns[0].attempts[0].text = "tampered";
  assert.throws(
    () => serializeRunTrace(trace),
    /turns does not match its event stream/,
  );
});

test("rejects unsafe trace filenames", () => {
  assert.equal(traceFileName("run_safe-1"), "run_safe-1.json");
  assert.throws(
    () => traceFileName("run_../../secret" as `run_${string}`),
    /cannot be used as a trace filename/,
  );
});
