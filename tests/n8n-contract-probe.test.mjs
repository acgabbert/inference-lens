import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
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

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "n8n-contract-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function startServer(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

function json(response, value, status = 200, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  response.end(body);
}

async function runProbe(argumentsList, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["scripts/n8n-contract-probe.mjs", ...argumentsList],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        env: { ...process.env, ...environment },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
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

test("uses only GET and the n8n API-key header", async (t) => {
  const seen = [];
  const baseUrl = await startServer(t, (request, response) => {
    seen.push({
      method: request.method,
      url: request.url,
      apiKey: request.headers["x-n8n-api-key"],
      authorization: request.headers.authorization,
    });
    json(response, { id: "workflow_1" });
  });

  const result = await fetchN8nJson({
    baseUrl: normalizeN8nBaseUrl(baseUrl),
    apiKey: "test-secret-key",
    resourcePath: "workflows/workflow_1",
  });
  assert.deepEqual(result, { id: "workflow_1" });
  assert.deepEqual(seen, [
    {
      method: "GET",
      url: "/api/v1/workflows/workflow_1",
      apiKey: "test-secret-key",
      authorization: undefined,
    },
  ]);
});

test("refuses redirects without contacting their target", async (t) => {
  let targetRequests = 0;
  const targetUrl = await startServer(t, (_request, response) => {
    targetRequests += 1;
    json(response, { shouldNot: "arrive" });
  });
  const baseUrl = await startServer(t, (_request, response) => {
    response.writeHead(302, { location: `${targetUrl}/stolen` });
    response.end();
  });

  await assert.rejects(
    fetchN8nJson({
      baseUrl: normalizeN8nBaseUrl(baseUrl),
      apiKey: "redirect-secret",
      resourcePath: "workflows/workflow_1",
    }),
    /redirect .*refused/,
  );
  assert.equal(targetRequests, 0);
});

test("bounds successful responses and redacts keys from HTTP errors", async (t) => {
  let responseKind = "large";
  const apiKey = "never-print-this-key";
  const baseUrl = await startServer(t, (_request, response) => {
    if (responseKind === "large") {
      json(response, { data: "x".repeat(256) });
      return;
    }
    response.writeHead(401, { "content-type": "text/plain" });
    response.end(`X-N8N-API-KEY=${apiKey} ${"y".repeat(3000)}`);
  });

  await assert.rejects(
    fetchN8nJson({
      baseUrl: normalizeN8nBaseUrl(baseUrl),
      apiKey,
      resourcePath: "workflows/workflow_1",
      responseLimitBytes: 64,
    }),
    /exceeds the 64-byte/,
  );

  responseKind = "error";
  await assert.rejects(
    fetchN8nJson({
      baseUrl: normalizeN8nBaseUrl(baseUrl),
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

test("never prints the API key when the CLI receives an HTTP error", async (t) => {
  const apiKey = "cli-never-print-this-key";
  const baseUrl = await startServer(t, (_request, response) => {
    response.writeHead(403, { "content-type": "text/plain" });
    response.end(`X-N8N-API-KEY=${apiKey}`);
  });
  const captureName = `cli_error_${process.pid}_${Date.now()}`;
  const stagedDirectory = path.resolve(
    import.meta.dirname,
    "..",
    ".n8n-contract-staging",
    captureName,
  );
  t.after(() => rm(stagedDirectory, { recursive: true, force: true }));
  const result = await runProbe(
    [
      "--workflow-id",
      "workflow_1",
      "--execution-id",
      "execution_1",
      "--capture-name",
      captureName,
    ],
    {
      INFERENCE_LENS_N8N_BASE_URL: baseUrl,
      INFERENCE_LENS_N8N_API_KEY: apiKey,
    },
  );

  assert.equal(result.code, 1);
  assert.doesNotMatch(result.stdout, new RegExp(apiKey));
  assert.doesNotMatch(result.stderr, new RegExp(apiKey));
});

test("captures only the named workflow and execution IDs in staging", async (t) => {
  const requests = [];
  const baseUrl = await startServer(t, (request, response) => {
    requests.push(request.url);
    if (request.url === "/api/v1/workflows/workflow_1") {
      json(response, {
        id: "workflow_1",
        name: "fixture",
        nodes: [],
        connections: {},
      });
      return;
    }
    if (
      request.url ===
      "/api/v1/executions/execution_1?includeData=true"
    ) {
      json(response, {
        id: "execution_1",
        workflowId: "workflow_1",
        status: "success",
        data: {},
      });
      return;
    }
    json(response, { error: "unexpected path" }, 404);
  });
  const root = await temporaryDirectory(t);
  const apiKey = "capture-secret";
  const directory = await captureN8nContract({
    baseUrl,
    apiKey,
    workflowId: "workflow_1",
    executionIds: ["execution_1"],
    captureName: "capture_one",
    stagingRoot: root,
    capturedAt: "2026-07-28T00:00:00.000Z",
  });

  assert.deepEqual(requests, [
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
      baseUrl,
      apiKey,
      workflowId: "workflow_1",
      executionIds: ["execution_1"],
      captureName: "capture_one",
      stagingRoot: root,
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
