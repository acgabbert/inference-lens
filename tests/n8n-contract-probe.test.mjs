import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertNoSensitiveText,
  buildPublicApiUrl,
  captureN8nContract,
  fetchN8nJson,
  N8nContractError,
  normalizeN8nBaseUrl,
  redactN8nCapture,
  validateRedactedCapture,
} from "../scripts/n8n-contract-lib.mjs";
import { main as runProbe } from "../scripts/n8n-contract-probe.mjs";

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "n8n-contract-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function recordedFetch(handler) {
  const requests = [];
  return {
    requests,
    fetch: async (url, init) => {
      requests.push({ url, init });
      return handler(url, init);
    },
  };
}

test("joins the public API prefix after an installation subpath", () => {
  const baseUrl = normalizeN8nBaseUrl("https://example.test/automation/");
  assert.equal(
    buildPublicApiUrl(
      baseUrl,
      "executions/execution_1?includeData=true",
    ).toString(),
    "https://example.test/automation/api/v1/executions/execution_1?includeData=true",
  );
  assert.throws(
    () => normalizeN8nBaseUrl("https://example.test/api/v1"),
    /exclude the \/api\/v1 suffix/,
  );
});

test("uses only GET and the n8n API-key header", async () => {
  const fixture = recordedFetch(async () => Response.json({ id: "workflow_1" }));

  const result = await fetchN8nJson({
    fetchImplementation: fixture.fetch,
    baseUrl: normalizeN8nBaseUrl("https://n8n.example.test"),
    apiKey: "test-secret-key",
    resourcePath: "workflows/workflow_1",
  });
  assert.deepEqual(result, { id: "workflow_1" });
  assert.equal(fixture.requests.length, 1);
  const [{ url, init }] = fixture.requests;
  assert.equal(url.toString(), "https://n8n.example.test/api/v1/workflows/workflow_1");
  assert.equal(init.method, "GET");
  assert.equal(init.headers.accept, "application/json");
  assert.equal(init.headers["X-N8N-API-KEY"], "test-secret-key");
  assert.equal(init.redirect, "manual");
  assert.ok(init.signal instanceof AbortSignal);
});

test("refuses redirects without contacting their target", async () => {
  const fixture = recordedFetch(async () => new Response(null, {
    status: 302,
    headers: { location: "https://attacker.example.test/stolen" },
  }));

  await assert.rejects(
    fetchN8nJson({
      fetchImplementation: fixture.fetch,
      baseUrl: normalizeN8nBaseUrl("https://n8n.example.test"),
      apiKey: "redirect-secret",
      resourcePath: "workflows/workflow_1",
    }),
    /redirect .*refused/,
  );
  assert.equal(fixture.requests.length, 1);
});

test("bounds successful responses and redacts keys from HTTP errors", async () => {
  let responseKind = "large";
  const apiKey = "never-print-this-key";
  const fixture = recordedFetch(async () => {
    if (responseKind === "large") {
      return Response.json({ data: "x".repeat(256) });
    }
    return new Response(`X-N8N-API-KEY=${apiKey} ${"y".repeat(3000)}`, { status: 401 });
  });

  await assert.rejects(
    fetchN8nJson({
      fetchImplementation: fixture.fetch,
      baseUrl: normalizeN8nBaseUrl("https://n8n.example.test"),
      apiKey,
      resourcePath: "workflows/workflow_1",
      responseLimitBytes: 64,
    }),
    /exceeds the 64-byte/,
  );

  responseKind = "error";
  await assert.rejects(
    fetchN8nJson({
      fetchImplementation: fixture.fetch,
      baseUrl: normalizeN8nBaseUrl("https://n8n.example.test"),
      apiKey,
      resourcePath: "workflows/workflow_1",
    }),
    (error) => {
      assert.ok(error instanceof N8nContractError);
      assert.doesNotMatch(error.message, new RegExp(apiKey));
      assert.ok(error.message.length < 1400);
      return true;
    },
  );
});

