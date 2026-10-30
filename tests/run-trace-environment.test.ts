import assert from "node:assert/strict";
import test from "node:test";

import { parseExperimentPlanJson, serializeExperimentPlan } from "../packages/core/src/experiment.ts";
import { RunCoordinator } from "../packages/core/src/run-kernel/coordinator.ts";
import { createRunTrace } from "../packages/core/src/run-kernel/reducer.ts";
import { createResolvedRunInput } from "../packages/core/src/run-kernel/run-execution.ts";
import type {
  ResolvedRunInput,
  ResolvedTemplateUse,
  RunEnvironmentSnapshot,
  RunTrace,
} from "../packages/core/src/run-kernel/types.ts";
import {
  parseRunTraceFile,
  parseRunTraceJson,
  RUN_TRACE_SCHEMA_VERSION,
  serializeRunTrace,
} from "../packages/core/src/run-trace.ts";
import { createRepeatedExperimentPlan } from "../packages/runner/src/repeated-start.ts";

const resolution: ResolvedTemplateUse = {
  templateUseId: "template-use_greeting",
  templateId: "template_greeting",
  templateRevisionId: "template-revision_greeting-1",
  templateName: "Greeting",
  messages: [{ role: "user", content: "{{greeting}}, {{customer}}" }],
  variableDefaults: { greeting: "Hello" },
  values: { greeting: "Hello", customer: "Acme" },
  valueSources: { greeting: "template-default", customer: "environment" },
  outputMessageIds: ["message_greeting"],
};

const environment: RunEnvironmentSnapshot = {
  environmentId: "environment_staging",
  name: "Staging",
  consumed: { customer: "Acme" },
};

function trace(
  templateResolutions: ResolvedTemplateUse[],
  snapshot?: RunEnvironmentSnapshot,
): RunTrace {
  const base = createResolvedRunInput(
    {
      provider: "openai-compatible",
      endpoint: "https://api.example.com/v1",
      model: "example-model",
      messages: [{ id: "message_greeting", role: "user", content: [{ type: "text", text: "Hello, Acme" }] }],
    },
    { conversationId: "conversation_environment", conversationRevisionId: "revision_environment" },
    [],
    templateResolutions,
    "environment-trace",
    "2026-10-29T12:00:00.000Z",
  );
  const input: ResolvedRunInput = snapshot ? { ...base, environment: snapshot } : base;
  const coordinator = new RunCoordinator(input);
  const { execution } = coordinator.start();
  coordinator.accept({
    type: "request",
    request: { url: "https://api.example.com/v1/chat/completions", method: "POST", headers: {}, body: "{}" },
  });
  coordinator.accept({ type: "response_started", response: { status: 200, headers: {} } });
  coordinator.accept({ type: "frame", frame: { index: 0, raw: "data: {}" } });
  coordinator.accept({ type: "text_delta", text: "Hi", source: { exchangeId: execution.exchangeId, frameIndex: 0 } });
  coordinator.accept({
    type: "completed",
    finishReason: { normalized: "stop", raw: "stop" },
    source: { exchangeId: execution.exchangeId, frameIndex: 0 },
  });
  coordinator.finishTurnStream();
  return createRunTrace(coordinator.state);
}

/** Applies one change to the input and to the run.started event alike. */
function withInput(source: RunTrace, change: (input: Record<string, unknown>) => void): unknown {
  const value = JSON.parse(serializeRunTrace(source)) as {
    input: Record<string, unknown>;
    events: Array<{ type: string; input?: Record<string, unknown> }>;
  };
  change(value.input);
  change(value.events[0]!.input!);
  return value;
}

test("a run with value sources and an environment is written as the current version and reads back whole", () => {
  const written = JSON.parse(serializeRunTrace(trace([resolution], environment)));

  assert.equal(RUN_TRACE_SCHEMA_VERSION, 10);
  assert.equal(written.schemaVersion, 10);
  const reopened = parseRunTraceFile(written);
  assert.deepEqual(reopened.input.environment, environment);
  assert.deepEqual(reopened.input.templateResolutions[0]!.valueSources, resolution.valueSources);
});

