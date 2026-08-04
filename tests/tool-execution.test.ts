import assert from "node:assert/strict";
import test from "node:test";

import { createMockToolExecutor } from "../packages/core/src/mock-tool-executor.ts";
import {
  createEntityId,
  createRunTrace,
  RunCoordinator,
  RunInvariantError,
} from "../packages/core/src/run-kernel/index.ts";
import type {
  ResolvedRunInput,
  ToolDefinition,
  ToolExecutionOutcome,
} from "../packages/core/src/run-kernel/index.ts";
import {
  parseRunTraceJson,
  runStateFromTrace,
  serializeRunTrace,
} from "../packages/core/src/run-trace.ts";
import {
  executeToolCall,
  projectToolExecutionContent,
  resolveToolBinding,
  toolExecutorIdentity,
} from "../packages/core/src/tool-execution.ts";
import type {
  ToolBinding,
  ToolExecutor,
} from "../packages/core/src/tool-execution.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";

const runId = createEntityId("run", "executor-test");
const toolId = createEntityId("tool", "weather");
const callId = createEntityId("tool-call", "weather-1");

const weather: ToolDefinition = {
  id: toolId,
  name: "get_weather",
  inputSchema: { type: "object", properties: { city: { type: "string" } } },
};

const mockBinding: ToolBinding = {
  toolId,
  kind: "mock",
  executorId: "tool-mock_sunny",
  label: "sunny default",
  result: { content: [{ type: "text", text: "72°F and clear" }] },
};

const resolvedInput: ResolvedRunInput = {
  runId,
  conversationId: createEntityId("conversation", "executor-test"),
  conversationRevisionId: createEntityId("revision", "executor-test"),
  target: {
    profileId: createEntityId("profile", "openai"),
    protocol: "openai-compatible-chat-completions",
    endpoint: "https://api.example.com/v1",
    model: "example-model",
    capabilities: { ...OPENAI_COMPATIBLE_CAPABILITIES, tools: true },
  },
  messages: [
    {
      id: createEntityId("message", "user"),
      role: "user",
      content: [{ type: "text", text: "Weather in Chicago?" }],
    },
  ],
  templateResolutions: [],
  responseMode: "streaming",
  options: {},
  tools: [weather],
  resolvedAt: "2026-08-04T12:00:00.000Z",
};

/** Drives a run to the point where one call is waiting for a result. */
function awaitingRun(): RunCoordinator {
  const coordinator = new RunCoordinator(resolvedInput);
  coordinator.start();
  coordinator.accept({
    type: "tool_call_delta",
    toolCallId: callId,
    index: 0,
    providerCallId: "call_1",
    nameDelta: "get_weather",
    argumentsDelta: '{"city":"Chicago"}',
  });
  coordinator.accept({
    type: "completed",
    finishReason: { normalized: "tool_calls", raw: "tool_calls" },
  });
  coordinator.finishTurnStream();
  return coordinator;
}

function invocation(coordinator: RunCoordinator) {
  const call = coordinator.state.turns
    .at(-1)!
    .attempts.at(-1)!
    .completedToolCalls!.at(0)!;
  return { toolCallId: call.id, tool: weather, call };
}

function executorReturning(outcome: ToolExecutionOutcome): ToolExecutor {
  return { kind: "command", execute: () => Promise.resolve(outcome) };
}

test("a binding is projected to secret-free executor identity", () => {
  const secretive = {
    ...mockBinding,
    // Stand-in for the executable path, endpoint, or credential reference a
    // real binding will carry. None of it may reach a trace.
    result: { content: [{ type: "text" as const, text: "sk-live-do-not-log" }] },
  };
  const identity = toolExecutorIdentity(secretive);
  assert.deepEqual(identity, {
    kind: "mock",
    executorId: "tool-mock_sunny",
    label: "sunny default",
  });
  assert.deepEqual(Object.keys(identity).sort(), [
    "executorId",
    "kind",
    "label",
  ]);
  assert.equal(
    resolveToolBinding([mockBinding], toolId)?.executorId,
    "tool-mock_sunny",
  );
  assert.equal(
    resolveToolBinding([mockBinding], createEntityId("tool", "other")),
    undefined,
  );
});

