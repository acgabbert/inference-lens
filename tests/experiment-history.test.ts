import assert from "node:assert/strict";
import test from "node:test";

import {
  LARGE_HISTORY_ARTIFACT_WARNING_THRESHOLD,
  loadProjectHistoryFiles,
} from "../packages/core/src/experiment-history.ts";
import {
  serializeExperimentPlan,
  serializeExperimentResult,
  type ExperimentResultV1,
  type RepeatedExperimentPlanV1,
} from "../packages/core/src/experiment.ts";
import {
  createEntityId,
  createRunState,
  createRunTrace,
  reduceRunEvent,
} from "../packages/core/src/run-kernel/index.ts";
import type { RunEvent } from "../packages/core/src/run-kernel/index.ts";
import { serializeRunTrace } from "../packages/core/src/run-trace.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";

function plan(suffix: string, createdAt = "2026-07-31T12:00:00.000Z"): RepeatedExperimentPlanV1 {
  const experimentId = createEntityId("experiment", suffix);
  return {
    schemaVersion: 2,
    experimentId,
    kind: "repeated-request",
    createdAt,
    commonInput: {
      conversationId: createEntityId("conversation", suffix),
      conversationRevisionId: createEntityId("revision", suffix),
      target: {
        profileId: createEntityId("profile", suffix),
        protocol: "openai-compatible-chat-completions",
        endpoint: "https://provider.example.test/v1",
        model: `${suffix}-model`,
        capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
      },
      messages: [{
        id: createEntityId("message", suffix),
        role: "user",
        content: [{ type: "text", text: "Repeat this" }],
      }],
      templateResolutions: [],
      responseMode: "streaming",
      options: {},
      tools: [],
      resolvedAt: createdAt,
    },
    cells: [1, 2].map((ordinal) => ({
      cellId: createEntityId("experiment-cell", `${suffix}-${ordinal}`),
      ordinal,
      runId: createEntityId("run", `${suffix}-${ordinal}`),
    })),
  };
}

function planSource(value: RepeatedExperimentPlanV1) {
  return {
    fileName: `${value.experimentId}.plan.json`,
    contents: serializeExperimentPlan(value),
  };
}

function completedTraceSource(value: RepeatedExperimentPlanV1, ordinal: number) {
  const cell = value.cells[ordinal - 1]!;
  const input = { ...value.commonInput, runId: cell.runId };
  const turnId = createEntityId("turn", `${cell.runId}-turn`);
  const exchangeId = createEntityId("exchange", `${cell.runId}-exchange`);
  const turnInput = {
    target: value.commonInput.target,
    messages: value.commonInput.messages,
    responseMode: value.commonInput.responseMode,
    options: value.commonInput.options,
    tools: value.commonInput.tools,
  };
  const events: RunEvent[] = [
    {
      eventId: createEntityId("event", `${cell.runId}-started`),
      runId: cell.runId,
      sequence: 0,
      occurredAt: value.createdAt,
      elapsedMs: 0,
      type: "run.started",
      input,
    },
    {
      eventId: createEntityId("event", `${cell.runId}-turn`),
      runId: cell.runId,
      sequence: 1,
      occurredAt: value.createdAt,
      elapsedMs: 0,
      type: "turn.started",
      turnId,
      attempt: 1,
      exchangeId,
      input: turnInput,
    },
    {
      eventId: createEntityId("event", `${cell.runId}-request`),
      runId: cell.runId,
      sequence: 2,
      occurredAt: value.createdAt,
      elapsedMs: 0,
      type: "exchange.requested",
      turnId,
      attempt: 1,
      exchangeId,
      request: {
        url: "https://provider.example.test/v1/chat/completions",
        method: "POST",
        headers: {},
      },
    },
    {
      eventId: createEntityId("event", `${cell.runId}-assistant`),
      runId: cell.runId,
      sequence: 3,
      occurredAt: new Date(Date.parse(value.createdAt) + 900).toISOString(),
      elapsedMs: 900,
      type: "assistant.completed",
      turnId,
      attempt: 1,
      exchangeId,
      finishReason: { normalized: "stop" },
    },
    {
      eventId: createEntityId("event", `${cell.runId}-completed`),
      runId: cell.runId,
      sequence: 4,
      occurredAt: new Date(Date.parse(value.createdAt) + 1_000).toISOString(),
      elapsedMs: 1_000,
      type: "run.completed",
    },
  ];
  const state = events.reduce(reduceRunEvent, createRunState(cell.runId));
  return {
    fileName: `renamed-${cell.runId}.json`,
    contents: serializeRunTrace(createRunTrace(state)),
  };
}

