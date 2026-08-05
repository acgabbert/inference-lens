/**
 * Driven by `tests/ssr-support.test.mjs` under a child `node --test`, which is
 * the only way to observe what the shared SSR helper does *after* its test file
 * has finished — its server close and its cache-directory removal both happen
 * at teardown, so a test running in the same process could never see them.
 *
 * Deliberately not named `*.test.mjs`: the file it exercises must be chosen by
 * the regression test, never swept up by a glob in `package.json`.
 */
import test, { after } from "node:test";

import { claimedCacheDirs, renderToHtml } from "../support/ssr.mjs";

// Reported so the parent asserts on these exact directories rather than
// guessing from a glob that a concurrent run might also match. Registered
// after the helper's own hooks, and read at that point rather than at import,
// so the server's directory is included.
after(() => {
  for (const directory of claimedCacheDirs()) {
    console.log(`cache-dir:${directory}`);
  }
});

test("renders through the shared server", async () => {
  await renderToHtml("/app/run-history-drawer.client.tsx", "RunHistoryDrawer", {
    open: false,
    projectName: "probe",
    onClose() {},
    async onSelect() {},
    async onSelectExperiment() {},
    history: {
      status: "loaded",
      entries: [],
      items: [],
      experiments: [],
      failures: [],
      artifactCount: 0,
      largeHistory: false,
      async refresh() {},
      async readTrace() {
        throw new Error("not used");
      },
    },
  });
});
