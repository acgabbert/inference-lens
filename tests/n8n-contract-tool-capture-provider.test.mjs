import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const SCRIPT = "scripts/n8n-tool-capture-provider.mjs";

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitForStatus(baseUrl, child, stderr) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `capture provider exited before listening (${child.exitCode})\n${stderr()}`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/status`);
      if (response.ok) return response.json();
    } catch {
      // Binding and listening are asynchronous; retry until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("capture provider did not listen within 10 seconds");
}

async function startProvider(t) {
  const port = await unusedPort();
  const outputDirectory = await mkdtemp(
    path.join(os.tmpdir(), "inference-lens-n8n-tool-capture-"),
  );
  const child = spawn(process.execPath, [SCRIPT], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      INFERENCE_LENS_N8N_TOOL_CAPTURE_HOST: "127.0.0.1",
      INFERENCE_LENS_N8N_TOOL_CAPTURE_PORT: String(port),
      INFERENCE_LENS_N8N_TOOL_CAPTURE_SCENARIO: "string-input",
      INFERENCE_LENS_N8N_TOOL_CAPTURE_OUTPUT: outputDirectory,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGTERM");
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForStatus(baseUrl, child, () => stderr);
  return { baseUrl, child, outputDirectory, stderr: () => stderr };
}

function initialRequest({ stream = false, sentinel = "IL_N0_STRING_INPUT" } = {}) {
  return {
    model: "template-echo-model",
    stream,
    messages: [{ role: "user", content: `Run ${sentinel}` }],
    tools: [
      {
        type: "function",
        function: {
          name: "il_echo_string",
          description: "Echo one string through a sub-workflow.",
          parameters: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
      },
    ],
  };
}

function continuationRequest({ stream = false } = {}) {
  return {
    ...initialRequest({ stream }),
    messages: [
      { role: "user", content: "Run IL_N0_STRING_INPUT" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_inference_lens_n8n_001",
            type: "function",
            function: {
              name: "il_echo_string",
              arguments: '{"text":"IL_N0_STRING_VALUE"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_inference_lens_n8n_001",
        content:
          '[{"fixture":"IL_N0_STRING_INPUT","echoed":"IL_N0_STRING_VALUE","receivedType":"string"}]',
      },
    ],
  };
}

async function postCompletion(baseUrl, body) {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readJson(directory, filename) {
  return JSON.parse(await readFile(path.join(directory, filename), "utf8"));
}

test("captures a complete buffered two-turn n8n tool exchange", async (t) => {
  const provider = await startProvider(t);
  const initialBody = initialRequest();

  const models = await fetch(`${provider.baseUrl}/v1/models`);
  assert.equal(models.status, 200);
  assert.deepEqual(await models.json(), {
    object: "list",
    data: [{ id: "template-echo-model", object: "model", created: 0 }],
  });

  const initial = await postCompletion(provider.baseUrl, initialBody);
  assert.equal(initial.status, 200, provider.stderr());
  const toolCall = await initial.json();
  assert.equal(toolCall.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(toolCall.choices[0].message.tool_calls, [
    {
      id: "call_inference_lens_n8n_001",
      type: "function",
      function: {
        name: "il_echo_string",
        arguments: '{"text":"IL_N0_STRING_VALUE"}',
      },
    },
  ]);

  const continuation = await postCompletion(
    provider.baseUrl,
    continuationRequest(),
  );
  assert.equal(continuation.status, 200, provider.stderr());
  const final = await continuation.json();
  assert.equal(final.choices[0].finish_reason, "stop");
  assert.equal(final.choices[0].message.content, "IL_N0_CAPTURE_COMPLETE");

  const statusResponse = await fetch(`${provider.baseUrl}/status`);
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.deepEqual(status, {
    scenario: "string-input",
    phase: "complete",
    requestCount: 2,
    complete: true,
    problem: null,
    files: [
      "provider-request-initial.json",
      "provider-response-tool-call.json",
      "provider-request-continuation.json",
      "provider-response-final.json",
    ],
  });

  assert.deepEqual(
    await readJson(provider.outputDirectory, "provider-request-initial.json"),
    initialBody,
  );
  assert.equal(
    await readFile(
      path.join(provider.outputDirectory, "provider-request-initial.json"),
      "utf8",
    ),
    JSON.stringify(initialBody),
  );
  assert.deepEqual(
    await readJson(
      provider.outputDirectory,
      "provider-request-continuation.json",
    ),
    continuationRequest(),
  );
  assert.deepEqual(
    await readJson(
      provider.outputDirectory,
      "provider-response-tool-call.json",
    ),
    toolCall,
  );
  assert.deepEqual(
    await readJson(provider.outputDirectory, "provider-response-final.json"),
    final,
  );
});

test("streams deterministic tool-call and final-answer chunks", async (t) => {
  const provider = await startProvider(t);

  const initial = await postCompletion(
    provider.baseUrl,
    initialRequest({ stream: true }),
  );
  assert.equal(initial.status, 200, provider.stderr());
  assert.match(initial.headers.get("content-type") ?? "", /^text\/event-stream/);
  const initialWire = await initial.text();
  assert.match(initialWire, /call_inference_lens_n8n_001/);
  assert.match(initialWire, /"finish_reason":"tool_calls"/);
  assert.match(initialWire, /data: \[DONE\]/);

  const continuation = await postCompletion(
    provider.baseUrl,
    continuationRequest({ stream: true }),
  );
  assert.equal(continuation.status, 200, provider.stderr());
  const continuationWire = await continuation.text();
  assert.match(continuationWire, /IL_N0_CAPTURE_COMPLETE/);
  assert.match(continuationWire, /"finish_reason":"stop"/);
  assert.match(continuationWire, /data: \[DONE\]/);

  const status = await fetch(`${provider.baseUrl}/status`).then((response) =>
    response.json(),
  );
  assert.equal(status.complete, true);
});

test("rejects the wrong scenario sentinel without advancing", async (t) => {
  const provider = await startProvider(t);

  const response = await postCompletion(
    provider.baseUrl,
    initialRequest({ sentinel: "WRONG_SENTINEL" }),
  );
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), {
    error: {
      message: "Initial request does not contain scenario sentinel IL_N0_STRING_INPUT.",
      type: "invalid_request_error",
    },
  });

  const status = await fetch(`${provider.baseUrl}/status`).then((result) =>
    result.json(),
  );
  assert.equal(status.phase, "awaiting-initial-request");
  assert.equal(status.requestCount, 0);
  assert.equal(status.complete, false);
  assert.equal(
    status.problem,
    "Initial request does not contain scenario sentinel IL_N0_STRING_INPUT.",
  );
});

test("rejects a continuation whose tool-call linkage is wrong", async (t) => {
  const provider = await startProvider(t);
  const initial = await postCompletion(provider.baseUrl, initialRequest());
  assert.equal(initial.status, 200, provider.stderr());

  const body = continuationRequest();
  body.messages.at(-1).tool_call_id = "call_wrong";
  const continuation = await postCompletion(provider.baseUrl, body);
  assert.equal(continuation.status, 422);
  assert.match(
    (await continuation.json()).error.message,
    /tool result linked to call_inference_lens_n8n_001/,
  );

  const status = await fetch(`${provider.baseUrl}/status`).then((result) =>
    result.json(),
  );
  assert.equal(status.phase, "awaiting-continuation-request");
  assert.equal(status.requestCount, 1);
  assert.equal(status.complete, false);
});

test("preserves a rejected continuation request for diagnosis", async (t) => {
  const provider = await startProvider(t);
  const initial = await postCompletion(provider.baseUrl, initialRequest());
  assert.equal(initial.status, 200, provider.stderr());

  const body = continuationRequest();
  body.messages.splice(1, 1);
  const continuation = await postCompletion(provider.baseUrl, body);
  assert.equal(continuation.status, 422);
  assert.match(
    (await continuation.json()).error.message,
    /does not contain assistant call call_inference_lens_n8n_001/,
  );
  assert.deepEqual(
    await readJson(provider.outputDirectory, "provider-request-rejected.json"),
    body,
  );
});

test("accepts n8n's call ID added to preserved assistant arguments", async (t) => {
  const provider = await startProvider(t);
  const initial = await postCompletion(provider.baseUrl, initialRequest());
  assert.equal(initial.status, 200, provider.stderr());

  const body = continuationRequest();
  body.messages[1].tool_calls[0].function.arguments =
    '{"text":"IL_N0_STRING_VALUE","id":"call_inference_lens_n8n_001"}';
  const continuation = await postCompletion(provider.baseUrl, body);
  assert.equal(continuation.status, 200, await continuation.text());
  assert.deepEqual(
    await readJson(provider.outputDirectory, "provider-request-continuation.json"),
    body,
  );
});

test("rejects a sub-workflow error result instead of reporting capture success", async (t) => {
  const provider = await startProvider(t);
  const initial = await postCompletion(provider.baseUrl, initialRequest());
  assert.equal(initial.status, 200, provider.stderr());

  const body = continuationRequest();
  body.messages.at(-1).content =
    '[{"error":"Workflow is not active and cannot be executed."}]';
  const continuation = await postCompletion(provider.baseUrl, body);
  assert.equal(continuation.status, 422);
  assert.match(
    (await continuation.json()).error.message,
    /does not contain the expected string-input sub-workflow result/,
  );
});
