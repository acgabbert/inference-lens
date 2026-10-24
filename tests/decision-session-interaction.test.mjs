import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";

import { JSDOM } from "jsdom";
import { ssrLoadModule } from "./support/ssr.mjs";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
});

after(() => dom.window.close());

const allTypes = JSON.parse(
  readFileSync(new URL("./fixtures/system-one/llamacpp-all-types.json", import.meta.url), "utf8"),
);
const rawBody = JSON.stringify(allTypes.response.body);
const request = {
  url: "https://llm.example.test/v1/systemone",
  method: "POST",
  headers: { authorization: "Bearer ••••••••", "content-type": "application/json" },
  body: JSON.stringify(allTypes.request),
};
const rateLimited = {
  code: "provider_error",
  message: "Too many requests.",
  retryable: true,
  providerStatus: 429,
};

let counter = 0;
function runInput() {
  counter += 1;
  const { model, state, questions } = allTypes.request;
  return {
    runId: `run_session-${counter}`,
    resolvedAt: "2026-10-24T12:00:00.000Z",
    target: {
      profileId: "profile_llamacpp",
      protocol: "systemone",
      endpoint: "https://llm.example.test/v1",
      model,
      capabilities: { streaming: false },
    },
    decision: { state, questions },
  };
}

async function load() {
  const [{ createElement, act }, { createRoot }, session, systemOne, runTrace] = await Promise.all([
    import("react"),
    import("react-dom/client"),
    ssrLoadModule("/app/decisions/use-decision-session.client.ts"),
    ssrLoadModule("/packages/core/src/system-one.ts"),
    ssrLoadModule("/packages/core/src/run-trace.ts"),
  ]);
  return { createElement, act, createRoot, session, systemOne, runTrace };
}

function successEvents(systemOne, input) {
  return [
    { type: "request", request },
    { type: "response_started", response: { status: 200, headers: { "content-type": "application/json" } } },
    { type: "frame", frame: { index: 0, raw: rawBody } },
    { type: "completed", result: systemOne.systemOneAdapter.normalizeResponse(input, rawBody) },
  ];
}

function rateLimitedEvents(headers) {
  return [
    { type: "request", request },
    { type: "response_started", response: { status: 429, headers } },
    { type: "frame", frame: { index: 0, raw: '{"error":"slow down"}' } },
    { type: "failed", error: rateLimited },
  ];
}

/** A stream the test feeds one event at a time, and can end. */
function controlledStream() {
  const queue = [];
  let wake;
  let ended = false;
  return {
    push(event) { queue.push(event); wake?.(); },
    end() { ended = true; wake?.(); },
    events: (async function* () {
      for (;;) {
        while (queue.length > 0) yield queue.shift();
        if (ended) return;
        await new Promise((resolve) => { wake = resolve; });
        wake = undefined;
      }
    })(),
  };
}

function listStream(events) {
  return (async function* () { yield* events; })();
}

/** Renders the hook and exposes its latest handle. */
async function mountSession(env, overrides = {}) {
  const { createElement, act, createRoot, session } = env;
  const calls = { shown: 0, saved: 0, errors: [], executions: [] };
  let handle;
  const options = {
    transport: {
      async executeDecision({ execution }, signal) {
        calls.executions.push({ execution, signal });
        const events = overrides.events(execution, calls.executions.length);
        return { status: 200, headers: new Headers(), events };
      },
    },
    prepareCredential: async () => ({ kind: "none" }),
    onShowResponse: () => { calls.shown += 1; },
    onTraceSaved: () => { calls.saved += 1; },
    onError: (message) => { calls.errors.push(message); },
  };
  function Probe() {
    handle = session.useDecisionSession(options);
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(createElement(Probe)));
  return {
    calls,
    get handle() { return handle; },
    act,
    async unmount() { await act(async () => root.unmount()); },
  };
}

