import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  EnvironmentN8nCredentialSource,
  handleN8nExecutionDetailRequest,
  handleN8nExecutionsRequest,
  handleN8nStatusRequest,
  handleN8nWorkflowsRequest,
  N8nClient,
  N8nIntegrationError,
  parseN8nConfiguration,
  parseN8nExecutionLink,
} from "../services/api/src/index.ts";

const baseUrl = "https://n8n.example.test/automation";
const apiKey = "n8n-secret-that-must-never-leak";
const configuredEnvironment = {
  INFERENCE_LENS_N8N_BASE_URL: baseUrl,
  INFERENCE_LENS_N8N_API_KEY: apiKey,
};

function jsonResponse(
  value: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  return Response.json(value, { status, headers });
}

function sameOriginRequest(
  path: string,
  init: RequestInit = {},
): Request {
  return new Request(`http://localhost:3000${path}`, {
    ...init,
    headers: {
      origin: "http://localhost:3000",
      ...init.headers,
    },
  });
}

test("reports unavailable, misconfigured, and configured states without connection secrets", async () => {
  assert.deepEqual(parseN8nConfiguration({}), { state: "unavailable" });
  assert.deepEqual(
    parseN8nConfiguration({
      INFERENCE_LENS_N8N_BASE_URL: baseUrl,
    }),
    {
      state: "misconfigured",
      message:
        "Set both INFERENCE_LENS_N8N_BASE_URL and INFERENCE_LENS_N8N_API_KEY, or leave both unset.",
    },
  );
  assert.deepEqual(
    new EnvironmentN8nCredentialSource(
      configuredEnvironment,
    ).publicConfiguration(),
    { state: "configured" },
  );

  const response = handleN8nStatusRequest(
    sameOriginRequest("/api/integrations/n8n/status"),
    configuredEnvironment,
  );
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { state: "configured" });
  assert.doesNotMatch(text, new RegExp(apiKey));
  assert.doesNotMatch(text, /n8n\.example\.test/);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("rejects invalid base URLs without reflecting their credential-like parts", async () => {
  const response = handleN8nStatusRequest(
    sameOriginRequest("/api/integrations/n8n/status"),
    {
      INFERENCE_LENS_N8N_BASE_URL:
        "https://user:password@n8n.example.test/?apiKey=hidden",
      INFERENCE_LENS_N8N_API_KEY: apiKey,
    },
  );
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /must not contain credentials, a query, or a fragment/);
  assert.doesNotMatch(text, /password|apiKey=hidden|n8n-secret/);
});

test("parses execution links only within the configured n8n base URL", () => {
  const configuredBaseUrl = new URL(baseUrl);
  assert.deepEqual(
    parseN8nExecutionLink(
      configuredBaseUrl,
      `${baseUrl}/workflow/workflow_1/executions/execution-2/?source=copy#node`,
    ),
    {
      workflowId: "workflow_1",
      executionId: "execution-2",
    },
  );

  for (const value of [
    "https://attacker.test/automation/workflow/workflow_1/executions/execution_1",
    "https://n8n.example.test/workflow/workflow_1/executions/execution_1",
    `${baseUrl}/workflow/workflow_1`,
    `${baseUrl}/workflow/../executions/execution_1`,
  ]) {
    assert.throws(
      () => parseN8nExecutionLink(configuredBaseUrl, value),
      (error: unknown) =>
        error instanceof N8nIntegrationError &&
        error.code === "request-invalid",
    );
  }
});

