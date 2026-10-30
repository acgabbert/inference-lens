import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "./support/test";
import { BUFFERED_FIXTURE_ENDPOINT, stubProjectDirectory } from "./support";
import { expectLayoutFits } from "./support/layout";
import { LINKED_PATH, LINKED_ROOT, linkedPromptProject, writeSourceRoot } from "../fixtures/headless/linked-prompt";
import { writeHeadlessProjectFolder } from "../fixtures/headless/project";

/**
 * Artifacts from a real `inference-lens run --prompts-from-files`, the way CI
 * in a workflow repository would make them, opened in the app afterwards. The
 * trace names the pinned revision, so the app has to say the text came from
 * the file instead, or the run reads as a run of the saved revision.
 */
async function ciArtifacts(): Promise<Record<string, string>> {
  const { project } = await linkedPromptProject({ endpoint: BUFFERED_FIXTURE_ENDPOINT });
  const directory = await writeHeadlessProjectFolder(project);
  const root = await writeSourceRoot({ [LINKED_PATH]: "Describe {{ $json.topic }} in detail." });
  const cli = spawnSync(process.execPath, [
    "--experimental-strip-types",
    path.join(process.cwd(), "packages/cli/src/main.ts"),
    "run", directory, "--prompts-from-files", "--source-root", `${LINKED_ROOT}=${root}`, "--json",
  ], { encoding: "utf8", env: { ...process.env, INFERENCE_LENS_CONNECTION_LINKED_DEFAULT_API_KEY: "sk-e2e" } });
  expect(cli.status, cli.stderr).toBe(0);
  expect(JSON.parse(cli.stdout).promptSources).toHaveLength(1);

  const files: Record<string, string> = {
    "project.json": await readFile(path.join(directory, "project.json"), "utf8"),
  };
  for (const folder of ["experiments", "traces"]) {
    for (const name of await readdir(path.join(directory, folder))) {
      files[`${folder}/${name}`] = await readFile(path.join(directory, folder, name), "utf8");
    }
  }
  return files;
}

test("a CI run that read a linked prompt from its file says so in its results and its trace", async ({ page }) => {
  await stubProjectDirectory(page, { name: "ci-prompt-file-run", files: await ciArtifacts() });
  await page.goto("/");
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project folder…" }).click();
  await expect(page.getByText(/Inspect every model run · Linked prompt fixture/)).toBeVisible();

  await page.getByLabel("Run data menu").click();
  await page.getByRole("button", { name: "Run history", exact: true }).click();
  await page.locator(".runs-evidence-item.experiment").filter({ hasText: "Evaluation · Linked" }).click();

  const results = page.getByRole("region", { name: "Evaluation results" });
  await expect(results).toContainText("1 / 1 passed");
  const sources = results.getByRole("region", { name: "Prompts read from files" });
  await expect(sources).toContainText("Prompts read from files for this run; their saved revisions were not sent");
  await expect(sources).toContainText(/agent ← prompts\/flows\/agent\.md · digest [a-f0-9]{12} · in place of template-revision_/);
  await expect(results).not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);
  // The note sits inside the results pane's one scroll area at every size.
  const original = page.viewportSize()!;
  for (const viewport of [{ width: 1280, height: 560 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await expectLayoutFits(page);
  }
  await page.setViewportSize(original);

  // A lone case opens expanded.
  await expect(results.locator(".evaluation-case-result").first()).toHaveAttribute("open", "");
  await results.getByRole("button", { name: "Open Response & Inspect" }).first().click();
  await expect(page.getByLabel("Run transcript")).toContainText("Describe addition in detail.");
  await page.getByRole("button", { name: "Run details", exact: true }).click();
  await page.getByRole("tab", { name: /Templates/ }).click();
  const provenance = page.locator("#run-details-resolution-panel");
  await expect(provenance).toContainText(/From file prompts\/flows\/agent\.md · digest [a-f0-9]{12}/);
  await expect(provenance).toContainText(/Read from prompts\/flows\/agent\.md in place of revision template-revision_\S+, which this run did not send\./);
  // Run details stays shut for the closing layout audit: an open trace panel
  // starves the selected-run pane on a phone whatever the trace holds, a
  // problem that predates this spec and is not its subject.
  await page.getByRole("button", { name: "Run details", exact: true }).click();
});