test("never prints the API key when the CLI receives an HTTP error", async () => {
  const apiKey = "cli-never-print-this-key";
  let stdout = "";
  let stderr = "";
  const code = await runProbe({
    argv: [
      "--workflow-id",
      "workflow_1",
      "--execution-id",
      "execution_1",
      "--capture-name",
      "cli_error",
    ],
    env: {
      INFERENCE_LENS_N8N_BASE_URL: "https://n8n.example.test",
      INFERENCE_LENS_N8N_API_KEY: apiKey,
    },
    stdout: { write: (text) => { stdout += text; } },
    stderr: { write: (text) => { stderr += text; } },
    capture: async ({ baseUrl, apiKey: suppliedApiKey }) => fetchN8nJson({
      baseUrl,
      apiKey: suppliedApiKey,
      resourcePath: "workflows/workflow_1",
      fetchImplementation: async () => new Response(
        `X-N8N-API-KEY=${apiKey}`,
        { status: 403 },
      ),
    }),
  });

  assert.equal(code, 1);
  assert.doesNotMatch(stdout, new RegExp(apiKey));
  assert.doesNotMatch(stderr, new RegExp(apiKey));
});

test("captures only the named workflow and execution IDs in staging", async (t) => {
  const fixture = recordedFetch(async (url) => {
    if (url.pathname === "/api/v1/workflows/workflow_1") {
      return Response.json({
        id: "workflow_1",
        name: "fixture",
        nodes: [],
        connections: {},
      });
    }
    if (
      url.pathname + url.search ===
      "/api/v1/executions/execution_1?includeData=true"
    ) {
      return Response.json({
        id: "execution_1",
        workflowId: "workflow_1",
        status: "success",
        data: {},
      });
    }
    return Response.json({ error: "unexpected path" }, { status: 404 });
  });
  const root = await temporaryDirectory(t);
  const apiKey = "capture-secret";
  const directory = await captureN8nContract({
    baseUrl: "https://n8n.example.test",
    apiKey,
    workflowId: "workflow_1",
    executionIds: ["execution_1"],
    captureName: "capture_one",
    stagingRoot: root,
    capturedAt: "2026-07-28T00:00:00.000Z",
    fetchImplementation: fixture.fetch,
  });

  assert.deepEqual(fixture.requests.map(({ url }) => `${url.pathname}${url.search}`), [
    "/api/v1/workflows/workflow_1",
    "/api/v1/executions/execution_1?includeData=true",
  ]);
  const manifest = await readFile(
    path.join(directory, "capture-manifest.json"),
    "utf8",
  );
  assert.doesNotMatch(manifest, new RegExp(apiKey));
  assert.doesNotMatch(manifest, /127\.0\.0\.1/);
  await assert.rejects(
    captureN8nContract({
      baseUrl: "https://n8n.example.test",
      apiKey,
      workflowId: "workflow_1",
      executionIds: ["execution_1"],
      captureName: "capture_one",
      stagingRoot: root,
      fetchImplementation: fixture.fetch,
    }),
    /already exists/,
  );
});