test("a run without template uses is the current version; one whose uses lack sources stays version 8", () => {
  assert.equal(JSON.parse(serializeRunTrace(trace([]))).schemaVersion, 10);

  const legacy: ResolvedTemplateUse = { ...resolution };
  delete legacy.valueSources;
  const written = JSON.parse(serializeRunTrace(trace([legacy])));
  assert.equal(written.schemaVersion, 8, "provenance is never fabricated for an older trace");
  assert.equal(parseRunTraceJson(JSON.stringify(written)).input.templateResolutions[0]!.valueSources, undefined);
});

test("version 9 requires a source for exactly the recorded values", () => {
  const source = trace([resolution], environment);

  assert.throws(
    () => parseRunTraceFile(withInput(source, (input) => {
      delete (input.templateResolutions as Array<Record<string, unknown>>)[0]!.valueSources;
    })),
    /valueSources/,
  );
  assert.throws(
    () => parseRunTraceFile(withInput(source, (input) => {
      const [use] = input.templateResolutions as Array<{ valueSources: Record<string, string> }>;
      use!.valueSources = { greeting: "template-default" };
    })),
    /source for every value/,
  );
});

test("version 9 environment evidence must agree with the values it supplied", () => {
  const source = trace([resolution], environment);

  assert.throws(
    () => parseRunTraceFile(withInput(source, (input) => {
      (input.environment as RunEnvironmentSnapshot).consumed = { customer: "Globex" };
    })),
    /environment/,
  );
  assert.throws(
    () => parseRunTraceFile(withInput(source, (input) => {
      (input.environment as RunEnvironmentSnapshot).consumed = { customer: "Acme", unused: "x" };
    })),
    /environment/,
  );
  assert.throws(
    () => parseRunTraceFile(withInput(source, (input) => {
      delete input.environment;
    })),
    /environment/,
  );
});

test("a version 8 trace cannot carry an environment", () => {
  const value = withInput(trace([]), (input) => {
    input.environment = { environmentId: "environment_staging", name: "Staging", consumed: {} };
  }) as Record<string, unknown>;

  assert.throws(() => parseRunTraceFile({ ...value, schemaVersion: 8 }), /schema version does not define/);
});

test("prototype-like environment values survive trace and plan serialization", () => {
  const use: ResolvedTemplateUse = {
    ...resolution,
    messages: [{ role: "user", content: "{{greeting}}, {{__proto__}}" }],
    values: { greeting: "Hello", ["__proto__"]: "Acme" },
    valueSources: { greeting: "template-default", ["__proto__"]: "environment" },
  };
  const snapshot = { ...environment, consumed: { ["__proto__"]: "Acme" } };
  const original = trace([use], snapshot);
  const reopened = parseRunTraceJson(serializeRunTrace(original));
  assert.deepEqual(reopened.input.environment, snapshot);
  assert.deepEqual(reopened.input.templateResolutions, [use]);
  const plan = createRepeatedExperimentPlan(original.input, 1, 1);
  const reopenedPlan = parseExperimentPlanJson(serializeExperimentPlan(plan));
  assert.equal(reopenedPlan.kind, "repeated-request");
  if (reopenedPlan.kind !== "repeated-request") return;
  assert.deepEqual(reopenedPlan.commonInput.environment, snapshot);
  assert.deepEqual(reopenedPlan.commonInput.templateResolutions, [use]);
});

test("prototype-like environment values still require strings at the artifact boundary", () => {
  const value = withInput(trace([resolution], environment), (input) => {
    const snapshot = input.environment as { consumed: Record<string, unknown> };
    Object.defineProperty(snapshot.consumed, "__proto__", { value: 42, enumerable: true });
  });
  assert.throws(() => parseRunTraceFile(value), /__proto__/);
});