test("lists workflow summaries through the installation subpath and drops unknown data", async () => {
  const requests: Array<{
    url: string;
    method: string | undefined;
    apiKey: string | null;
    redirect: RequestRedirect | undefined;
  }> = [];
  const fetchImplementation: typeof fetch = async (input, init) => {
    const requestUrl = input.toString();
    requests.push({
      url: requestUrl,
      method: init?.method,
      apiKey: new Headers(init?.headers).get("x-n8n-api-key"),
      redirect: init?.redirect,
    });
    return jsonResponse({
      data: [
        {
          id: "workflow_1",
          name: "Fixture workflow",
          active: false,
          createdAt: "2026-07-28T12:00:00.000Z",
          credentials: { forbidden: "browser must not receive this" },
          nodes: [{ parameters: { secret: "also forbidden" } }],
        },
      ],
      nextCursor: "cursor+/=",
      unrelated: true,
    });
  };

  const client = new N8nClient(
    new EnvironmentN8nCredentialSource(configuredEnvironment).resolve(),
    { fetchImplementation },
  );
  assert.deepEqual(await client.listWorkflows(), {
    items: [
      {
        id: "workflow_1",
        name: "Fixture workflow",
        active: false,
        createdAt: "2026-07-28T12:00:00.000Z",
      },
    ],
    nextCursor: "cursor+/=",
  });
  assert.deepEqual(requests, [
    {
      url:
        "https://n8n.example.test/automation/api/v1/workflows?" +
        "limit=50&excludePinnedData=true",
      method: "GET",
      apiKey,
      redirect: "manual",
    },
  ]);
});

test("lists execution summaries without requesting or returning execution data", async () => {
  let seenUrl = "";
  const fetchImplementation: typeof fetch = async (input) => {
    seenUrl = input.toString();
    return jsonResponse({
      data: [
        {
          id: "execution_1",
          workflowId: "workflow_1",
          status: "success",
          mode: "manual",
          finished: true,
          startedAt: "2026-07-28T12:00:00.000Z",
          stoppedAt: "2026-07-28T12:00:01.000Z",
          data: { forbidden: "list detail" },
        },
      ],
      nextCursor: null,
    });
  };
  const response = await handleN8nExecutionsRequest(
    sameOriginRequest(
      "/api/integrations/n8n/executions?workflowId=workflow_1&cursor=opaque%2B%2F%3D",
    ),
    configuredEnvironment,
    undefined,
    fetchImplementation,
  );
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(text), {
    executions: [
      {
        id: "execution_1",
        workflowId: "workflow_1",
        status: "success",
        mode: "manual",
        finished: true,
        startedAt: "2026-07-28T12:00:00.000Z",
        stoppedAt: "2026-07-28T12:00:01.000Z",
      },
    ],
  });
  const requestUrl = new URL(seenUrl);
  assert.equal(requestUrl.pathname, "/automation/api/v1/executions");
  assert.equal(requestUrl.searchParams.get("workflowId"), "workflow_1");
  assert.equal(requestUrl.searchParams.get("includeData"), "false");
  assert.equal(requestUrl.searchParams.get("limit"), "50");
  assert.equal(requestUrl.searchParams.get("cursor"), "opaque+/=");
  assert.doesNotMatch(text, /forbidden|n8n-secret|n8n\.example\.test/);
});

test("fetches selected execution detail lazily but returns only its safe normalized projection", async () => {
  const requests: string[] = [];
  const fetchImplementation: typeof fetch = async (input) => {
    requests.push(input.toString());
    if (input.toString().includes("/workflows/workflow_1")) {
      return jsonResponse({
        id: "workflow_1",
        name: "Current workflow",
        nodes: [],
        connections: {},
      });
    }
    return jsonResponse({
      id: "execution_1",
      workflowId: "workflow_1",
      status: "success",
      mode: "manual",
      finished: true,
      startedAt: "2026-07-28T12:00:00.000Z",
      stoppedAt: "2026-07-28T12:00:01.000Z",
      data: {
        workflowData: {
          credentials: { apiKey },
          nodes: [{ parameters: { prompt: "private prompt" } }],
        },
      },
    });
  };
  const response = await handleN8nExecutionDetailRequest(
    sameOriginRequest("/api/integrations/n8n/execution-detail", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflowId: "workflow_1",
        executionId: "execution_1",
      }),
    }),
    configuredEnvironment,
    undefined,
    fetchImplementation,
  );
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(text), {
    execution: {
      id: "execution_1",
      workflowId: "workflow_1",
      status: "success",
      mode: "manual",
      finished: true,
      startedAt: "2026-07-28T12:00:00.000Z",
      stoppedAt: "2026-07-28T12:00:01.000Z",
    },
    detailAvailable: true,
    discovery: {
      status: "no-supported-invocations",
      message:
        "This workflow contains no AI invocation supported by this importer.",
    },
    extractions: [],
  });
  assert.deepEqual(requests, [
    "https://n8n.example.test/automation/api/v1/executions/execution_1?includeData=true",
    "https://n8n.example.test/automation/api/v1/workflows/workflow_1",
  ]);
  assert.doesNotMatch(text, /private prompt|credentials|n8n-secret/);
});

