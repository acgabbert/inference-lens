import assert from "node:assert/strict";
import test from "node:test";

import react from "@vitejs/plugin-react";
import { createServer } from "vite";

async function renderDiff() {
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    plugins: [react()],
    server: { middlewareMode: true, hmr: false, ws: false },
    logLevel: "warn",
  });
  try {
    const [{ RunDiffView }, { renderToStaticMarkup }, { createElement }] =
      await Promise.all([
        server.ssrLoadModule("/app/run-diff-view.client.tsx"),
        import("react-dom/server"),
        import("react"),
      ]);
    const left = {
      runId: "run_render",
      runLabel: "This run",
      turnId: "turn_render",
      turnIndex: 1,
      attempt: 1,
      exchangeId: "exchange_left",
      status: "failed",
    };
    const right = {
      ...left,
      attempt: 2,
      exchangeId: "exchange_right",
      status: "completed",
    };
    return renderToStaticMarkup(
      createElement(RunDiffView, {
        candidates: [left, right],
        leftKey: "run_render:exchange_left",
        rightKey: "run_render:exchange_right",
        onSelect() {},
        parent: { available: false, status: "idle" },
        onLoadParent() {},
        diff: {
          left,
          right,
          sameRun: true,
          sameTurn: true,
          scalars: [
            {
              id: "status",
              label: "Status",
              left: { kind: "text", text: "failed" },
              right: { kind: "text", text: "completed" },
              changed: true,
            },
          ],
          sections: [
            {
              id: "request",
              label: "Request body",
              status: "changed",
              normalized: true,
              diff: {
                lines: [
                  {
                    kind: "removed",
                    text: '"old": true',
                    leftLine: 1,
                  },
                  {
                    kind: "added",
                    text: '"new": true',
                    rightLine: 1,
                  },
                ],
                addedCount: 1,
                removedCount: 1,
                identical: false,
                truncated: false,
              },
            },
            {
              id: "reasoning",
              label: "Reasoning",
              status: "absent",
              normalized: false,
            },
          ],
        },
      }),
    );
  } finally {
    await server.close();
  }
}

test("renders scalar changes, unified gutters, and evidence status", async () => {
  const html = await renderDiff();
  assert.match(html, /Request body/);
  assert.match(html, /\+1 \/ −1/);
  assert.match(html, /diff-line removed/);
  assert.match(html, /diff-line added/);
  assert.match(html, /normalized JSON/);
  assert.match(html, /Neither attempt captured this evidence/);
  assert.match(html, /data-changed="true"/);
  assert.match(html, /Retries reuse the same immutable turn input/);
  for (const marker of ["undefined", "NaN", "Infinity", "[object Object]"]) {
    assert.doesNotMatch(html, new RegExp(marker.replace(/[[\]]/g, "\\$&")));
  }
});
