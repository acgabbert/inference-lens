import assert from "node:assert/strict";
import test from "node:test";

import {
  loadRunHistoryFiles,
  summarizeRunTrace,
} from "../packages/core/src/run-history.ts";
import {
  createEntityId,
  createRunState,
  createRunTrace,
  reduceRunEvent,
} from "../packages/core/src/run-kernel/index.ts";
import type {
  ProviderTurnInput,
  ResolvedRunInput,
  RunEvent,
  RunEventMetadata,
  RunTrace,
} from "../packages/core/src/run-kernel/index.ts";
import { serializeRunTrace } from "../packages/core/src/run-trace.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";

type RunEventPayload = RunEvent extends infer Event
  ? Event extends RunEvent
    ? Omit<Event, keyof RunEventMetadata>
    : never
  : never;

function completedTrace(input: {
  suffix: string;
  model: string;
  startedAt: string;
}): RunTrace {
  const runId = createEntityId("run", input.suffix);
  const turnId = createEntityId("turn", input.suffix);
  const exchangeId = createEntityId("exchange", input.suffix);
  const target = {
    profileId: createEntityId("profile", "history"),
    protocol: "openai-compatible-chat-completions" as const,
    endpoint: "https://api.example.com/v1",
    model: input.model,
    capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
  };
  const messages = [
    {
      id: createEntityId("message", `${input.suffix}-user`),
      role: "user" as const,
      content: [{ type: "text" as const, text: "Hello" }],
    },
  ];
  const turnInput: ProviderTurnInput = {
    target,
    messages,
    options: {},
    tools: [],
  };
  const resolvedInput: ResolvedRunInput = {
    runId,
    conversationId: createEntityId("conversation", input.suffix),
    conversationRevisionId: createEntityId("revision", input.suffix),
    ...turnInput,
    resolvedAt: input.startedAt,
  };
  let sequence = 0;
  const event = (elapsedMs: number, payload: RunEventPayload): RunEvent => {
    const current = sequence++;
    return {
      eventId: createEntityId("event", `${input.suffix}-${current}`),
      runId,
      sequence: current,
      occurredAt: new Date(Date.parse(input.startedAt) + elapsedMs).toISOString(),
      elapsedMs,
      ...payload,
    } as RunEvent;
  };
  const events = [
    event(0, { type: "run.started", input: resolvedInput }),
    event(0, {
      type: "turn.started",
      turnId,
      attempt: 1,
      exchangeId,
      input: turnInput,
    }),
    event(50, {
      type: "exchange.requested",
      turnId,
      attempt: 1,
      exchangeId,
      request: {
        url: "https://api.example.com/v1/chat/completions",
        method: "POST",
        headers: {},
      },
    }),
    event(100, {
      type: "assistant.text_delta",
      turnId,
      attempt: 1,
      exchangeId,
      text: "Hello",
    }),
    event(500, {
      type: "usage.reported",
      turnId,
      attempt: 1,
      exchangeId,
      usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
    }),
    event(500, {
      type: "assistant.completed",
      turnId,
      attempt: 1,
      exchangeId,
      finishReason: { normalized: "stop" },
    }),
    event(550, { type: "run.completed" }),
  ];
  const state = events.reduce(reduceRunEvent, createRunState(runId));
  return createRunTrace(state);
}

test("derives a compact history summary from canonical trace evidence", () => {
  const trace = completedTrace({
    suffix: "history-summary",
    model: "example-model",
    startedAt: "2026-07-25T12:00:00.000Z",
  });

  assert.deepEqual(summarizeRunTrace(trace), {
    runId: createEntityId("run", "history-summary"),
    startedAt: "2026-07-25T12:00:00.000Z",
    endedAt: "2026-07-25T12:00:00.550Z",
    status: "completed",
    model: "example-model",
    durationMs: 550,
    usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
    turnCount: 1,
    attemptCount: 1,
    retryCount: 0,
    messageCount: 1,
  });
});

test("loads newest traces first and skips invalid artifacts independently", async () => {
  const older = completedTrace({
    suffix: "history-older",
    model: "older-model",
    startedAt: "2026-07-24T12:00:00.000Z",
  });
  const newer = completedTrace({
    suffix: "history-newer",
    model: "newer-model",
    startedAt: "2026-07-25T12:00:00.000Z",
  });
  const result = loadRunHistoryFiles([
    { fileName: "older.json", contents: serializeRunTrace(older) },
    { fileName: "broken.json", contents: "{not json" },
    { fileName: "newer.json", contents: serializeRunTrace(newer) },
  ]);

  assert.deepEqual(
    result.items.map(({ summary }) => summary.model),
    ["newer-model", "older-model"],
  );
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.fileName, "broken.json");
  assert.match(result.failures[0]?.message ?? "", /not valid JSON/);
});
