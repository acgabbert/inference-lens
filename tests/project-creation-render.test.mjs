import assert from "node:assert/strict";
import test from "node:test";

import { ssrLoadModule } from "./support/ssr.mjs";

async function renderProjectCreationDialog(mode = "new") {
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
      mode,
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

test("each save mode names what choosing a folder will do", async () => {
  const save = await renderProjectCreationDialog("save");
  assert.match(save, /Save this project/);
  assert.match(save, /Save to folder…/);
  const beforeSwitch = await renderProjectCreationDialog("save-before-switch");
  assert.match(beforeSwitch, /Save the current project/);
  assert.match(beforeSwitch, /switch projects only after the save succeeds/);
  assert.match(beforeSwitch, /Save and switch…/);
});
