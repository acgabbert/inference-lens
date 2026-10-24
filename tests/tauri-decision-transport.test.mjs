import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ssrLoadModule } from "./support/ssr.mjs";

/**
 * The desktop decision transport, driven through Tauri's own IPC boundary.
 *
 * `@tauri-apps/api` dispatches every `invoke` and `listen` through
 * `window.__TAURI_INTERNALS__`, so installing that object runs the shipped
 * transport unchanged. The backend behind it is a stand-in for `src-tauri`'s
 * raw proxy: it emits the same `RawStreamEvent` payloads on the same event
 * name, and honours `cancel_provider_turn` only for a turn it has started, as
 * `ActiveRuns` does. That proves the webview half of the contract; the Rust
 * half is pinned by `cargo test`.
 */

const TRUNCATED_MESSAGE_CHARS = 4_000;

function fixture(name) {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/system-one/${name}.json`, import.meta.url), "utf8"),
  );
}

const allTypes = fixture("llamacpp-all-types");

/**
 * Synthetic: the documented FastAPI 422 envelope (`typesafe-422`) with enough
 * issues to exceed the 4,000-character summary. No captured validation body
 * is that long.
 */
function longValidationBody() {
  const [issue] = fixture("typesafe-422").response.body.detail;
  const detail = Array.from({ length: 60 }, (_, index) => ({
    ...issue,
    loc: ["body", "questions", `question_${index}`, "criteria"],
  }));
  const body = JSON.stringify({ detail });
  assert.ok(body.length > TRUNCATED_MESSAGE_CHARS);
  return body;
}

async function loadModules() {
  const [transport, service, ids, types] = await Promise.all([
    ssrLoadModule("/app/tauri-inference-transport.client.ts"),
    ssrLoadModule("/services/api/src/index.ts"),
    ssrLoadModule("/packages/core/src/run-kernel/index.ts"),
    ssrLoadModule("/packages/core/src/types.ts"),
  ]);
  return { transport, service, ids, types };
}

function decisionExecution({ ids, types }) {
  const { model, state, questions } = allTypes.request;
  return {
    runId: ids.createEntityId("run", "decision"),
    attempt: 1,
    exchangeId: ids.createEntityId("exchange", "decision"),
    input: {
      target: {
        profileId: ids.createEntityId("profile", "llamacpp"),
        protocol: "systemone",
        endpoint: "https://llm.example.test/v1",
        model,
        capabilities: types.OPENAI_COMPATIBLE_CAPABILITIES,
      },
      decision: { state, questions },
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Installs the IPC stand-in. `respond(requestId, emit)` plays one turn after
 * `start_provider_turn` returns, as Rust's spawned task does; `hooks` let a
 * test act at a precise point in the startup sequence.
 */
function installNative({ respond = () => {}, hooks = {} } = {}) {
  const callbacks = new Map();
  const listeners = new Map();
  const running = new Set();
  const calls = [];
  let nextId = 1;

  function emit(requestId, payload) {
    if (!running.has(requestId)) return;
    if (["end", "error", "cancelled"].includes(payload.type)) running.delete(requestId);
    const event = `inference-lens://provider-turn/${requestId}`;
    const handler = listeners.get(event);
    if (handler !== undefined) callbacks.get(handler)({ event, id: 0, payload });
  }

  globalThis.window = {
    __TAURI_INTERNALS__: {
      transformCallback(callback) {
        const id = nextId++;
        callbacks.set(id, callback);
        return id;
      },
      async invoke(command, args = {}) {
        calls.push({ command, args });
        switch (command) {
          case "plugin:event|listen":
            await hooks.listening?.();
            listeners.set(args.event, args.handler);
            return nextId++;
          case "plugin:event|unlisten":
            listeners.delete(args.event);
            return undefined;
          case "start_provider_turn": {
            const { requestId } = args;
            running.add(requestId);
            await hooks.starting?.();
            setTimeout(() => respond(requestId, (payload) => emit(requestId, payload)), 0);
            return { status: 202 };
          }
          case "cancel_provider_turn":
            // Rust cancels only a token it has registered.
            emit(args.requestId, { type: "cancelled" });
            return undefined;
          default:
            throw new Error(`Unhandled native command ${command}.`);
        }
      },
    },
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
  };
  return {
    calls,
    commands: () => calls.map((call) => call.command),
    listening: () => listeners.size,
  };
}

async function collect(stream) {
  const events = [];
  for await (const event of stream.events) events.push(event);
  return events;
}

function request(modules) {
  return {
    execution: decisionExecution(modules),
    credential: { kind: "provided", apiKey: "test-key" },
  };
}