test("an unreadable node falls back to the current workflow without failing it", async () => {
  const fetchImplementation: typeof fetch = async (input) => {
    if (input.toString().includes("/workflows/workflow_1")) {
      return jsonResponse({
        id: "workflow_1",
        name: "Changed workflow",
        // A node this importer cannot read. The workflow envelope is still
        // sound, so the workflow itself must remain importable.
        nodes: [{}],
        connections: {},
      });
    }
    return jsonResponse({
      id: "execution_1",
      workflowId: "workflow_1",
      status: "success",
      data: { workflowData: { nodes: "changed shape" } },
    });
  };
  const response = await handleN8nExecutionDetailRequest(
    sameOriginRequest("/api/integrations/n8n/execution-detail", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflowId: "workflow_1",
        executionId: "execution_1",
      }),
    }),
    configuredEnvironment,
    undefined,
    fetchImplementation,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    execution: {
      id: "execution_1",
      workflowId: "workflow_1",
      status: "success",
    },
    detailAvailable: true,
    discovery: {
      status: "no-supported-invocations",
      message:
        "This workflow contains no AI invocation supported by this importer.",
    },
    extractions: [],
  });
});

test("accepts the redacted Phase 0 workflow and execution detail fixtures", async () => {
  const fixtureRoot = path.resolve(
    import.meta.dirname,
    "fixtures/n8n/captures/2.32.5/basic-llm-chain-success",
  );
  const [workflow, execution] = await Promise.all(
    ["workflow.json", "execution-success.json"].map(async (filename) =>
      JSON.parse(await readFile(path.join(fixtureRoot, filename), "utf8")),
    ),
  );
  const fetchImplementation: typeof fetch = async (input) => {
    const url = new URL(input.toString());
    if (url.pathname.endsWith("/workflows/workflow_fixture")) {
      return jsonResponse(workflow);
    }
    if (url.pathname.endsWith("/executions/execution_fixture_001")) {
      return jsonResponse(execution);
    }
    return jsonResponse({ message: "unexpected fixture path" }, 404);
  };
  const client = new N8nClient(
    new EnvironmentN8nCredentialSource(configuredEnvironment).resolve(),
    { fetchImplementation },
  );

  const workflowDetail = await client.getWorkflow("workflow_fixture");
  assert.equal(workflowDetail.name, "[Inference Lens fixture] Basic LLM Chain");
  assert.equal(workflowDetail.nodes.length, 5);
  const executionDetail = await client.getExecution("execution_fixture_001");
  assert.equal(executionDetail.workflowId, "workflow_fixture");
  assert.equal(executionDetail.status, "success");
  assert.ok(executionDetail.data);
});