test("a started run completes with its evidence, unsaved without a project", async () => {
  const env = await load();
  const input = runInput();
  const mounted = await mountSession(env, { events: () => listStream(successEvents(env.systemOne, input)) });

  await mounted.act(async () => { await mounted.handle.start(input, { workspace: null }); });

  const { run } = mounted.handle;
  assert.equal(run.status.kind, "completed");
  assert.equal(run.attempts.length, 1);
  assert.equal(run.attempts[0].result.answers.intent.type, "choice");
  assert.equal(mounted.handle.executing, false);
  assert.deepEqual(mounted.handle.traceStorage, { kind: "unsaved" });
  assert.equal(mounted.calls.shown, 1);
  assert.deepEqual(mounted.calls.executions[0].execution.input.decision, input.decision);
  await mounted.unmount();
});

test("Stop during an attempt cancels it, and late events cannot revive it", async () => {
  const env = await load();
  const input = runInput();
  const stream = controlledStream();
  const mounted = await mountSession(env, { events: () => stream.events });

  let running;
  await mounted.act(async () => { running = mounted.handle.start(input, { workspace: null }); });
  await mounted.act(async () => { stream.push({ type: "request", request }); });
  assert.equal(mounted.handle.run.status.kind, "running");
  assert.equal(mounted.handle.executing, true);

  await mounted.act(async () => { mounted.handle.stop(); });
  assert.equal(mounted.calls.executions[0].signal.aborted, true);
  for (const event of successEvents(env.systemOne, input).slice(1)) {
    await mounted.act(async () => { stream.push(event); });
  }
  await mounted.act(async () => { stream.end(); await running; });

  const { run } = mounted.handle;
  assert.equal(run.status.kind, "cancelled");
  assert.equal(run.status.reason, "Stopped by user.");
  assert.deepEqual(run.attempts.map(({ status }) => status), ["cancelled"]);
  assert.equal(mounted.handle.executing, false);
  // The request evidence observed before Stop stays.
  assert.deepEqual(run.exchanges[run.attempts[0].exchangeId].request, request);

  await mounted.act(async () => { mounted.handle.stop(); });
  assert.equal(mounted.handle.run, run, "a second Stop changes nothing");
  await mounted.unmount();
});

test("a 429 pauses the run; Retry waits for retry-after, then resends the frozen input", async () => {
  const env = await load();
  const input = runInput();
  const mounted = await mountSession(env, {
    events: (_execution, call) => listStream(call === 1
      ? rateLimitedEvents({ "retry-after-ms": "80" })
      : successEvents(env.systemOne, input)),
  });

  const before = Date.now();
  await mounted.act(async () => { await mounted.handle.start(input, { workspace: null }); });
  assert.equal(mounted.handle.run.status.kind, "paused");
  assert.equal(mounted.handle.executing, false, "a paused run is not executing (D24)");
  const waitUntil = mounted.handle.retryAvailableAt;
  assert.ok(waitUntil >= before + 80 && waitUntil <= Date.now() + 80, `wait ends at ${waitUntil}`);
  assert.equal(mounted.handle.traceStorage, null, "a paused run is not saved");

  await mounted.act(async () => { await mounted.handle.retry(); });
  assert.equal(mounted.calls.executions.length, 1, "Retry is a no-op during the wait");

  await mounted.act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); });
  assert.equal(mounted.handle.retryAvailableAt, undefined, "the wait clears itself");

  await mounted.act(async () => { await mounted.handle.retry(); });
  const { run } = mounted.handle;
  assert.equal(run.status.kind, "completed");
  assert.deepEqual(run.attempts.map(({ status }) => status), ["failed", "completed"]);
  assert.equal(run.attempts[0].error.providerStatus, 429);
  assert.deepEqual(mounted.calls.executions[1].execution.input, mounted.calls.executions[0].execution.input);
  assert.equal(mounted.calls.executions[1].execution.attempt, 2);
  await mounted.unmount();
});

test("Stop while paused ends the run as failed with the attempt's error", async () => {
  const env = await load();
  const input = runInput();
  const mounted = await mountSession(env, {
    events: () => listStream(rateLimitedEvents({ "retry-after": "30" })),
  });

  await mounted.act(async () => { await mounted.handle.start(input, { workspace: null }); });
  assert.equal(mounted.handle.run.status.kind, "paused");
  assert.ok(mounted.handle.retryAvailableAt > Date.now());

  await mounted.act(async () => { mounted.handle.stop(); });
  const { run } = mounted.handle;
  assert.equal(run.status.kind, "failed");
  assert.deepEqual(run.status.error, rateLimited);
  assert.equal(mounted.handle.retryAvailableAt, undefined);
  assert.deepEqual(mounted.handle.traceStorage, { kind: "unsaved" });
  await mounted.unmount();
});

