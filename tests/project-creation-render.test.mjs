import assert from "node:assert/strict";
import test from "node:test";

import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import { uniqueViteCacheDir } from "./support/vite-cache-dir.mjs";

async function renderProjectCreationDialog() {
  const server = await createServer({
    configFile: false, cacheDir: uniqueViteCacheDir(),
    root: process.cwd(),
    plugins: [react()],
    server: { middlewareMode: true, hmr: false, ws: false },
    logLevel: "warn",
  });
  try {
    const [
      { ProjectCreationDialog },
      { renderToStaticMarkup },
      { createElement },
    ] = await Promise.all([
      server.ssrLoadModule("/app/project-creation-dialog.client.tsx"),
      import("react-dom/server"),
      import("react"),
    ]);
    return renderToStaticMarkup(
      createElement(ProjectCreationDialog, {
        initialName: "Prompt Lab",
        onClose: () => {},
        onCreate: () => {},
      }),
    );
  } finally {
    await server.close();
  }
}

test("creates visible project bundles with Git protection on by default", async () => {
  const html = await renderProjectCreationDialog();
  assert.match(html, /Prompt Lab\.inference-lens/);
  assert.match(html, /Keep this project out of Git/);
  assert.match(html, /type="checkbox" checked=""/);
  assert.match(html, /Choose location/);
  assert.doesNotMatch(html, /undefined|NaN|Infinity/);
});
