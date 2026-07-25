"use client";

import type { InferenceRequest, RichInferenceRequest } from "../packages/core/src/types.ts";
import {
  createEntityId,
  createSingleTurnRunExecution,
  createRunEventFactory,
  createRunState,
  reduceRunEvent,
} from "../packages/core/src/run-kernel/index.ts";
import type {
  RunEvent,
  RunConversationIdentity,
  RunState,
} from "../packages/core/src/run-kernel/index.ts";

function isTerminal(state: RunState): boolean {
  return (
    state.status.kind === "completed" ||
    state.status.kind === "cancelled" ||
    state.status.kind === "failed"
  );
}

function newFailedRunState(
  request: InferenceRequest | RichInferenceRequest,
  identity: RunConversationIdentity,
  message: string,
): RunState {
  const execution = createSingleTurnRunExecution(request, identity);
  const factory = createRunEventFactory(execution.runId);
  let state = createRunState(execution.runId);
  state = reduceRunEvent(
    state,
    factory.create({ type: "run.started", input: execution.input }),
  );
  return reduceRunEvent(
    state,
    factory.create({
      type: "run.failed",
      error: { code: "internal_error", message },
    }),
  );
}

/**
 * Records a client-boundary failure without discarding events that were
 * already projected successfully. A terminal run remains authoritative.
 */
export function preserveRunFailure(
  current: RunState | null,
  request: InferenceRequest | RichInferenceRequest,
  identity: RunConversationIdentity,
  message: string,
  occurredAt = new Date().toISOString(),
): RunState {
  if (!current?.input) return newFailedRunState(request, identity, message);
  if (isTerminal(current)) return current;

  const lastElapsedMs = current.events.at(-1)?.elapsedMs ?? 0;
  const elapsedMs = current.startedAt
    ? Math.max(
        lastElapsedMs,
        Date.parse(occurredAt) - Date.parse(current.startedAt),
      )
    : lastElapsedMs;
  const failure: RunEvent = {
    eventId: createEntityId(
      "event",
      `client-failure-${crypto.randomUUID()}`,
    ),
    runId: current.runId,
    sequence: current.lastSequence + 1,
    occurredAt,
    elapsedMs,
    type: "run.failed",
    error: { code: "internal_error", message },
  };
  return reduceRunEvent(current, failure);
}