test("a finished run autosaves once to the project as a decision trace", async () => {
  const env = await load();
  const input = runInput();
  const saves = [];
  const workspace = {
    kind: "browser-directory",
    displayPath: "decisions-project",
    storage: {
      async saveTrace(runId, fileName, contents) { saves.push({ runId, fileName, contents }); },
    },
  };
  const mounted = await mountSession(env, { events: () => listStream(successEvents(env.systemOne, input)) });

  await mounted.act(async () => { await mounted.handle.start(input, { workspace }); });
  await mounted.act(async () => { await Promise.resolve(); });

  assert.equal(saves.length, 1);
  assert.equal(saves[0].fileName, `${input.runId}.json`);
  const saved = env.runTrace.parseSavedRunTraceJson(saves[0].contents);
  assert.equal(saved.kind, "decision");
  assert.equal(saved.trace.status.kind, "completed");
  assert.deepEqual(mounted.handle.traceStorage, {
    kind: "saved",
    location: `decisions-project/traces/${input.runId}.json`,
  });
  assert.equal(mounted.calls.saved, 1);

  await mounted.act(async () => { mounted.handle.stop(); });
  assert.equal(saves.length, 1, "a settled run is not saved again");
  await mounted.unmount();
});

test("adopting a trace stops live work and opens the run as stored", async () => {
  const env = await load();
  const finishedInput = runInput();
  const finished = await mountSession(env, { events: () => listStream(successEvents(env.systemOne, finishedInput)) });
  await finished.act(async () => { await finished.handle.start(finishedInput, { workspace: null }); });
  const trace = env.runTrace.parseSavedRunTraceJson(
    env.runTrace.serializeDecisionRunTrace(
      (await ssrLoadModule("/packages/core/src/decision-trace.ts")).decisionRunTrace(finished.handle.run),
    ),
  ).trace;
  await finished.unmount();

  const stream = controlledStream();
  const mounted = await mountSession(env, { events: () => stream.events });
  let running;
  await mounted.act(async () => { running = mounted.handle.start(runInput(), { workspace: null }); });
  assert.equal(mounted.handle.executing, true);

  await mounted.act(async () => { mounted.handle.adoptTrace(trace, { workspace: null, fileName: "imported.json" }); });
  await mounted.act(async () => { stream.end(); await running; });

  assert.equal(mounted.calls.executions[0].signal.aborted, true);
  assert.equal(mounted.handle.executing, false);
  assert.equal(mounted.handle.run.runId, finishedInput.runId);
  assert.equal(mounted.handle.run.status.kind, "completed");
  assert.deepEqual(mounted.handle.traceStorage, { kind: "loaded", fileName: "imported.json" });

  await mounted.act(async () => { mounted.handle.reset(); });
  assert.equal(mounted.handle.run, null);
  assert.equal(mounted.handle.traceStorage, null);
  await mounted.unmount();
});

test("a trace opened from the project is not saved back to it", async () => {
  const env = await load();
  const input = runInput();
  const finished = await mountSession(env, { events: () => listStream(successEvents(env.systemOne, input)) });
  await finished.act(async () => { await finished.handle.start(input, { workspace: null }); });
  const { decisionRunTrace } = await ssrLoadModule("/packages/core/src/decision-trace.ts");
  const trace = decisionRunTrace(finished.handle.run);
  await finished.unmount();

  const saves = [];
  const workspace = {
    kind: "browser-directory",
    displayPath: "decisions-project",
    storage: { async saveTrace(runId) { saves.push(runId); } },
  };
  const mounted = await mountSession(env, { events: () => listStream([]) });
  await mounted.act(async () => { mounted.handle.adoptTrace(trace, { workspace, fileName: `${input.runId}.json` }); });
  await mounted.act(async () => { await Promise.resolve(); });

  assert.deepEqual(saves, []);
  assert.deepEqual(mounted.handle.traceStorage, {
    kind: "saved",
    location: `decisions-project/traces/${input.runId}.json`,
  });
  await mounted.unmount();
});
