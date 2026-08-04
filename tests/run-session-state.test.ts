import assert from "node:assert/strict";
import test from "node:test";

import { createRunState } from "../packages/core/src/run-kernel/index.ts";
import type { RunState } from "../packages/core/src/run-kernel/index.ts";
import {
  executableBinding,
  isRetryableRunState,
  isTerminalRunState,
  toolBindingFor,
  toolBindingForMock,
  toolResultDraftsForState,
} from "../app/run/run-session-state.client.ts";
import type { ToolMock } from "../packages/core/src/project.ts";
import type { ToolId } from "../packages/core/src/run-kernel/index.ts";

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

const weatherMock: ToolMock = {
  id: "tool-mock_weather",
  toolId: "tool_weather" as ToolId,
  name: "weather",
  enabled: true,
  match: { kind: "always" },
  result: { content: [{ type: "text", text: "sunny" }] },
};

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

test("derives manual and mocked drafts only for pending calls", () => {
  const drafts = toolResultDraftsForState(state, tools, (id) =>
    toolBindingForMock(id, id === "tool_weather" ? weatherMock : undefined),
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

test("a command binding outranks an enabled mock, and prefills nothing", () => {
  const commandBinding = {
    toolId: "tool_weather" as ToolId,
    kind: "command" as const,
    executorId: "weather",
    label: "Local weather script",
    grantedAt: "2026-08-04T10:00:00.000Z",
  };

  // Both are configured. The grant is a deliberate act on this device; the
  // mock arrived with the project and is often left switched on.
  assert.deepEqual(
    toolBindingFor("tool_weather" as ToolId, weatherMock, commandBinding),
    commandBinding,
  );
  assert.equal(
    toolBindingFor("tool_weather" as ToolId, weatherMock, undefined)?.kind,
    "mock",
  );

  const drafts = toolResultDraftsForState(state, tools, (id) =>
    id === "tool_weather" ? commandBinding : undefined,
  );

  // Nothing is prefilled: the command has not run. A placeholder here would be
  // indistinguishable from a result it produced.
  assert.deepEqual(drafts["tool-call_mock"], {
    text: "",
    prefilledText: "",
    binding: commandBinding,
    pendingExecutorLabel: "Local weather script",
    resolution: { kind: "live", executorId: "weather" },
  });
  // An empty draft still executes; typing into it makes the answer the user's.
  assert.equal(executableBinding(drafts["tool-call_mock"]!)?.kind, "command");
  assert.equal(
    executableBinding({ ...drafts["tool-call_mock"]!, text: "typed" }),
    undefined,
  );
});
