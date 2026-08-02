import assert from "node:assert/strict";
import test from "node:test";

import {
  ExperimentValidationError,
  experimentLifecycle,
  materializeExperimentCellInput,
  parseExperimentPlanJson,
  parseExperimentResultJson,
  repeatedExperimentAggregate,
  serializeExperimentPlan,
  serializeExperimentResult,
} from "../packages/core/src/experiment.ts";
import type {
  ExperimentResultV3,
  RepeatedExperimentPlanV3,
} from "../packages/core/src/experiment.ts";
import { createResolvedRunInput } from "../packages/core/src/run-kernel/run-execution.ts";
import { RunCoordinator } from "../packages/core/src/run-kernel/coordinator.ts";
import type { ResolvedRunInput, RunId } from "../packages/core/src/run-kernel/types.ts";

function plan(): RepeatedExperimentPlanV3 {
  const input = createResolvedRunInput(
    {
      provider: "openai-compatible",
      endpoint: "https://api.example.com/v1",
      model: "example-model",
      messages: [{ role: "user", content: "Say hello" }],
    },
    {
      conversationId: "conversation_experiment",
      conversationRevisionId: "revision_experiment",
    },
    [],
    [],
    "source",
    "2026-07-30T12:00:00.000Z",
  );
  const { runId: sourceRunId, ...commonInput } = input;
  assert.equal(sourceRunId, "run_source");
  return {
    schemaVersion: 3,
    experimentId: "experiment_example",
    kind: "repeated-request",
    createdAt: "2026-07-30T12:00:01.000Z",
    commonInput,
    cells: [
      { cellId: "experiment-cell_first", ordinal: 1, runId: "run_first" },
      { cellId: "experiment-cell_second", ordinal: 2, runId: "run_second" },
    ],
  };
}

function completedState(input: ResolvedRunInput, text: string) {
  const coordinator = new RunCoordinator(input);
  const { execution } = coordinator.start();
  coordinator.accept({
    type: "request",
    request: {
      url: "https://api.example.com/v1/chat/completions",
      method: "POST",
      headers: { authorization: "Bearer ••••••••" },
      body: "{}",
    },
  });
  coordinator.accept({
    type: "text_delta",
    text,
    source: { exchangeId: execution.exchangeId },
  });
  coordinator.accept({
    type: "completed",
    finishReason: { normalized: "stop", raw: "stop" },
    source: { exchangeId: execution.exchangeId },
  });
  coordinator.finishTurnStream();
  return coordinator.state;
}

test("serializes repeat plans deterministically and materializes only the cell run ID", () => {
  const source = plan();
  const serialized = serializeExperimentPlan(source);
  const parsed = parseExperimentPlanJson(serialized);
  assert.equal(parsed.kind, "repeated-request");
  if (parsed.kind !== "repeated-request") throw new Error("Expected repeated plan.");

  assert.equal(serializeExperimentPlan(parsed), serialized);
  assert.deepEqual(
    materializeExperimentCellInput(parsed, "experiment-cell_first"),
    { ...parsed.commonInput, runId: "run_first" },
  );
  assert.deepEqual(
    materializeExperimentCellInput(parsed, "experiment-cell_second"),
    { ...parsed.commonInput, runId: "run_second" },
  );
});

test("rejects pre-v3 experiment artifacts instead of migrating them", () => {
  const legacy = JSON.parse(serializeExperimentPlan(plan()));
  legacy.schemaVersion = 2;
  assert.throws(
    () => parseExperimentPlanJson(JSON.stringify(legacy)),
    /Version 2 is unsupported; expected Version 3/,
  );
});

test("rejects legacy fragment provenance inside a Version 3 plan", () => {
  const mislabelled = JSON.parse(serializeExperimentPlan(plan()));
  mislabelled.commonInput.templateResolutions = [{
    templateUseId: "template-use_legacy",
    templateId: "template_legacy",
    templateRevisionId: "template-revision_legacy-1",
    templateName: "Legacy",
    content: { kind: "fragment", text: "Say hello" },
    variableDefaults: {},
    values: {},
    outputMessageIds: [mislabelled.commonInput.messages[0].id],
    fragmentRole: "user",
  }];

  assert.equal(mislabelled.schemaVersion, 3);
  assert.throws(
    () => parseExperimentPlanJson(JSON.stringify(mislabelled)),
    ExperimentValidationError,
  );
});

test("rejects unknown fields, duplicate identities, and credential-like provider options", () => {
  const source = plan();
  const unknown = JSON.parse(serializeExperimentPlan(source));
  unknown.unexpected = true;
  assert.throws(
    () => parseExperimentPlanJson(JSON.stringify(unknown)),
    ExperimentValidationError,
  );

  const duplicate = structuredClone(source);
  duplicate.cells[1].runId = duplicate.cells[0].runId;
  assert.throws(() => serializeExperimentPlan(duplicate), /repeats run/);

  const sensitive = structuredClone(source);
  sensitive.commonInput.options.providerOptions = { apiKey: "never-save-this" };
  assert.throws(() => serializeExperimentPlan(sensitive), /credential-like/);

  const credentialedEndpoint = structuredClone(source);
  credentialedEndpoint.commonInput.target.endpoint = "https://key@example.com/v1";
  assert.throws(() => serializeExperimentPlan(credentialedEndpoint), /Endpoint must use HTTP/);
});

test("validates result identity and planned references exactly", () => {
  const source = plan();
  const result: ExperimentResultV3 = {
    schemaVersion: 3,
    experimentId: source.experimentId,
    status: "cancelled",
    endedAt: "2026-07-30T12:01:00.000Z",
    cells: [
      { cellId: "experiment-cell_first", runId: "run_first", status: "completed" },
      { cellId: "experiment-cell_second", runId: "run_second", status: "not-run" },
    ],
  };
  const serialized = serializeExperimentResult(result, source);
  assert.deepEqual(parseExperimentResultJson(serialized, source), result);

  const mismatched = structuredClone(result);
  mismatched.cells[1].runId = "run_other" as RunId;
  assert.throws(
    () => serializeExperimentResult(mismatched, source),
    /unplanned cell or run/,
  );
});

test("projects interrupted and missing-trace evidence without fabricating results", () => {
  const source = plan();
  const firstInput = materializeExperimentCellInput(source, "experiment-cell_first");
  const first = completedState(firstInput, "Hi 👋");
  const result: ExperimentResultV3 = {
    schemaVersion: 3,
    experimentId: source.experimentId,
    status: "completed",
    endedAt: "2026-07-30T12:01:00.000Z",
    cells: [
      { cellId: "experiment-cell_first", runId: "run_first", status: "completed" },
      { cellId: "experiment-cell_second", runId: "run_second", status: "completed" },
    ],
  };
  const aggregate = repeatedExperimentAggregate(
    source,
    result,
    new Map([[first.runId, first]]),
  );

  assert.equal(aggregate.lifecycle, "completed");
  assert.equal(aggregate.completed, 1);
  assert.equal(aggregate.missingTrace, 1);
  assert.equal(aggregate.totalTokens.reportedRuns, 0);
  assert.equal(aggregate.distinctFinalAssistantOutputs, 1);
  assert.deepEqual(aggregate.outputCharacterCount, { count: 1, min: 4, median: 4, max: 4 });
  assert.equal(experimentLifecycle(source), "interrupted");
});