test("a provider error body over 4,000 characters is kept whole and read the same as on the web", async () => {
  const modules = await loadModules();
  const body = longValidationBody();
  installNative({
    respond(_requestId, emit) {
      emit({ type: "response", status: 422, headers: { "content-type": "application/json" } });
      // Rust's shared error event: `message` stays the shortened summary and
      // `body` carries the complete response (D25).
      emit({
        type: "error",
        kind: "provider",
        message: body.slice(0, TRUNCATED_MESSAGE_CHARS),
        status: 422,
        body,
      });
    },
  });

  const transport = new modules.transport.TauriInferenceTransport();
  const desktop = await collect(await transport.executeDecision(request(modules)));

  // The web service reads the same body with the same core reader.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(body, { status: 422 });
  const web = [];
  try {
    for await (const event of modules.service.executeDecision(decisionExecution(modules), "test-key")) {
      web.push(event);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  for (const events of [desktop, web]) {
    const frame = events.find((event) => event.type === "frame");
    assert.equal(frame?.frame.raw.length, body.length);
    assert.equal(frame?.frame.raw, body);
  }

  const desktopFailure = desktop.at(-1);
  const webFailure = web.at(-1);
  assert.equal(desktopFailure?.type, "failed");
  assert.deepEqual(desktopFailure, webFailure);
  assert.match(desktopFailure.error.message, /^body\.questions\.question_59\.criteria: /m);
});

test("an already-aborted signal never dispatches the native request", async () => {
  const modules = await loadModules();
  const native = installNative({
    respond(_requestId, emit) {
      emit({ type: "response", status: 200, headers: {} });
      emit({ type: "body", body: JSON.stringify(allTypes.response.body) });
      emit({ type: "end" });
    },
  });
  const controller = new AbortController();
  controller.abort();

  const transport = new modules.transport.TauriInferenceTransport();
  await assert.rejects(
    transport.executeDecision(request(modules), controller.signal),
    { name: "AbortError" },
  );
  assert.ok(!native.commands().includes("start_provider_turn"));
  assert.equal(native.listening(), 0);
});

test("an abort while the listener registers never dispatches the native request", async () => {
  const modules = await loadModules();
  const controller = new AbortController();
  const native = installNative({
    hooks: { listening: () => controller.abort() },
    respond(_requestId, emit) {
      emit({ type: "response", status: 200, headers: {} });
      emit({ type: "body", body: JSON.stringify(allTypes.response.body) });
      emit({ type: "end" });
    },
  });

  const transport = new modules.transport.TauriInferenceTransport();
  await assert.rejects(
    transport.executeDecision(request(modules), controller.signal),
    { name: "AbortError" },
  );
  assert.ok(!native.commands().includes("start_provider_turn"));
  assert.equal(native.listening(), 0);
});

test("an abort while the native command starts cancels the started turn", async () => {
  const modules = await loadModules();
  const controller = new AbortController();
  const native = installNative({
    hooks: { starting: () => controller.abort() },
    respond(_requestId, emit) {
      emit({ type: "response", status: 200, headers: {} });
      emit({ type: "body", body: JSON.stringify(allTypes.response.body) });
      emit({ type: "end" });
    },
  });

  const transport = new modules.transport.TauriInferenceTransport();
  await assert.rejects(
    transport.executeDecision(request(modules), controller.signal),
    { name: "AbortError" },
  );
  const commands = native.commands();
  const started = commands.indexOf("start_provider_turn");
  assert.ok(started >= 0);
  // A cancel sent before the turn was registered is a no-op in Rust, so one
  // must follow the start.
  assert.ok(commands.indexOf("cancel_provider_turn", started + 1) > started);
  assert.equal(native.listening(), 0);
});

test("a completion already received when the run is stopped does not replace the cancellation", async () => {
  const modules = await loadModules();
  installNative({
    respond(_requestId, emit) {
      emit({ type: "response", status: 200, headers: {} });
      emit({ type: "body", body: JSON.stringify(allTypes.response.body) });
      emit({ type: "end" });
    },
  });
  const controller = new AbortController();
  const transport = new modules.transport.TauriInferenceTransport();
  const stream = await transport.executeDecision(request(modules), controller.signal);
  // Rust finishes the turn before the webview reads it.
  await tick();
  await tick();
  controller.abort();

  const events = await collect(stream);
  assert.ok(!events.some((event) => event.type === "completed"));
  assert.deepEqual(events.at(-1), { type: "cancelled", reason: "Request aborted." });
});

test("a stop ends the stream as cancelled even if the native side never answers", async () => {
  const modules = await loadModules();
  const native = installNative({
    respond(_requestId, emit) {
      emit({ type: "response", status: 200, headers: {} });
    },
  });
  // Rust no longer answers this turn's cancel.
  const { invoke } = globalThis.window.__TAURI_INTERNALS__;
  globalThis.window.__TAURI_INTERNALS__.invoke = async (command, args) =>
    command === "cancel_provider_turn"
      ? (native.calls.push({ command, args }), undefined)
      : invoke(command, args);

  const controller = new AbortController();
  const transport = new modules.transport.TauriInferenceTransport();
  const stream = await transport.executeDecision(request(modules), controller.signal);
  const reading = collect(stream);
  await tick();
  await tick();
  controller.abort();

  const events = await Promise.race([
    reading,
    new Promise((resolve) => setTimeout(() => resolve("still waiting after 2 s"), 2_000)),
  ]);
  assert.deepEqual(Array.isArray(events) ? events.at(-1) : events, {
    type: "cancelled",
    reason: "Request aborted.",
  });
  assert.ok(native.commands().includes("cancel_provider_turn"));
  assert.equal(native.listening(), 0);
});
