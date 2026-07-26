import assert from "node:assert/strict";
import test from "node:test";

import {
  createResolvedRunInput,
} from "../packages/core/src/run-kernel/run-execution.ts";
import { RunCoordinator } from "../packages/core/src/run-kernel/coordinator.ts";
import { createRunTrace } from "../packages/core/src/run-kernel/reducer.ts";
import type { RunTrace } from "../packages/core/src/run-kernel/types.ts";
import {
  assertTraceEntryName,
  isTraceEntryName,
  parseRunTraceJson,
  RunTraceValidationError,
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
    {
      conversationId: "conversation_trace-test",
      conversationRevisionId: "revision_trace-test",
    },
    [],
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
  assert.match(serialized, /"schemaVersion": 3/);
});

test("migrates Version 1 evidence but rejects Version 1 branch provenance", () => {
  const v1 = structuredClone(completedTrace());
  v1.schemaVersion = 1;
  delete (v1.input as Partial<typeof v1.input>).templateResolutions;
  const started = v1.events[0];
  if (started?.type === "run.started") {
    delete (started.input as Partial<typeof started.input>).templateResolutions;
  }
  const migrated = parseRunTraceJson(JSON.stringify(v1));
  assert.equal(migrated.schemaVersion, 3);
  assert.deepEqual(migrated.input.templateResolutions, []);
  assert.match(serializeRunTrace(v1), /"schemaVersion": 3/);

  assert.throws(
    () => parseRunTraceJson(JSON.stringify({
      ...v1,
      branchedFrom: { runId: "run_parent", messageId: "message_parent" },
    })),
    /Invalid run trace/,
  );
});

test("round-trips branch provenance", () => {
  const trace = createRunTrace(
    runStateFromTrace(completedTrace()),
    {
      branchedFrom: {
        runId: "run_parent",
        parentConversationRevisionId: "revision_parent",
        messageId: "message_parent",
      },
    },
  );
  assert.deepEqual(parseRunTraceJson(serializeRunTrace(trace)).branchedFrom, {
    runId: "run_parent",
    parentConversationRevisionId: "revision_parent",
    messageId: "message_parent",
  });
});

test("accepts self-contained template provenance and rejects mismatched evidence", () => {
  const trace = structuredClone(completedTrace());
  const resolution = {
    templateUseId: "template-use_trace" as const,
    templateId: "template_trace" as const,
    templateRevisionId: "template-revision_trace-1" as const,
    templateName: "Greeting",
    content: { kind: "fragment" as const, text: "{{greeting}}" },
    variableDefaults: { greeting: "Hello" },
    values: { greeting: "Hello" },
    outputMessageIds: ["message_trace-test-0" as const],
    fragmentRole: "user" as const,
  };
  trace.input.templateResolutions = [resolution];
  const started = trace.events[0];
  assert.equal(started?.type, "run.started");
  if (started?.type !== "run.started") return;
  started.input.templateResolutions = [resolution];

  assert.deepEqual(
    parseRunTraceJson(serializeRunTrace(trace)).input.templateResolutions,
    [resolution],
  );
  trace.input.templateResolutions[0]!.values.greeting = "Goodbye";
  started.input.templateResolutions[0]!.values.greeting = "Goodbye";
  assert.throws(
    () => serializeRunTrace(trace),
    /does not match resolved input messages/,
  );
});

test("verifies provenance for a run made with an unresolved variable", () => {
  const trace = structuredClone(completedTrace());
  const resolution = {
    templateUseId: "template-use_trace" as const,
    templateId: "template_trace" as const,
    templateRevisionId: "template-revision_trace-1" as const,
    templateName: "Greeting",
    content: { kind: "fragment" as const, text: "{{greeting}}" },
    variableDefaults: {},
    values: {},
    outputMessageIds: ["message_trace-test-0" as const],
    fragmentRole: "user" as const,
  };
  // The run went out with the token unresolved. That evidence still has to
  // verify, because the engine reproduces exactly what was sent.
  trace.input.messages[0]!.content = [{ type: "text", text: "{{greeting}}" }];
  trace.input.templateResolutions = [resolution];
  const started = trace.events[0];
  assert.equal(started?.type, "run.started");
  if (started?.type !== "run.started") return;
  started.input.messages[0]!.content = [{ type: "text", text: "{{greeting}}" }];
  started.input.templateResolutions = [resolution];

  assert.deepEqual(
    parseRunTraceJson(serializeRunTrace(trace)).input.templateResolutions,
    [resolution],
  );
});

test("rejects malformed template provenance as an invalid trace", () => {
  const valid = JSON.parse(serializeRunTrace(completedTrace()));
  const cases: Array<[string, unknown]> = [
    ["absent", undefined],
    ["not an array", "template-use_trace"],
    ["a null entry", [null]],
    [
      "a non-string fragment body",
      [
        {
          templateUseId: "template-use_trace",
          templateId: "template_trace",
          templateRevisionId: "template-revision_trace-1",
          templateName: "Greeting",
          content: { kind: "fragment", text: 42 },
          variableDefaults: {},
          values: {},
          outputMessageIds: ["message_trace-test-0"],
          fragmentRole: "user",
        },
      ],
    ],
    [
      "an unknown content kind",
      [
        {
          templateUseId: "template-use_trace",
          templateId: "template_trace",
          templateRevisionId: "template-revision_trace-1",
          templateName: "Greeting",
          content: { kind: "bogus" },
          variableDefaults: {},
          values: {},
          outputMessageIds: ["message_trace-test-0"],
          fragmentRole: "user",
        },
      ],
    ],
    [
      "an unparseable output message ID",
      [
        {
          templateUseId: "template-use_trace",
          templateId: "template_trace",
          templateRevisionId: "template-revision_trace-1",
          templateName: "Greeting",
          content: { kind: "fragment", text: "Hi" },
          variableDefaults: {},
          values: {},
          outputMessageIds: ["not-a-message-id"],
          fragmentRole: "user",
        },
      ],
    ],
  ];

  for (const [label, resolutions] of cases) {
    const json = structuredClone(valid);
    if (resolutions === undefined) delete json.input.templateResolutions;
    else json.input.templateResolutions = resolutions;
    assert.throws(
      () => parseRunTraceJson(JSON.stringify(json)),
      // The envelope rejects the artifact; nothing reaches the renderer and
      // escapes as an internal error.
      (error: unknown) =>
        error instanceof RunTraceValidationError &&
        error.message.startsWith("Invalid run trace at input.templateResolutions"),
      `expected a validation error for ${label}`,
    );
  }
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

test("accepts discovered trace names that stay inside the traces directory", () => {
  // History entries are found on disk rather than derived from a run ID, so a
  // hand-renamed artifact is still a legitimate name.
  for (const accepted of [
    "run_safe-1.json",
    "renamed-by-hand.json",
    "2026-07-25.run.json",
  ]) {
    assert.equal(isTraceEntryName(accepted), true, accepted);
    assert.equal(assertTraceEntryName(accepted), accepted);
  }
});

test("rejects discovered trace names that could leave the traces directory", () => {
  for (const rejected of [
    "../trace-lens.project.json",
    "nested/run_a.json",
    "nested\\run_a.json",
    "/etc/passwd",
    "run_a.json/../../secret.json",
    ".hidden.json",
    "-leading.json",
    ".json",
    "run_a.txt",
    "run_a",
    "",
  ]) {
    assert.equal(isTraceEntryName(rejected), false, rejected);
    assert.throws(
      () => assertTraceEntryName(rejected),
      /is not a run trace file name/,
      rejected,
    );
  }
});