test("groups completed experiments even when referenced traces are missing", () => {
  const value = plan("complete");
  const result: ExperimentResultV1 = {
    schemaVersion: 2,
    experimentId: value.experimentId,
    status: "completed",
    endedAt: "2026-07-31T12:01:00.000Z",
    cells: value.cells.map((cell) => ({
      cellId: cell.cellId,
      runId: cell.runId,
      status: "completed",
    })),
  };
  const loaded = loadProjectHistoryFiles([], [
    planSource(value),
    {
      fileName: `${value.experimentId}.result.json`,
      contents: serializeExperimentResult(result, value),
    },
  ]);

  assert.equal(loaded.entries.length, 1);
  assert.equal(loaded.experiments[0]?.lifecycle, "completed");
  assert.equal(loaded.experiments[0]?.missingTrace, 2);
  assert.equal(loaded.experiments[0]?.notRun, 0);
  assert.equal(loaded.failures.length, 0);
});

test("groups cancelled experiments with their unstarted cells", () => {
  const value = plan("cancelled");
  const result: ExperimentResultV1 = {
    schemaVersion: 2,
    experimentId: value.experimentId,
    status: "cancelled",
    endedAt: "2026-07-31T12:00:10.000Z",
    cells: [
      { cellId: value.cells[0]!.cellId, runId: value.cells[0]!.runId, status: "cancelled" },
      { cellId: value.cells[1]!.cellId, runId: value.cells[1]!.runId, status: "not-run" },
    ],
  };
  const loaded = loadProjectHistoryFiles([], [
    planSource(value),
    {
      fileName: `${value.experimentId}.result.json`,
      contents: serializeExperimentResult(result, value),
    },
  ]);

  assert.equal(loaded.experiments[0]?.lifecycle, "cancelled");
  assert.equal(loaded.experiments[0]?.missingTrace, 1);
  assert.equal(loaded.experiments[0]?.notRun, 1);
});

test("opens plans without results as interrupted and isolates damaged neighbors", () => {
  const healthy = plan("healthy");
  const damaged = plan("damaged", "2026-07-31T13:00:00.000Z");
  const loaded = loadProjectHistoryFiles([], [
    planSource(healthy),
    { ...planSource(damaged), contents: "{not json" },
    { fileName: "experiment_orphan.result.json", contents: "{}" },
  ]);

  assert.equal(loaded.experiments.length, 1);
  assert.equal(loaded.experiments[0]?.lifecycle, "interrupted");
  assert.equal(loaded.experiments[0]?.notRun, 2);
  assert.deepEqual(
    loaded.failures.map((failure) => failure.fileName).sort(),
    ["experiment_damaged.plan.json", "experiment_orphan.result.json"],
  );
});

test("an interrupted plan shows terminal cells and groups their ordinary traces", () => {
  const value = plan("partial");
  const loaded = loadProjectHistoryFiles(
    [completedTraceSource(value, 1)],
    [planSource(value)],
  );

  assert.equal(loaded.entries.length, 1);
  assert.equal(loaded.entries[0]?.kind, "experiment");
  assert.equal(loaded.runs.length, 0);
  assert.equal(loaded.experiments[0]?.completed, 1);
  assert.equal(loaded.experiments[0]?.notRun, 1);
  assert.equal(
    loaded.experiments[0]?.cells[0]?.traceFileName,
    `renamed-${value.cells[0]?.runId}.json`,
  );
});

test("a damaged result leaves its valid plan independently openable", () => {
  const value = plan("bad-result");
  const loaded = loadProjectHistoryFiles([], [
    planSource(value),
    { fileName: `${value.experimentId}.result.json`, contents: "{}" },
  ]);

  assert.equal(loaded.experiments[0]?.lifecycle, "interrupted");
  assert.equal(loaded.experiments[0]?.resultFileName, undefined);
  assert.equal(loaded.failures[0]?.fileName, `${value.experimentId}.result.json`);
});

test("large history is warned about without removing entries", () => {
  const value = plan("large");
  const traceFiles = Array.from(
    { length: LARGE_HISTORY_ARTIFACT_WARNING_THRESHOLD - 1 },
    (_, index) => ({ fileName: `damaged-${index}.json`, contents: "{}" }),
  );
  const loaded = loadProjectHistoryFiles(traceFiles, [planSource(value)]);

  assert.equal(loaded.artifactCount, LARGE_HISTORY_ARTIFACT_WARNING_THRESHOLD);
  assert.equal(loaded.largeHistory, true);
  assert.equal(loaded.experiments.length, 1);
  assert.equal(loaded.failures.length, traceFiles.length);
});
