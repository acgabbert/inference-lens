import assert from "node:assert/strict";
import test from "node:test";

import {
  ExperimentValidationError,
  experimentArtifactIdentity,
  experimentLifecycle,
  isExperimentEntryName,
  materializeExperimentCellInput,
  parseExperimentPlanJson,
  parseExperimentResultJson,
  repeatedExperimentAggregate,
  serializeExperimentPlan,
  serializeExperimentResult,
} from "../packages/core/src/experiment.ts";
import type {
  ExperimentResultV3,
  ExperimentResultV5,
  ExperimentResultV6,
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
    schemaVersion: 4,
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

function threeCellPlan(): RepeatedExperimentPlanV3 {
  const source = plan();
  return {
    ...source,
    cells: [...source.cells, { cellId: "experiment-cell_third", ordinal: 3, runId: "run_third" }],
  };
}

/** The concurrency every pre-Version 6 result actually ran at. */
function sequential(source: RepeatedExperimentPlanV3) {
  const { profileId, endpoint } = source.commonInput.target;
  return [{ profileId, endpoint, limit: 1 }];
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

test("rejects pre-v4 experiment artifacts instead of migrating them", () => {
  const legacy = JSON.parse(serializeExperimentPlan(plan()));
  legacy.schemaVersion = 2;
  assert.throws(
    () => parseExperimentPlanJson(JSON.stringify(legacy)),
    /Version 2 is unsupported; expected Version 4/,
  );
});

test("rejects legacy fragment provenance inside a Version 4 plan", () => {
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

  assert.equal(mislabelled.schemaVersion, 4);
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
    schemaVersion: 4,
    experimentId: source.experimentId,
    status: "cancelled",
    endedAt: "2026-07-30T12:01:00.000Z",
    cells: [
      { cellId: "experiment-cell_first", runId: "run_first", status: "completed" },
      { cellId: "experiment-cell_second", runId: "run_second", status: "not-run" },
    ],
  };
  const serialized = serializeExperimentResult(result, source);
  // Results are always written as the current version, whatever they arrived as.
  assert.deepEqual(parseExperimentResultJson(serialized, source), {
    ...result,
    schemaVersion: 6,
    concurrency: sequential(source),
    cells: [
      { cellId: "experiment-cell_first", runId: "run_first", status: "completed", startOrder: 1 },
      { cellId: "experiment-cell_second", runId: "run_second", status: "not-run" },
    ],
  });

  const mismatched = structuredClone(result);
  mismatched.cells[1].runId = "run_other" as RunId;
  assert.throws(
    () => serializeExperimentResult(mismatched, source),
    /unplanned cell or run/,
  );
});

test("a stopped result records which repetition and tool stopped the batch", () => {
  const source = threeCellPlan();
  const result: ExperimentResultV6 = {
    schemaVersion: 6,
    experimentId: source.experimentId,
    status: "stopped",
    stop: { reason: "tool_unavailable", cellId: "experiment-cell_second", toolId: "tool_lookup", startedCells: 2 },
    endedAt: "2026-07-30T12:01:00.000Z",
    concurrency: sequential(source),
    cells: [
      { cellId: "experiment-cell_first", runId: "run_first", status: "completed", startOrder: 1 },
      { cellId: "experiment-cell_second", runId: "run_second", status: "failed", startOrder: 2 },
      { cellId: "experiment-cell_third", runId: "run_third", status: "not-run" },
    ],
  };
  const serialized = serializeExperimentResult(result, source);
  assert.deepEqual(parseExperimentResultJson(serialized, source), result);
  assert.equal(experimentLifecycle(source, result), "stopped");
  assert.equal(repeatedExperimentAggregate(source, result).lifecycle, "stopped");
});

test("a stop must name the failed repetition that caused it, and only a stopped result has one", () => {
  const source = plan();
  const stopped: ExperimentResultV6 = {
    schemaVersion: 6,
    experimentId: source.experimentId,
    status: "stopped",
    stop: { reason: "tool_unavailable", cellId: "experiment-cell_first", toolId: "tool_lookup", startedCells: 1 },
    endedAt: "2026-07-30T12:01:00.000Z",
    concurrency: sequential(source),
    cells: [
      { cellId: "experiment-cell_first", runId: "run_first", status: "failed", startOrder: 1 },
      { cellId: "experiment-cell_second", runId: "run_second", status: "not-run" },
    ],
  };
  assert.doesNotThrow(() => serializeExperimentResult(stopped, source));

  const { stop: _stop, ...withoutStop } = stopped;
  void _stop;
  assert.throws(() => serializeExperimentResult(withoutStop as ExperimentResultV6, source), /stopped experiment must record/i);

  const completedCause = structuredClone(stopped);
  completedCause.cells[0].status = "completed";
  assert.throws(() => serializeExperimentResult(completedCause, source), /failed repetition/i);

  const laterCellRan = structuredClone(stopped);
  laterCellRan.cells[1] = { ...laterCellRan.cells[1], status: "completed", startOrder: 2 };
  assert.throws(() => serializeExperimentResult(laterCellRan, source), /after the stop/i);

  const unknownCell = structuredClone(stopped);
  unknownCell.stop = { ...stopped.stop!, cellId: "experiment-cell_other" };
  assert.throws(() => serializeExperimentResult(unknownCell, source), /failed repetition/i);

  const completedWithStop: ExperimentResultV6 = {
    ...stopped,
    status: "completed",
    cells: stopped.cells.map((cell, index) => ({ ...cell, status: "completed" as const, startOrder: index + 1 })),
  };
  assert.throws(() => serializeExperimentResult(completedWithStop, source), /only a stopped experiment/i);
});

test("a stopped Version 6 result may hold later cells that started before the stop", () => {
  const source = threeCellPlan();
  // The first cell stopped the batch, but the second had already started
  // alongside it and was allowed to finish; the third never started.
  const result: ExperimentResultV6 = {
    schemaVersion: 6,
    experimentId: source.experimentId,
    status: "stopped",
    stop: { reason: "tool_unavailable", cellId: "experiment-cell_first", toolId: "tool_lookup", startedCells: 2 },
    endedAt: "2026-07-30T12:01:00.000Z",
    concurrency: [{ ...sequential(source)[0]!, limit: 2 }],
    cells: [
      { cellId: "experiment-cell_first", runId: "run_first", status: "failed", startOrder: 1 },
      { cellId: "experiment-cell_second", runId: "run_second", status: "completed", startOrder: 2 },
      { cellId: "experiment-cell_third", runId: "run_third", status: "not-run" },
    ],
  };
  assert.deepEqual(parseExperimentResultJson(serializeExperimentResult(result, source), source), result);

  const startedAfter = structuredClone(result);
  startedAfter.cells[2] = { ...startedAfter.cells[2], status: "completed", startOrder: 3 };
  assert.throws(() => serializeExperimentResult(startedAfter, source), /No repetition may start after the stop/);

  const overcounted = structuredClone(result);
  overcounted.stop!.startedCells = 3;
  assert.throws(() => serializeExperimentResult(overcounted, source), /stop must count/i);
});

test("Version 6 start orders number the started cells once each, from one", () => {
  const source = plan();
  const result: ExperimentResultV6 = {
    schemaVersion: 6,
    experimentId: source.experimentId,
    status: "completed",
    endedAt: "2026-07-30T12:01:00.000Z",
    concurrency: [{ ...sequential(source)[0]!, limit: 2 }],
    // Cells stay in plan order whatever order they started in.
    cells: [
      { cellId: "experiment-cell_first", runId: "run_first", status: "completed", startOrder: 2 },
      { cellId: "experiment-cell_second", runId: "run_second", status: "completed", startOrder: 1 },
    ],
  };
  assert.doesNotThrow(() => serializeExperimentResult(result, source));

  const repeated = structuredClone(result);
  repeated.cells[1] = { cellId: "experiment-cell_second", runId: "run_second", status: "completed", startOrder: 2 };
  assert.throws(() => serializeExperimentResult(repeated, source), /start order/i);

  const gap = structuredClone(result);
  gap.cells[0] = { cellId: "experiment-cell_first", runId: "run_first", status: "completed", startOrder: 3 };
  assert.throws(() => serializeExperimentResult(gap, source), /start order/i);

  const missing = structuredClone(result) as unknown as { cells: Array<Record<string, unknown>> };
  delete missing.cells[0]!.startOrder;
  assert.throws(() => serializeExperimentResult(missing as unknown as ExperimentResultV6, source), /startOrder/);

  const unstartedWithOrder = {
    ...structuredClone(result),
    status: "cancelled",
    cells: [result.cells[0], { ...result.cells[1], status: "not-run" }],
  };
  assert.throws(() => serializeExperimentResult(unstartedWithOrder as unknown as ExperimentResultV6, source));
});

test("Version 6 records one positive limit for each connection the plan uses", () => {
  const source = plan();
  const [connection] = sequential(source);
  const result: ExperimentResultV6 = {
    schemaVersion: 6,
    experimentId: source.experimentId,
    status: "completed",
    endedAt: "2026-07-30T12:01:00.000Z",
    concurrency: [{ ...connection!, limit: 4 }],
    cells: [
      { cellId: "experiment-cell_first", runId: "run_first", status: "completed", startOrder: 1 },
      { cellId: "experiment-cell_second", runId: "run_second", status: "completed", startOrder: 2 },
    ],
  };
  assert.doesNotThrow(() => serializeExperimentResult(result, source));

  for (const concurrency of [
    [],
    [connection, connection],
    [{ ...connection!, endpoint: "https://other.example.com/v1" }],
    [{ ...connection!, limit: 0 }],
    [{ ...connection!, limit: 1.5 }],
  ]) {
    assert.throws(
      () => serializeExperimentResult({ ...result, concurrency } as ExperimentResultV6, source),
      /concurrency|limit/i,
      JSON.stringify(concurrency),
    );
  }
});

test("Version 4 results remain readable and are read as Version 6 at a concurrency of 1", () => {
  const source = plan();
  const legacy = {
    schemaVersion: 4,
    experimentId: source.experimentId,
    status: "completed",
    endedAt: "2026-07-30T12:01:00.000Z",
    cells: [
      { cellId: "experiment-cell_first", runId: "run_first", status: "completed" },
      { cellId: "experiment-cell_second", runId: "run_second", status: "failed" },
    ],
  };
  assert.deepEqual(parseExperimentResultJson(JSON.stringify(legacy), source), {
    ...legacy,
    schemaVersion: 6,
    concurrency: sequential(source),
    cells: [
      { cellId: "experiment-cell_first", runId: "run_first", status: "completed", startOrder: 1 },
      { cellId: "experiment-cell_second", runId: "run_second", status: "failed", startOrder: 2 },
    ],
  });
  assert.throws(
    () => parseExperimentResultJson(JSON.stringify({ ...legacy, status: "stopped" }), source),
  );
  assert.throws(
    () => parseExperimentResultJson(JSON.stringify({ ...legacy, schemaVersion: 3 }), source),
    /Version 3 is unsupported; expected Version 4, 5, or 6/,
  );
  assert.throws(
    () => parseExperimentResultJson(JSON.stringify({ ...legacy, schemaVersion: 7 }), source),
    /Version 7 is unsupported/,
  );
});

test("Version 5 results are read as Version 6, keeping the rule that nothing ran after the stop", () => {
  const source = threeCellPlan();
  const legacy: ExperimentResultV5 = {
    schemaVersion: 5,
    experimentId: source.experimentId,
    status: "stopped",
    stop: { reason: "tool_unavailable", cellId: "experiment-cell_second", toolId: "tool_lookup" },
    endedAt: "2026-07-30T12:01:00.000Z",
    cells: [
      { cellId: "experiment-cell_first", runId: "run_first", status: "completed" },
      { cellId: "experiment-cell_second", runId: "run_second", status: "failed" },
      { cellId: "experiment-cell_third", runId: "run_third", status: "not-run" },
    ],
  };
  assert.deepEqual(parseExperimentResultJson(JSON.stringify(legacy), source), {
    ...legacy,
    schemaVersion: 6,
    stop: { ...legacy.stop!, startedCells: 2 },
    concurrency: sequential(source),
    cells: [
      { cellId: "experiment-cell_first", runId: "run_first", status: "completed", startOrder: 1 },
      { cellId: "experiment-cell_second", runId: "run_second", status: "failed", startOrder: 2 },
      { cellId: "experiment-cell_third", runId: "run_third", status: "not-run" },
    ],
  });

  // Version 5 could not record a cell that ran after the stop; one that
  // claims to is still refused after the upgrade.
  const laterCellRan = structuredClone(legacy);
  laterCellRan.cells[2]!.status = "completed";
  assert.throws(
    () => parseExperimentResultJson(JSON.stringify(laterCellRan), source),
    /No repetition may start after the stop/,
  );
});

test("projects interrupted and missing-trace evidence without fabricating results", () => {
  const source = plan();
  const firstInput = materializeExperimentCellInput(source, "experiment-cell_first");
  const first = completedState(firstInput, "Hi 👋");
  const result: ExperimentResultV3 = {
    schemaVersion: 4,
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

test("names the three experiment artifact kinds and refuses lookalikes", () => {
  for (const accepted of [
    "experiment_first.plan.json",
    "experiment_first.result.json",
    "experiment_first.v2.plan.json",
    "evaluation-assessment_corrected.assessment.json",
    "evaluation-assessment_corrected.v2.assessment.json",
  ]) {
    assert.equal(isExperimentEntryName(accepted), true, `${accepted} should be accepted`);
  }

  for (const refused of [
    // Each kind is bound to the entity that names it, so a plan cannot borrow
    // an assessment ID and an assessment cannot borrow an experiment ID.
    "experiment_first.assessment.json",
    "evaluation-assessment_corrected.plan.json",
    "evaluation-assessment_corrected.result.json",
    // Path traversal and near misses on the suffix or prefix.
    "../evaluation-assessment_corrected.assessment.json",
    "evaluation-assessment_../secret.assessment.json",
    "evaluation-assessment_corrected.assessment.json.bak",
    "evaluation-assessment_.assessment.json",
    "evaluation_assessment_corrected.assessment.json",
    "evaluation-assessmentcorrected.assessment.json",
    "assessment.json",
    "notes.json",
  ]) {
    assert.equal(isExperimentEntryName(refused), false, `${refused} should be refused`);
  }
});

test("reports artifact identity as a union so an assessment is never read as a result", () => {
  assert.deepEqual(experimentArtifactIdentity("experiment_first.plan.json"), {
    kind: "plan",
    experimentId: "experiment_first",
  });
  assert.deepEqual(experimentArtifactIdentity("experiment_first.result.json"), {
    kind: "result",
    experimentId: "experiment_first",
  });
  assert.deepEqual(
    experimentArtifactIdentity("evaluation-assessment_corrected.assessment.json"),
    { kind: "assessment", assessmentId: "evaluation-assessment_corrected" },
  );
  assert.throws(
    () => experimentArtifactIdentity("experiment_first.assessment.json"),
    ExperimentValidationError,
  );
});
