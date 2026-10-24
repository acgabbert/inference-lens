import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import { after, before, test } from "node:test";

import type {
  DecisionExecution,
  DecisionInput,
  DecisionTransportEvent,
} from "../packages/core/src/decision.ts";
import { discoverDecisionModelsOverHttp } from "../packages/core/src/decision-discovery.ts";
import { createEntityId } from "../packages/core/src/run-kernel/index.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";
import { executeDecision } from "../services/api/src/index.ts";

/**
 * The System One fixture provider (D11-B, D15) drives every D10 discovery
 * step and every runtime's error envelope from the committed captures. These
 * run it as a process and talk to it through the same core code the hosts
 * use, so a passing run means a browser spec against it would see the
 * captures, not something the fixture made up.
 */

const port = 44031;
const base = `http://127.0.0.1:${port}`;
let child: ChildProcess;

async function listening(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture exited with ${child.exitCode}`);
    const connected = await new Promise<boolean>((resolve) => {
      const probe = net.connect(port, "127.0.0.1");
      probe.once("connect", () => {
        probe.destroy();
        resolve(true);
      });
      probe.once("error", () => resolve(false));
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("fixture did not start listening");
}

before(async () => {
  child = spawn(process.execPath, ["scripts/system-one-provider.mjs"], {
    env: { ...process.env, INFERENCE_LENS_SYSTEM_ONE_PORT: String(port) },
    stdio: "ignore",
  });
  await listening();
});

after(() => {
  child.kill("SIGTERM");
});

function capture(name: string): {
  request?: DecisionInput & { model: string };
  response: { status: number; body: unknown };
} {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/system-one/${name}.json`, import.meta.url), "utf8"),
  );
}

function discover(prefix: string) {
  return discoverDecisionModelsOverHttp({
    endpoint: `${base}/${prefix}/v1`,
    apiKey: "",
    capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
  });
}

async function decide(
  prefix: string,
  scenario: string,
  decision: DecisionInput,
): Promise<DecisionTransportEvent[]> {
  const execution: DecisionExecution = {
    runId: createEntityId("run", "fixture"),
    attempt: 1,
    exchangeId: createEntityId("exchange", "fixture"),
    input: {
      target: {
        profileId: createEntityId("profile", prefix),
        protocol: "systemone",
        endpoint: `${base}/${prefix}/v1`,
        model: scenario,
        capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
      },
      decision,
    },
  };
  const events: DecisionTransportEvent[] = [];
  for await (const event of executeDecision(execution, "")) events.push(event);
  return events;
}

function decisionOf(name: string): DecisionInput {
  const { state, questions } = capture(name).request!;
  return { state, questions };
}

test("each personality reaches its own discovery step", async () => {
  // Step 1: a marked listing (OpenRouter's filter, llama.cpp's data[] marker).
  assert.deepEqual(await discover("openrouter"), {
    models: ["~typesafe/jev-latest", "inception/mercury-decide:free"].sort((a, b) =>
      a.localeCompare(b),
    ),
  });
  assert.deepEqual(await discover("llamacpp"), { models: ["local-decision"] });
  // Step 2: Ollama marks nothing in /v1/models, so /api/tags decides.
  assert.deepEqual(await discover("ollama"), { models: ["tev1:0.8b"] });
  // Step 3: behind a proxy that forwards only /v1, nothing marks anything.
  assert.deepEqual(await discover("ollama-proxied"), {
    models: ["llama3.1:8b", "tev1:0.8b"],
    unfiltered: true,
  });
});

test("a scenario replays its capture's answers for the questions it was captured with", async () => {
  for (const prefix of ["llamacpp", "ollama", "openrouter"]) {
    const events = await decide(prefix, "all-types", decisionOf(`${prefix}-all-types`));
    const frame = events.find((event) => event.type === "frame");
    assert.equal(
      frame?.type === "frame" ? frame.frame.raw : undefined,
      JSON.stringify(capture(`${prefix}-all-types`).response.body),
      prefix,
    );
    assert.equal(events.at(-1)?.type, "completed", prefix);
  }
});

test("a captured error replays with its runtime's envelope and status", async () => {
  const cases = [
    ["llamacpp", "401", 401, "Invalid API Key"],
    ["ollama", "404-unknown-model", 404, "model 'nimble' not found"],
    ["openrouter", "401", 401, "User not found."],
  ] as const;
  for (const [prefix, scenario, status, message] of cases) {
    // An error captured with its request (an unknown model, too many options)
    // is answered only for that request, like any other capture.
    const decision = capture(`${prefix}-${scenario}`).request
      ? decisionOf(`${prefix}-${scenario}`)
      : decisionOf("llamacpp-all-types");
    const failed = (await decide(prefix, scenario, decision)).at(-1);
    assert.ok(failed?.type === "failed", `${prefix} ${scenario}`);
    assert.equal(failed.error.providerStatus, status);
    assert.equal(failed.error.message, message);
  }
});

test("questions that differ from the capture's fail loudly in the runtime's envelope", async () => {
  const other: DecisionInput = {
    state: "x",
    questions: { only: { type: "noul", instructions: "Is it?" } },
  };
  for (const prefix of ["llamacpp", "ollama", "openrouter"]) {
    const failed = (await decide(prefix, "all-types", other)).at(-1);
    assert.ok(failed?.type === "failed", prefix);
    assert.equal(failed.error.providerStatus, 400, prefix);
    assert.match(failed.error.message, /fixture expects .*all-types/, prefix);
  }
  const unknown = (await decide("llamacpp", "no-such-scenario", other)).at(-1);
  assert.ok(unknown?.type === "failed");
  assert.match(unknown.error.message, /no-such-scenario/);
});

test("the synthetic 429 asks for a retry after a second", async () => {
  const events = await decide("ollama", "429", decisionOf("ollama-all-types"));
  const response = events.find((event) => event.type === "response_started");
  assert.equal(
    response?.type === "response_started" ? response.response.headers["retry-after"] : undefined,
    "1",
  );
  const failed = events.at(-1);
  assert.ok(failed?.type === "failed");
  assert.equal(failed.error.providerStatus, 429);
  assert.equal(failed.error.retryable, true);
});