test("projects IDs, removes credential material, and validates digests", async (t) => {
  const root = await temporaryDirectory(t);
  const rawDirectory = path.join(root, "raw");
  const outputDirectory = path.join(root, "projected");
  await captureN8nContract({
    baseUrl: "https://n8n.example.test",
    apiKey: "capture-secret",
    workflowId: "workflow_real",
    executionIds: ["execution_real"],
    captureName: "raw",
    stagingRoot: root,
    capturedAt: "2026-07-28T00:00:00.000Z",
    fetchImplementation: async (url) => {
      if (url.pathname.endsWith("/workflows/workflow_real")) {
        return new Response(
          JSON.stringify({
            id: "workflow_real",
            name: "[Inference Lens fixture] Basic LLM Chain",
            active: false,
            nodes: [
              {
                id: "node_real",
                name: "Basic LLM Chain",
                type: "@n8n/n8n-nodes-langchain.chainLlm",
                typeVersion: 1.9,
                position: [0, 0],
                parameters: { text: "Hello {{ $json.name }}" },
                credentials: {
                  openAiApi: { id: "credential_real", name: "private" },
                },
              },
            ],
            connections: {},
            settings: {
              executionOrder: "v1",
              saveManualExecutions: true,
            },
            meta: { instanceId: "instance_real" },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          id: "execution_real",
          workflowId: "workflow_real",
          mode: "manual",
          status: "success",
          finished: true,
          startedAt: "2026-07-28T00:00:00.000Z",
          stoppedAt: "2026-07-28T00:00:01.000Z",
          data: {
            resultData: {
              runData: {
                "Basic LLM Chain": [
                  {
                    data: { main: [[{ json: { output: "fixture result" } }]] },
                    inputOverride: {
                      ai_languageModel: [
                        [
                          {
                            json: {
                              options: {
                                openai_api_key: {
                                  lc: 1,
                                  type: "secret",
                                  id: ["OPENAI_API_KEY"],
                                },
                                configuration: {
                                  baseURL: "http://192.168.1.8:4013/v1",
                                  defaultHeaders: {
                                    "openai-platform": "private-organization-id",
                                  },
                                },
                              },
                            },
                          },
                        ],
                      ],
                    },
                  },
                ],
              },
            },
            workflowData: {
              id: "workflow_real",
              name: "snapshot",
              nodes: [
                {
                  id: "node_real",
                  name: "Basic LLM Chain",
                  type: "@n8n/n8n-nodes-langchain.chainLlm",
                  typeVersion: 1.9,
                  parameters: { text: "Hello {{ $json.name }}" },
                  position: [0, 0],
                  credentials: {
                    openAiApi: { id: "credential_real", name: "private" },
                  },
                },
              ],
              connections: {},
              settings: {},
            },
          },
        }),
        { status: 200 },
      );
    },
  });

  await redactN8nCapture({
    inputDirectory: rawDirectory,
    outputDirectory,
    n8nVersion: "2.0.0-test",
    knownSecrets: ["capture-secret", "https://n8n.example.test"],
    projectedAt: "2026-07-28T00:01:00.000Z",
  });
  const manifest = await validateRedactedCapture({
    directory: outputDirectory,
    knownSecrets: ["capture-secret", "https://n8n.example.test"],
  });
  assert.equal(manifest.n8nVersion, "2.0.0-test");
  assert.deepEqual(manifest.executions[0].runItemCounts, {
    "Basic LLM Chain": [1],
  });

  const allFiles = await Promise.all(
    ["manifest.json", "workflow.json", "execution-success.json"].map(
      (filename) => readFile(path.join(outputDirectory, filename), "utf8"),
    ),
  );
  const combined = allFiles.join("\n");
  const projectedPayloads = allFiles.slice(1).join("\n");
  assert.doesNotMatch(combined, /workflow_real|execution_real|node_real/);
  assert.doesNotMatch(combined, /credential_real|instance_real/);
  assert.doesNotMatch(combined, /192\.168\.1\.8/);
  assert.doesNotMatch(
    projectedPayloads,
    /private-organization-id|OPENAI_API_KEY|openai_api_key/,
  );
  assert.match(combined, /"removedFields": \[\s*"baseURL"/);
  assert.match(combined, /workflow_fixture/);
  assert.match(combined, /node_fixture_/);
  assert.match(combined, /fixture result/);

  await writeFile(
    path.join(outputDirectory, "workflow.json"),
    "{}\n",
    "utf8",
  );
  await assert.rejects(
    validateRedactedCapture({ directory: outputDirectory }),
    /Digest mismatch/,
  );
});

test("rejects configured secrets and private topology in projections", () => {
  assert.throws(
    () => assertNoSensitiveText('{"value":"top-secret-value"}', ["top-secret-value"]),
    /configured secret/,
  );
  assert.throws(
    () => assertNoSensitiveText('{"url":"http://192.168.1.8:5678"}'),
    /private or loopback/,
  );
  assert.throws(
    () => assertNoSensitiveText('{"X-N8N-API-KEY":"value"}'),
    /API-key header/,
  );
});
