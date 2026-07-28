import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

const host = "127.0.0.1";
const port = Number.parseInt(
  process.env.INFERENCE_LENS_N8N_FIXTURE_PORT ?? "5680",
  10,
);
const apiKey =
  process.env.INFERENCE_LENS_N8N_FIXTURE_API_KEY ?? "fixture-api-key";
const fixtureDirectory = path.resolve(
  import.meta.dirname,
  "../tests/fixtures/n8n/captures/2.32.5/basic-llm-chain-success",
);
const [workflow, execution] = await Promise.all(
  ["workflow.json", "execution-success.json"].map(async (filename) =>
    JSON.parse(await readFile(path.join(fixtureDirectory, filename), "utf8")),
  ),
);

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  if (request.method !== "GET") {
    sendJson(response, 405, { message: "Only GET is supported." });
    return;
  }
  if (request.headers["x-n8n-api-key"] !== apiKey) {
    sendJson(response, 401, { message: "Invalid fixture API key." });
    return;
  }

  if (url.pathname === "/api/v1/workflows") {
    sendJson(response, 200, {
      data: [
        {
          id: workflow.id,
          name: workflow.name,
          active: workflow.active,
        },
      ],
      nextCursor: null,
    });
    return;
  }
  if (url.pathname === `/api/v1/workflows/${workflow.id}`) {
    sendJson(response, 200, workflow);
    return;
  }
  if (url.pathname === "/api/v1/executions") {
    if (
      url.searchParams.get("workflowId") !== workflow.id ||
      url.searchParams.get("includeData") !== "false"
    ) {
      sendJson(response, 400, { message: "Unexpected execution filters." });
      return;
    }
    sendJson(response, 200, {
      data: [
        {
          id: execution.id,
          workflowId: execution.workflowId,
          mode: execution.mode,
          status: execution.status,
          finished: execution.finished,
          startedAt: execution.startedAt,
          stoppedAt: execution.stoppedAt,
        },
      ],
      nextCursor: null,
    });
    return;
  }
  if (url.pathname === `/api/v1/executions/${execution.id}`) {
    if (url.searchParams.get("includeData") !== "true") {
      sendJson(response, 400, { message: "Execution detail requires data." });
      return;
    }
    sendJson(response, 200, execution);
    return;
  }

  sendJson(response, 404, { message: "Fixture resource not found." });
});

server.listen(port, host, () => {
  console.log(`n8n public API fixture listening at http://${host}:${port}`);
});

function stop() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
