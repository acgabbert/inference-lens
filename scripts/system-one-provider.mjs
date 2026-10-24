import { createServer } from "node:http";
import { readdirSync, readFileSync } from "node:fs";

import { stopOnSignal } from "./fixture-shutdown.mjs";

/**
 * A System One fixture that replays the committed captures (D11-B, D15), so a
 * browser spec sees what real runtimes sent rather than what a fixture
 * imagined. One server, one path prefix per runtime personality:
 *
 * - `/llamacpp/v1`: listing marked in `data[]`; `/api/tags` is a 404.
 * - `/ollama/v1`: `/v1/models` marks nothing; `/ollama/api/tags` does.
 * - `/ollama-proxied/v1`: Ollama behind a proxy that forwards only `/v1/*`,
 *   so discovery ends unfiltered (D10's known degradation).
 * - `/openrouter/v1`: decision models only under `?output_modalities=decisions`.
 *
 * `POST <prefix>/v1/systemone` picks a capture by model id: the capture's file
 * name without its runtime prefix (`all-types`, `401`, `404-unknown-model`),
 * plus the synthetic `429`. A capture that recorded its request answers only
 * those questions; any others get that runtime's 400 envelope naming the
 * mismatch, so a spec that drifted from its capture fails instead of passing
 * on answers to questions it never asked.
 */

const host = "127.0.0.1";
const port = Number.parseInt(process.env.INFERENCE_LENS_SYSTEM_ONE_PORT ?? "4028", 10);
const fixtureDirectory = new URL("../tests/fixtures/system-one/", import.meta.url);

const RUNTIMES = ["llamacpp", "ollama", "openrouter"];

/** Captured fixtures only; doc-derived ones never stand in for a server. */
const captures = new Map(
  readdirSync(fixtureDirectory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => [
      name.slice(0, -".json".length),
      JSON.parse(readFileSync(new URL(name, fixtureDirectory), "utf8")),
    ])
    .filter(([, fixture]) => fixture.provenance?.kind === "captured"),
);

function captured(name) {
  const fixture = captures.get(name);
  if (!fixture) throw new Error(`No captured fixture ${name}.json.`);
  return fixture;
}

/** Each runtime's own error envelope, for errors no capture covers. */
const errorEnvelope = {
  llamacpp: (status, message) => ({
    error: { code: status, message, type: "invalid_request_error" },
  }),
  ollama: (_status, message) => ({ error: message }),
  openrouter: (status, message) => ({ error: { message, code: status } }),
};

/**
 * Ollama's `/v1/models` lists every model with no marker. It was not stored,
 * so it is derived from the captured `/api/tags` entries.
 */
function ollamaOpenAIListing() {
  return {
    object: "list",
    data: captured("ollama-models").response.body.models.map(({ name }) => ({
      id: name,
      object: "model",
      owned_by: "library",
    })),
  };
}

function listing(runtime, url) {
  switch (runtime) {
    case "llamacpp":
      // llama.cpp ignores the query and returns the same body (captured).
      return { status: 200, body: captured("llamacpp-models").response.body };
    case "ollama":
    case "ollama-proxied":
      return { status: 200, body: ollamaOpenAIListing() };
    case "openrouter":
      // The default listing omits every decision model (captured note); the
      // chat models it would list instead are not stored.
      return url.searchParams.get("output_modalities") === "decisions"
        ? { status: 200, body: captured("openrouter-models").response.body }
        : { status: 200, body: { data: [] } };
  }
}

function decision(runtime, request) {
  const scenario = typeof request?.model === "string" ? request.model : "";
  if (scenario === "429") {
    // Synthetic: no runtime's rate limit was captured.
    return {
      status: 429,
      headers: { "retry-after": "1" },
      body: errorEnvelope[runtime](429, "Synthetic rate limit from the System One fixture."),
    };
  }
  const name = `${runtime}-${scenario}`;
  const fixture = captures.get(name);
  if (!fixture) {
    return {
      status: 400,
      body: errorEnvelope[runtime](
        400,
        `The System One fixture has no ${runtime} scenario "${scenario}".`,
      ),
    };
  }
  if (
    fixture.request &&
    JSON.stringify(request.questions) !== JSON.stringify(fixture.request.questions)
  ) {
    return {
      status: 400,
      body: errorEnvelope[runtime](
        400,
        `The fixture expects the questions captured in ${name}.json.`,
      ),
    };
  }
  return { status: fixture.response.status, body: fixture.response.body };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

function send(response, { status, headers = {}, body }) {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  const [, runtime, ...rest] = url.pathname.split("/");
  const path = `/${rest.join("/")}`;
  const known = RUNTIMES.includes(runtime) || runtime === "ollama-proxied";
  const envelope = errorEnvelope[runtime === "ollama-proxied" ? "ollama" : runtime];

  if (known && request.method === "GET" && path === "/v1/models") {
    send(response, listing(runtime, url));
    return;
  }
  if (runtime === "ollama" && request.method === "GET" && path === "/api/tags") {
    send(response, { status: 200, body: captured("ollama-models").response.body });
    return;
  }
  if (known && request.method === "POST" && path === "/v1/systemone") {
    const body = await readJson(request);
    const answer = decision(runtime === "ollama-proxied" ? "ollama" : runtime, body);
    console.log(`${runtime} ${body?.model ?? "(no model)"}: HTTP ${answer.status}`);
    send(response, answer);
    return;
  }
  if (known) {
    send(response, { status: 404, body: envelope(404, `Not found: ${path}`) });
    return;
  }
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("Not found. Use /llamacpp/v1, /ollama/v1, /ollama-proxied/v1, or /openrouter/v1.");
});

stopOnSignal(server).listen(port, host, () => {
  console.log(`System One fixture provider listening on http://${host}:${port}`);
});
