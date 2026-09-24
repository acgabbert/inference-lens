import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("the probe CLI runs under the supported Node runtime", () => {
  const result = spawnSync(process.execPath, ["scripts/n8n-contract-probe.mjs"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      INFERENCE_LENS_N8N_BASE_URL: "",
      INFERENCE_LENS_N8N_API_KEY: "",
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing required argument --workflow-id/);
});

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

test("keeps parent and child workflow identities distinct in a tool capture", async (t) => {
  const root = await temporaryDirectory(t);
  const requests = [];
  const responses = new Map([
    ["/api/v1/workflows/parent_workflow", {
      id: "parent_workflow", name: "parent", active: false,
      nodes: [{
        id: "parent_node", name: "Tool", type: "test.tool", typeVersion: 1,
        parameters: {
          workflowId: {
            value: "child_workflow",
            cachedResultUrl: "/workflow/child_workflow",
          },
        },
      }], connections: {}, settings: {},
    }],
    ["/api/v1/workflows/child_workflow", {
      id: "child_workflow", name: "child", active: true,
      nodes: [], connections: {}, settings: {},
    }],
    ["/api/v1/executions/parent_execution?includeData=true", {
      id: "parent_execution", workflowId: "parent_workflow",
      status: "success", startedAt: "2026-09-24T00:00:00.000Z",
      stoppedAt: "2026-09-24T00:00:01.000Z",
      data: { resultData: { runData: { Tool: [{ startTime: 1790208000000 }] } } },
    }],
    ["/api/v1/executions/child_execution?includeData=true", {
      id: "child_execution", workflowId: "child_workflow",
      status: "success", data: {},
    }],
  ]);
  const rawDirectory = await captureN8nContract({
    baseUrl: "https://n8n.example.test",
    apiKey: "capture-secret",
    workflowId: "parent_workflow",
    subworkflowId: "child_workflow",
    executionIds: ["parent_execution", "child_execution"],
    captureName: "parent-child",
    stagingRoot: root,
    fetchImplementation: async (url) => {
      const resource = `${url.pathname}${url.search}`;
      requests.push(resource);
      return Response.json(responses.get(resource) ?? { error: "missing" }, {
        status: responses.has(resource) ? 200 : 404,
      });
    },
  });
  assert.deepEqual(requests, [...responses.keys()]);

  const projectedDirectory = path.join(root, "projected-parent-child");
  await redactN8nCapture({
    inputDirectory: rawDirectory,
    outputDirectory: projectedDirectory,
    n8nVersion: "2.32.5-test",
  });
  const manifest = await validateRedactedCapture({ directory: projectedDirectory });
  assert.equal(manifest.subworkflowId, "subworkflow_fixture");
  assert.deepEqual(manifest.subworkflowNodeTypes, []);
  assert.deepEqual(Object.keys(manifest.sourceFiles).sort(), [
    "execution-01.raw.json",
    "execution-02.raw.json",
    "subworkflow.raw.json",
    "workflow.raw.json",
  ]);
  assert.equal(
    JSON.parse(await readFile(path.join(projectedDirectory, "subworkflow.json"), "utf8")).id,
    "subworkflow_fixture",
  );
  assert.deepEqual(
    manifest.executions.map(({ workflowId }) => workflowId),
    ["workflow_fixture", "subworkflow_fixture"],
  );
  const projectedExecution = await readFile(
    path.join(projectedDirectory, "execution-success.json"),
    "utf8",
  );
  assert.doesNotMatch(projectedExecution, /startedAt|stoppedAt|startTime/);
  const projectedWorkflow = await readFile(
    path.join(projectedDirectory, "workflow.json"),
    "utf8",
  );
  assert.doesNotMatch(projectedWorkflow, /child_workflow/);
  assert.match(projectedWorkflow, /subworkflow_fixture/);

  const rawWorkflowPath = path.join(rawDirectory, "workflow.raw.json");
  const rawWorkflow = JSON.parse(await readFile(rawWorkflowPath, "utf8"));
  rawWorkflow.nodes[0].parameters.unrecognizedReference =
    "/workflow/child_workflow";
  await writeFile(rawWorkflowPath, JSON.stringify(rawWorkflow), "utf8");
  await assert.rejects(
    redactN8nCapture({
      inputDirectory: rawDirectory,
      outputDirectory: path.join(root, "leaked-workflow-id"),
      n8nVersion: "2.32.5-test",
    }),
    /configured secret/,
  );
});

test("bundles provider-wire evidence and projects it through redaction", async (t) => {
  const root = await temporaryDirectory(t);
  const providerDirectory = path.join(root, "provider");
  await mkdir(providerDirectory);
  const providerFiles = {
    "provider-request-initial.json": {
      model: "template-echo-model",
      tools: [
        {
          type: "function",
          function: {
            name: "il_echo_string",
            parameters: {
              type: "object",
              properties: {
                headers: { type: "string" },
                credentials: { type: "boolean" },
              },
            },
          },
        },
      ],
    },
    "provider-response-tool-call.json": {
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: "call_inference_lens_n8n_001",
                function: { name: "il_echo_string", arguments: '{"text":"x"}' },
              },
            ],
          },
        },
      ],
    },
    "provider-request-continuation.json": {
      messages: [
        {
          role: "tool",
          tool_call_id: "call_inference_lens_n8n_001",
          content: '[{"echo":"x"}]',
        },
      ],
    },
    "provider-response-final.json": {
      choices: [{ message: { role: "assistant", content: "done" } }],
    },
  };
  for (const [filename, value] of Object.entries(providerFiles)) {
    await writeFile(
      path.join(providerDirectory, filename),
      JSON.stringify(value),
      "utf8",
    );
  }

  const rawDirectory = await captureN8nContract({
    baseUrl: "https://n8n.example.test",
    apiKey: "capture-secret",
    workflowId: "workflow_real",
    executionIds: ["execution_real"],
    captureName: "with_provider",
    stagingRoot: root,
    providerCaptureDirectory: providerDirectory,
    capturedAt: "2026-07-28T00:00:00.000Z",
    fetchImplementation: async (url) =>
      Response.json(
        url.pathname.includes("/workflows/")
          ? {
              id: "workflow_real",
              name: "tool fixture",
              active: false,
              nodes: [],
              connections: {},
              settings: {},
            }
          : {
              id: "execution_real",
              workflowId: "workflow_real",
              mode: "manual",
              status: "success",
              finished: true,
              data: {},
            },
      ),
  });

  const rawManifest = JSON.parse(
    await readFile(path.join(rawDirectory, "capture-manifest.json"), "utf8"),
  );
  assert.deepEqual(rawManifest.files.provider, Object.keys(providerFiles));
  assert.equal(
    await readFile(
      path.join(rawDirectory, "provider-request-initial.json"),
      "utf8",
    ),
    JSON.stringify(providerFiles["provider-request-initial.json"]),
  );

  const projectedDirectory = path.join(root, "projected-provider");
  await redactN8nCapture({
    inputDirectory: rawDirectory,
    outputDirectory: projectedDirectory,
    n8nVersion: "2.38.10-test",
    projectedAt: "2026-07-28T00:01:00.000Z",
  });
  const manifest = await validateRedactedCapture({
    directory: projectedDirectory,
  });
  assert.deepEqual(manifest.providerFiles, Object.keys(providerFiles));
  for (const filename of Object.keys(providerFiles)) {
    assert.ok(manifest.files[filename]);
  }
  const initial = await readFile(
    path.join(projectedDirectory, "provider-request-initial.json"),
    "utf8",
  );
  assert.match(initial, /"headers"/);
  assert.match(initial, /"credentials"/);
  const continuation = JSON.parse(
    await readFile(
      path.join(projectedDirectory, "provider-request-continuation.json"),
      "utf8",
    ),
  );
  assert.equal(
    continuation.messages[0].tool_call_id,
    "call_inference_lens_n8n_001",
  );
  assert.equal(continuation.messages[0].content, '[{"echo":"x"}]');

  await writeFile(
    path.join(rawDirectory, "provider-request-initial.json"),
    JSON.stringify({ authorization: "Bearer must-not-survive" }),
    "utf8",
  );
  await assert.rejects(
    redactN8nCapture({
      inputDirectory: rawDirectory,
      outputDirectory: path.join(root, "rejected-provider"),
      n8nVersion: "2.38.10-test",
    }),
    /authorization material/,
  );
});

test("the probe forwards an optional provider capture directory", async () => {
  let received;
  const code = await runProbe({
    argv: [
      "--workflow-id",
      "workflow_1",
      "--subworkflow-id",
      "workflow_child",
      "--execution-id",
      "execution_1",
      "--capture-name",
      "capture_one",
      "--provider-capture",
      "/tmp/provider-capture",
    ],
    env: {
      INFERENCE_LENS_N8N_BASE_URL: "https://n8n.example.test",
      INFERENCE_LENS_N8N_API_KEY: "test-key",
    },
    stdout: { write() {} },
    stderr: { write() {} },
    capture: async (options) => {
      received = options;
      return "/tmp/raw-capture";
    },
  });

  assert.equal(code, 0);
  assert.equal(received.subworkflowId, "workflow_child");
  assert.equal(received.providerCaptureDirectory, "/tmp/provider-capture");
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
