import assert from "node:assert/strict";
import test from "node:test";

import { createCommandToolExecutor } from "../app/tools/command-tool-executor.client.ts";
import type { CommandToolExecutionRequest } from "../packages/contracts/src/index.ts";
import type { ToolCall, ToolDefinition } from "../packages/core/src/run-kernel/index.ts";
import type { ToolInvocation } from "../packages/core/src/tool-execution.ts";

const binding = {
  kind: "command" as const,
  executorId: "weather",
  label: "Local weather script",
  grantedAt: "2026-08-04T10:00:00.000Z",
};

const invocation: ToolInvocation = {
  toolCallId: "tool-call_1",
  tool: { id: "tool_weather", name: "get_weather", inputSchema: {} } as ToolDefinition,
  call: {
    id: "tool-call_1",
    name: "get_weather",
    arguments: { text: '{"city":"Chicago"}' },
  } as ToolCall,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("the call is sent by command id, never by executable", async () => {
  let sent: CommandToolExecutionRequest | undefined;
  const executor = createCommandToolExecutor(binding, {
    fetchImpl: async (_input, init) => {
      sent = JSON.parse(String(init?.body)) as CommandToolExecutionRequest;
      return jsonResponse({
        status: "completed",
        content: [{ type: "text", text: "61F" }],
        isError: false,
      });
    },
  });

  const outcome = await executor.execute(invocation, {});

  assert.deepEqual(sent, {
    commandId: "weather",
    tool: "get_weather",
    toolCallId: "tool-call_1",
    arguments: '{"city":"Chicago"}',
  });
  assert.deepEqual(outcome, {
    status: "completed",
    content: [{ type: "text", text: "61F" }],
    isError: false,
  });
});

test("a normalized failure from the service is passed through unchanged", async () => {
  const executor = createCommandToolExecutor(binding, {
    fetchImpl: async () =>
      jsonResponse({
        status: "failed",
        failure: { kind: "timeout", message: "did not finish" },
      }),
  });

  const outcome = await executor.execute(invocation, {});

  assert.equal(outcome.status === "failed" && outcome.failure.kind, "timeout");
});

/**
 * A transport that never answered and a tool that never started are the same
 * fact from the run's point of view: no result exists. Neither may invent one.
 */
test("transport trouble is classified, not thrown", async () => {
  const refused = createCommandToolExecutor(binding, {
    fetchImpl: async () => jsonResponse({ error: "Cross-origin API requests are not allowed." }, 403),
  });
  const refusedOutcome = await refused.execute(invocation, {});
  assert.equal(
    refusedOutcome.status === "failed" && refusedOutcome.failure.kind,
    "execution_failed",
  );
  assert.match(
    refusedOutcome.status === "failed" ? refusedOutcome.failure.message : "",
    /Cross-origin/,
  );

  const unreachable = createCommandToolExecutor(binding, {
    fetchImpl: async () => {
      throw new Error("Failed to fetch");
    },
  });
  const unreachableOutcome = await unreachable.execute(invocation, {});
  assert.match(
    unreachableOutcome.status === "failed" ? unreachableOutcome.failure.message : "",
    /Failed to fetch/,
  );

  const nonsense = createCommandToolExecutor(binding, {
    fetchImpl: async () => jsonResponse({ ok: true }),
  });
  const nonsenseOutcome = await nonsense.execute(invocation, {});
  assert.equal(
    nonsenseOutcome.status === "failed" && nonsenseOutcome.failure.kind,
    "execution_failed",
  );
});

test("cancellation is reported as cancellation, before and during the request", async () => {
  const controller = new AbortController();
  controller.abort();
  const early = await createCommandToolExecutor(binding, {
    fetchImpl: async () => {
      assert.fail("should not have been sent");
    },
  }).execute(invocation, { signal: controller.signal });
  assert.equal(early.status === "failed" && early.failure.kind, "cancelled");

  const midflight = new AbortController();
  const outcome = await createCommandToolExecutor(binding, {
    fetchImpl: async () => {
      midflight.abort();
      throw new DOMException("The user aborted a request.", "AbortError");
    },
  }).execute(invocation, { signal: midflight.signal });
  assert.equal(outcome.status === "failed" && outcome.failure.kind, "cancelled");
});