test("the execution-detail route returns normalized candidates without raw execution or provider response data", async () => {
  const fixtureRoot = path.resolve(
    import.meta.dirname,
    "fixtures/n8n/captures/2.32.5/basic-llm-chain-success",
  );
  const execution = JSON.parse(
    await readFile(path.join(fixtureRoot, "execution-success.json"), "utf8"),
  ) as {
    data: {
      resultData: {
        runData: Record<string, unknown>;
      };
    };
  };
  const runData = execution.data.resultData.runData;
  const parentRuns = runData["Compound prompt cases"] as Array<{
    data: { main: unknown[][] };
  }>;
  parentRuns[0]!.data.main[0] = parentRuns[0]!.data.main[0]!.slice(0, 1);
  runData["Fixture OpenAI Chat Model"] = (
    runData["Fixture OpenAI Chat Model"] as unknown[]
  ).slice(0, 1);

  const response = await handleN8nExecutionDetailRequest(
    sameOriginRequest("/api/integrations/n8n/execution-detail", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflowId: "workflow_fixture",
        executionId: "execution_fixture_001",
      }),
    }),
    configuredEnvironment,
    undefined,
    async () => jsonResponse(execution),
  );
  const text = await response.text();
  const body = JSON.parse(text) as {
    extractions: Array<{
      status: string;
      candidate?: {
        invocation: { name: string };
        fidelity: string;
        resolved?: { messages: Array<{ content: string }> };
      };
    }>;
  };
  assert.equal(response.status, 200);
  const compound = body.extractions.find(
    (result) =>
      result.candidate?.invocation.name === "Compound prompt cases",
  );
  assert.equal(compound?.status, "candidate");
  assert.equal(compound?.candidate?.fidelity, "execution-reconstructed");
  assert.match(
    compound?.candidate?.resolved?.messages[0]?.content ?? "",
    /IL_P0_TOPIC_ALPHA/,
  );
  assert.doesNotMatch(text, /generations|tokenUsage|Fixture received user=/);
  assert.doesNotMatch(text, new RegExp(apiKey));
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("reports unavailable retained data with current authored workflow fallback and rejects a workflow mismatch", async () => {
  let workflowId = "workflow_1";
  const fetchImplementation: typeof fetch = async (input) => {
    const pathname = new URL(input.toString()).pathname;
    if (pathname.endsWith("/workflows/workflow_1")) {
      return jsonResponse({
        id: "workflow_1",
        name: "Current workflow",
        active: false,
        nodes: [],
        connections: {},
      });
    }
    return jsonResponse({
      id: "execution_1",
      workflowId,
      status: "error",
      data: null,
    });
  };
  const request = () =>
    sameOriginRequest("/api/integrations/n8n/execution-detail", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflowId: "workflow_1",
        executionId: "execution_1",
      }),
    });

  const unavailable = await handleN8nExecutionDetailRequest(
    request(),
    configuredEnvironment,
    undefined,
    fetchImplementation,
  );
  assert.deepEqual(await unavailable.json(), {
    execution: {
      id: "execution_1",
      workflowId: "workflow_1",
      status: "error",
    },
    detailAvailable: false,
    discovery: {
      status: "no-supported-invocations",
      message:
        "This workflow contains no AI invocation supported by this importer.",
    },
    extractions: [],
  });

  workflowId = "workflow_2";
  const mismatch = await handleN8nExecutionDetailRequest(
    request(),
    configuredEnvironment,
    undefined,
    fetchImplementation,
  );
  assert.equal(mismatch.status, 400);
  assert.deepEqual(await mismatch.json(), {
    error: {
      code: "request-invalid",
      message:
        "The selected execution does not belong to the selected workflow.",
      retryable: false,
    },
  });
});

test("rejects path-like IDs and unexpected query parameters before contacting n8n", async () => {
  let calls = 0;
  const fetchImplementation: typeof fetch = async () => {
    calls += 1;
    return jsonResponse({ data: [] });
  };
  const invalidId = await handleN8nExecutionsRequest(
    sameOriginRequest(
      "/api/integrations/n8n/executions?workflowId=..%2Fsecret",
    ),
    configuredEnvironment,
    undefined,
    fetchImplementation,
  );
  assert.equal(invalidId.status, 400);
  assert.match(await invalidId.text(), /Workflow ID/);

  const unexpected = await handleN8nWorkflowsRequest(
    sameOriginRequest(
      "/api/integrations/n8n/workflows?baseUrl=https%3A%2F%2Fattacker.test",
    ),
    configuredEnvironment,
    undefined,
    fetchImplementation,
  );
  assert.equal(unexpected.status, 400);
  assert.match(await unexpected.text(), /Unexpected query parameter/);
  assert.equal(calls, 0);
});

