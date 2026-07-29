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

// The committed capture deliberately contains two parent items whose model
// sub-runs cannot be associated safely. Keep that fail-closed evidence intact,
// but serve one deterministic item from the development API fixture so the
// import review UI also has an execution-backed happy path to verify.
const runData = execution?.data?.resultData?.runData;
const compoundRuns = runData?.["Compound prompt cases"];
const modelRuns = runData?.["Fixture OpenAI Chat Model"];
if (
  Array.isArray(compoundRuns) &&
  Array.isArray(compoundRuns[0]?.data?.main?.[0]) &&
  Array.isArray(modelRuns)
) {
  compoundRuns[0].data.main[0] = compoundRuns[0].data.main[0].slice(0, 1);
  runData["Fixture OpenAI Chat Model"] = modelRuns.slice(0, 1);
}

const workflowSummaries = [
  {
    id: workflow.id,
    name: workflow.name,
    active: workflow.active,
  },
  ...Array.from({ length: 36 }, (_, index) => ({
    id: `workflow_fixture_${String(index + 2).padStart(3, "0")}`,
    name: `Long-list fixture workflow ${String(index + 2).padStart(2, "0")}`,
    active: index % 3 === 0,
  })),
];

const executionSummaries = [
  {
    id: execution.id,
    workflowId: execution.workflowId,
    mode: execution.mode,
    status: execution.status,
    finished: execution.finished,
    startedAt: execution.startedAt,
    stoppedAt: execution.stoppedAt,
  },
  ...Array.from({ length: 62 }, (_, index) => ({
    id: `execution_fixture_${String(index + 2).padStart(3, "0")}`,
    workflowId: workflow.id,
    mode: index % 2 === 0 ? "webhook" : "manual",
    status: index % 7 === 0 ? "error" : "success",
    finished: true,
    startedAt: new Date(
      Date.parse(execution.startedAt) - (index + 1) * 60_000,
    ).toISOString(),
    stoppedAt: new Date(
      Date.parse(execution.startedAt) - (index + 1) * 60_000 + 1_000,
    ).toISOString(),
  })),
];

function page(items, url) {
  const requestedLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
    ? requestedLimit
    : 100;
  const cursor = url.searchParams.get("cursor");
  const offset = cursor?.startsWith("offset:")
    ? Number.parseInt(cursor.slice("offset:".length), 10)
    : 0;
  const start = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  const data = items.slice(start, start + limit);
  const nextOffset = start + data.length;
  return {
    data,
    nextCursor: nextOffset < items.length ? `offset:${nextOffset}` : null,
  };
}

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
    if (url.searchParams.get("excludePinnedData") !== "true") {
      sendJson(response, 400, { message: "Pinned data must be excluded." });
      return;
    }
    sendJson(response, 200, page(workflowSummaries, url));
    return;
  }
  if (url.pathname.startsWith("/api/v1/workflows/")) {
    const workflowId = decodeURIComponent(
      url.pathname.slice("/api/v1/workflows/".length),
    );
    const summary = workflowSummaries.find(({ id }) => id === workflowId);
    if (!summary) {
      sendJson(response, 404, { message: "Fixture workflow not found." });
      return;
    }
    sendJson(response, 200, {
      ...workflow,
      id: summary.id,
      name: summary.name,
      active: summary.active,
    });
    return;
  }
  if (url.pathname === "/api/v1/executions") {
    if (
      !workflowSummaries.some(
        ({ id }) => id === url.searchParams.get("workflowId"),
      ) ||
      url.searchParams.get("includeData") !== "false"
    ) {
      sendJson(response, 400, { message: "Unexpected execution filters." });
      return;
    }
    const workflowId = url.searchParams.get("workflowId");
    if (workflowId !== workflow.id) {
      sendJson(response, 200, { data: [], nextCursor: null });
      return;
    }
    sendJson(
      response,
      200,
      page(executionSummaries, url),
    );
    return;
  }
  if (url.pathname.startsWith("/api/v1/executions/")) {
    if (url.searchParams.get("includeData") !== "true") {
      sendJson(response, 400, { message: "Execution detail requires data." });
      return;
    }
    const executionId = decodeURIComponent(
      url.pathname.slice("/api/v1/executions/".length),
    );
    const summary = executionSummaries.find(({ id }) => id === executionId);
    if (!summary) {
      sendJson(response, 404, { message: "Fixture execution not found." });
      return;
    }
    sendJson(response, 200, {
      ...execution,
      ...summary,
    });
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