test("non-text content becomes visible placeholder text, never a silent drop", () => {
  const projected = projectToolExecutionContent([
    { type: "text", text: "Here is the chart." },
    { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
    { type: "resource", uri: "file:///tmp/report.csv", mimeType: "text/csv" },
  ]);
  assert.deepEqual(projected.content, [
    { type: "text", text: "Here is the chart." },
    { type: "text", text: "[image content not sent — image/png]" },
    { type: "text", text: "[resource content not sent — file:///tmp/report.csv]" },
  ]);
  assert.equal(projected.projection.projectedParts.length, 2);
  assert.deepEqual(projected.projection.projectedParts[0], {
    type: "image",
    mimeType: "image/png",
    placeholder: "[image content not sent — image/png]",
  });
  // The base64 payload is held in memory only; it must not survive projection.
  assert.equal(
    JSON.stringify(projected).includes("iVBORw0KGgo="),
    false,
  );
  assert.deepEqual(projectToolExecutionContent([]), {
    content: [],
    projection: { projectedParts: [] },
  });
});

test("a mock execution records ordered evidence and its provenance", async () => {
  const coordinator = awaitingRun();
  const before = coordinator.state.lastSequence;
  const attempt = await executeToolCall(
    coordinator,
    createMockToolExecutor(mockBinding),
    mockBinding,
    invocation(coordinator),
  );

  assert.deepEqual(
    attempt.events.map(({ type }) => type),
    ["tool.execution_started", "tool.execution_completed"],
  );
  assert.deepEqual(
    attempt.events.map(({ sequence }) => sequence),
    [before + 1, before + 2],
  );
  assert.equal(attempt.executionId, "tool-execution_weather-1-1");

  const record = coordinator.state.toolExecutions.at(0)!;
  assert.equal(record.status, "completed");
  assert.equal(record.toolCallId, callId);
  assert.deepEqual(record.executor, {
    kind: "mock",
    executorId: "tool-mock_sunny",
    label: "sunny default",
  });
  assert.deepEqual(record.content, [{ type: "text", text: "72°F and clear" }]);
  assert.deepEqual(record.projection, { projectedParts: [] });
  assert.equal(record.isError, false);
  assert.equal(typeof record.durationMs, "number");
  assert.ok(record.durationMs! >= 0);
  assert.ok(Date.parse(record.endedAt!) >= Date.parse(record.startedAt));

  // The pause is unchanged: an execution produces evidence, not a result.
  assert.equal(coordinator.state.status.kind, "awaiting_tool_results");
  assert.deepEqual(coordinator.state.toolResults, []);
});

test("a tool that reports an error is a completed execution", async () => {
  const coordinator = awaitingRun();
  const failing: ToolBinding = {
    ...mockBinding,
    result: { content: [{ type: "text", text: "City not found." }], isError: true },
  };
  await executeToolCall(
    coordinator,
    createMockToolExecutor(failing),
    failing,
    invocation(coordinator),
  );
  const record = coordinator.state.toolExecutions.at(0)!;
  assert.equal(record.status, "completed");
  assert.equal(record.isError, true);
  assert.equal(record.failure, undefined);
});

test("every failure kind reaches the run state under its own classification", async () => {
  for (const kind of [
    "execution_failed",
    "invalid_result",
    "timeout",
    "cancelled",
    "rejected",
  ] as const) {
    const coordinator = awaitingRun();
    const attempt = await executeToolCall(
      coordinator,
      executorReturning({
        status: "failed",
        failure: { kind, message: `${kind} happened` },
      }),
      mockBinding,
      invocation(coordinator),
    );
    assert.deepEqual(
      attempt.events.map(({ type }) => type),
      ["tool.execution_started", "tool.execution_failed"],
    );
    const record = coordinator.state.toolExecutions.at(0)!;
    assert.equal(record.status, "failed");
    assert.equal(record.failure?.kind, kind);
    assert.equal(record.content, undefined);
    // A failed execution leaves the call waiting rather than fabricating a
    // result: a transport failure is not something the model should be told
    // the tool said.
    assert.equal(coordinator.state.status.kind, "awaiting_tool_results");
    assert.deepEqual(coordinator.state.toolResults, []);
  }
});

test("an executor that throws is classified rather than left open", async () => {
  const coordinator = awaitingRun();
  const attempt = await executeToolCall(
    coordinator,
    { kind: "command", execute: () => Promise.reject(new Error("spawn ENOENT")) },
    mockBinding,
    invocation(coordinator),
  );
  assert.equal(attempt.outcome.status, "failed");
  const record = coordinator.state.toolExecutions.at(0)!;
  assert.equal(record.status, "failed");
  assert.deepEqual(record.failure, {
    kind: "execution_failed",
    message: "spawn ENOENT",
  });
});

test("a thrown execution under an aborted signal is a cancellation", async () => {
  const coordinator = awaitingRun();
  const controller = new AbortController();
  controller.abort();
  await executeToolCall(
    coordinator,
    { kind: "command", execute: () => Promise.reject(new Error("aborted")) },
    mockBinding,
    invocation(coordinator),
    { signal: controller.signal },
  );
  assert.equal(
    coordinator.state.toolExecutions.at(0)?.failure?.kind,
    "cancelled",
  );
});

test("a failed execution may be retried; a live one may not", async () => {
  const coordinator = awaitingRun();
  await executeToolCall(
    coordinator,
    executorReturning({
      status: "failed",
      failure: { kind: "timeout", message: "took too long" },
    }),
    mockBinding,
    invocation(coordinator),
  );
  const second = await executeToolCall(
    coordinator,
    createMockToolExecutor(mockBinding),
    mockBinding,
    invocation(coordinator),
  );
  assert.equal(second.executionId, "tool-execution_weather-1-2");
  assert.equal(coordinator.state.toolExecutions.length, 2);

  assert.throws(
    () =>
      coordinator.startToolExecution({
        toolCallId: callId,
        executor: toolExecutorIdentity(mockBinding),
      }),
    RunInvariantError,
  );
});

test("a result cannot be supplied while its execution is still open", () => {
  const coordinator = awaitingRun();
  coordinator.startToolExecution({
    toolCallId: callId,
    executor: toolExecutorIdentity(mockBinding),
  });
  assert.throws(
    () =>
      coordinator.supplyToolResults([
        {
          id: createEntityId("tool-result", "premature"),
          toolCallId: callId,
          content: [{ type: "text", text: "guessing" }],
          resolution: { kind: "manual" },
        },
      ]),
    RunInvariantError,
  );
});

test("an execution outside a tool pause is refused", () => {
  const coordinator = new RunCoordinator(resolvedInput);
  coordinator.start();
  assert.throws(
    () =>
      coordinator.startToolExecution({
        toolCallId: callId,
        executor: toolExecutorIdentity(mockBinding),
      }),
    /not awaiting tool results/,
  );
});

test("execution evidence survives a trace round trip and carries no binding config", async () => {
  const coordinator = awaitingRun();
  await executeToolCall(
    coordinator,
    createMockToolExecutor(mockBinding),
    mockBinding,
    invocation(coordinator),
  );
  coordinator.supplyToolResults([
    {
      id: createEntityId("tool-result", "weather"),
      toolCallId: callId,
      content: coordinator.state.toolExecutions.at(0)!.content!,
      resolution: { kind: "mock", ruleId: mockBinding.executorId },
    },
  ]);
  coordinator.continue();
  coordinator.accept({ type: "text_delta", text: "It is 72°F in Chicago." });
  coordinator.accept({
    type: "completed",
    finishReason: { normalized: "stop", raw: "stop" },
  });
  coordinator.finishTurnStream();

  const trace = createRunTrace(coordinator.state);
  assert.equal(trace.schemaVersion, 6);
  const serialized = serializeRunTrace(trace);

  // The golden property: what a binding *is* stays device-local; only what it
  // is called reaches the artifact.
  assert.match(serialized, /"executorId": "tool-mock_sunny"/);
  assert.match(serialized, /"label": "sunny default"/);
  assert.match(serialized, /"text": "72°F and clear"/);
  assert.equal(serialized.includes('"binding"'), false);
  // The portable descriptor is in the artifact; the device-local binding that
  // served it is not, beyond its identity.
  assert.match(serialized, /"id": "tool_weather"/);
  assert.equal(serialized.includes('"toolId"'), false);

  const parsed = parseRunTraceJson(serialized);
  assert.deepEqual(parsed.toolExecutions, trace.toolExecutions);
  assert.deepEqual(
    runStateFromTrace(parsed).toolExecutions,
    coordinator.state.toolExecutions,
  );
  assert.equal(serializeRunTrace(parsed), serialized);
});

test("a trace whose execution evidence disagrees with its events is rejected", async () => {
  const coordinator = awaitingRun();
  await executeToolCall(
    coordinator,
    createMockToolExecutor(mockBinding),
    mockBinding,
    invocation(coordinator),
  );
  coordinator.cancel("Stopped by user.");
  const trace = JSON.parse(serializeRunTrace(createRunTrace(coordinator.state)));
  trace.toolExecutions[0].executor.executorId = "tool-mock_something-else";
  assert.throws(
    () => parseRunTraceJson(JSON.stringify(trace)),
    /toolExecutions does not match its event stream/,
  );
});
