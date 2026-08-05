import assert from "node:assert/strict";
import test from "node:test";

import { ssrLoadModule } from "./support/ssr.mjs";

async function renderProjectCreationDialog() {
  const [
    { ProjectCreationDialog },
    { renderToStaticMarkup },
    { createElement },
  ] = await Promise.all([
    ssrLoadModule("/app/project-creation-dialog.client.tsx"),
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
}

test("creates visible project bundles with Git protection on by default", async () => {
  const html = await renderProjectCreationDialog();
  assert.match(html, /Prompt Lab\.inference-lens/);
  assert.match(html, /Keep this project out of Git/);
  assert.match(html, /type="checkbox" checked=""/);
  assert.match(html, /Choose location/);
  assert.doesNotMatch(html, /undefined|NaN|Infinity/);
});