test("refuses redirects and normalizes remote errors without response bodies", async () => {
  const redirectClient = new N8nClient(
    new EnvironmentN8nCredentialSource(configuredEnvironment).resolve(),
    {
      fetchImplementation: async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://attacker.test/stolen" },
        }),
    },
  );
  await assert.rejects(
    redirectClient.listWorkflows(),
    (error: unknown) => {
      assert.ok(error instanceof N8nIntegrationError);
      assert.equal(error.code, "remote-unavailable");
      assert.match(error.message, /redirects are refused/);
      return true;
    },
  );

  const response = await handleN8nWorkflowsRequest(
    sameOriginRequest("/api/integrations/n8n/workflows"),
    configuredEnvironment,
    undefined,
    async () =>
      new Response(`X-N8N-API-KEY=${apiKey} private-host.internal`, {
        status: 401,
      }),
  );
  const text = await response.text();
  assert.equal(response.status, 502);
  assert.deepEqual(JSON.parse(text), {
    error: {
      code: "authentication-failed",
      message: "n8n rejected the configured API key.",
      retryable: false,
    },
  });
  assert.doesNotMatch(text, new RegExp(apiKey));
  assert.doesNotMatch(text, /private-host/);
});

test("bounds responses and rejects incompatible success payloads", async () => {
  const oversizedClient = new N8nClient(
    new EnvironmentN8nCredentialSource(configuredEnvironment).resolve(),
    {
      fetchImplementation: async () =>
        new Response("{}", {
          headers: { "content-length": String(2 * 1024 * 1024) },
        }),
    },
  );
  await assert.rejects(
    oversizedClient.listWorkflows(),
    (error: unknown) => {
      assert.ok(error instanceof N8nIntegrationError);
      assert.equal(error.code, "response-too-large");
      return true;
    },
  );

  const incompatibleClient = new N8nClient(
    new EnvironmentN8nCredentialSource(configuredEnvironment).resolve(),
    {
      fetchImplementation: async () =>
        jsonResponse({ data: [{ id: "workflow_1", nodes: [] }] }),
    },
  );
  await assert.rejects(
    incompatibleClient.listWorkflows(),
    (error: unknown) => {
      assert.ok(error instanceof N8nIntegrationError);
      assert.equal(error.code, "response-incompatible");
      assert.doesNotMatch(error.message, /workflow_1/);
      return true;
    },
  );
});

test("applies one timeout to connection and total response time", async () => {
  const connectionClient = new N8nClient(
    new EnvironmentN8nCredentialSource(configuredEnvironment).resolve(),
    {
      timeoutMs: 5,
      fetchImplementation: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    },
  );
  const bodyClient = new N8nClient(
    new EnvironmentN8nCredentialSource(configuredEnvironment).resolve(),
    {
      timeoutMs: 5,
      fetchImplementation: async (_input, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('{"data":[{"id":"workflow_1"'),
              );
              init?.signal?.addEventListener(
                "abort",
                () =>
                  controller.error(new DOMException("aborted", "AbortError")),
                { once: true },
              );
            },
          }),
        ),
    },
  );
  for (const client of [connectionClient, bodyClient]) {
    await assert.rejects(client.listWorkflows(), (error: unknown) => {
      assert.ok(error instanceof N8nIntegrationError);
      assert.equal(error.code, "request-timeout");
      assert.equal(error.retryable, true);
      assert.doesNotMatch(error.message, /example\.test|n8n-secret/);
      return true;
    });
  }
});

test("same-origin protection applies before the n8n credential is resolved", async () => {
  let calls = 0;
  const response = await handleN8nWorkflowsRequest(
    new Request("http://localhost:3000/api/integrations/n8n/workflows", {
      headers: { origin: "https://attacker.test" },
    }),
    configuredEnvironment,
    undefined,
    async () => {
      calls += 1;
      return jsonResponse({ data: [] });
    },
  );
  assert.equal(response.status, 403);
  assert.equal(calls, 0);
});
