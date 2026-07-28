import assert from "node:assert/strict";
import test from "node:test";

import {
  loadN8nExecutionDetail,
  loadN8nImportStatus,
  loadN8nWorkflows,
  N8nImportClientError,
} from "../app/n8n-import.client.ts";

function withFetch(
  implementation: typeof fetch,
  run: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

test("validates configured status and paged workflow summaries", async () => {
  const calls: string[] = [];
  await withFetch(
    async (input) => {
      calls.push(input.toString());
      if (input.toString().endsWith("/status")) {
        return Response.json({ state: "configured" });
      }
      return Response.json({
        workflows: [
          {
            id: "workflow_1",
            name: "Prompt fixture",
            active: true,
          },
        ],
        nextCursor: "next page",
      });
    },
    async () => {
      assert.deepEqual(await loadN8nImportStatus(), { state: "configured" });
      assert.deepEqual(await loadN8nWorkflows("opaque+/="), {
        workflows: [
          {
            id: "workflow_1",
            name: "Prompt fixture",
            active: true,
          },
        ],
        nextCursor: "next page",
      });
    },
  );
  assert.deepEqual(calls, [
    "/api/integrations/n8n/status",
    "/api/integrations/n8n/workflows?cursor=opaque%2B%2F%3D",
  ]);
});

test("requires an explicit execution discovery outcome", async () => {
  await withFetch(
    async () =>
      Response.json({
        execution: {
          id: "execution_1",
          workflowId: "workflow_1",
          status: "success",
        },
        detailAvailable: true,
        extractions: [],
      }),
    async () => {
      await assert.rejects(
        () =>
          loadN8nExecutionDetail("workflow_1", "execution_1"),
        (error: unknown) =>
          error instanceof N8nImportClientError &&
          error.code === "response-incompatible",
      );
    },
  );
});

test("preserves safe retry metadata from integration errors", async () => {
  await withFetch(
    async () =>
      Response.json(
        {
          error: {
            code: "remote-unavailable",
            message: "The n8n instance could not be reached.",
            retryable: true,
          },
        },
        { status: 502 },
      ),
    async () => {
      await assert.rejects(
        () => loadN8nWorkflows(),
        (error: unknown) =>
          error instanceof N8nImportClientError &&
          error.code === "remote-unavailable" &&
          error.retryable &&
          error.status === 502 &&
          !error.message.includes("http"),
      );
    },
  );
});
