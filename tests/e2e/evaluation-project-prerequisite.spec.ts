import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

import { INFERENCE_API_PATH } from "../../packages/contracts/src/inference";
import { parseProjectJson, projectDraft } from "../../packages/core/src/project";
import { openMode, seedProfile, stubProjectDirectory, waitForHydration } from "./support";
import { expectDocumentFitsViewport } from "./support/layout";

const draft = "Keep this exact draft when starting evaluation setup.";
const userMessage = "Evaluate this user message later.";
const folderAction = "Save project to folder…";
const jsonAction = "Download project JSON…";

async function openEmptyEvaluations(page: Page) {
  const inferenceRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === INFERENCE_API_PATH) {
      inferenceRequests.push(request.url());
    }
  });
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Message 1 content").fill(draft);
  await page.getByLabel("Message 2 content").fill(userMessage);
  await openMode(page, "Evaluations");
  const empty = page.locator(".pane-empty-state").filter({
    has: page.getByRole("heading", { name: "Open or save a project first" }),
  });
  await expect(empty).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Evaluation suites" })).toHaveCount(0);
  expect(inferenceRequests).toEqual([]);
  return { empty, inferenceRequests };
}

async function expectEvaluationsReady(page: Page) {
  await expect(page.getByRole("navigation", { name: "Application mode" })
    .getByRole("button", { name: "Evaluations", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("navigation", { name: "Evaluation suites" })).toContainText("No suites yet.");
}

async function expectDraftPreserved(page: Page) {
  await openMode(page, "Compose");
  await expect(page.getByLabel("Message 1 content")).toHaveValue(draft);
  await expect(page.getByLabel("Message 2 content")).toHaveValue(userMessage);
}

test("Evaluations saves the current draft to a folder and stays in evaluation setup", async ({ page }) => {
  await stubProjectDirectory(page, { name: "Projects", files: {} });
  const { empty, inferenceRequests } = await openEmptyEvaluations(page);
  // Assert the actual available actions, so the red run reports the empty list.
  await expect(empty.getByRole("button")).toHaveText([folderAction]);
  await empty.getByRole("button", { name: folderAction }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Save this project" });
  await dialog.getByLabel("Project name").fill("Evaluation setup project");
  await dialog.getByRole("button", { name: "Save to folder…", exact: true }).click();
  await expect(page.locator(".brand")).toContainText("Saved to Evaluation setup project.inference-lens");
  await expectEvaluationsReady(page);
  await expectDraftPreserved(page);
  expect(inferenceRequests).toEqual([]);
});

for (const outcome of ["dialog cancel", "picker cancel", "write failure"] as const) {
  test(`Evaluations preserves the draft after ${outcome}`, async ({ page }) => {
    await stubProjectDirectory(page, {
      name: "Projects",
      files: {},
      ...(outcome === "write failure" ? { writeError: "Fixture refused the write." } : {}),
    });
    if (outcome === "picker cancel") {
      await page.addInitScript(() => Object.defineProperty(window, "showDirectoryPicker", {
        configurable: true,
        value: async () => { throw new DOMException("Cancelled", "AbortError"); },
      }));
    }
    const { empty, inferenceRequests } = await openEmptyEvaluations(page);
    await expect(empty.getByRole("button")).toHaveText([folderAction]);
    await empty.getByRole("button", { name: folderAction }).click();
    const dialog = page.getByRole("dialog", { name: "Save this project" });
    await dialog.getByRole("button", {
      name: outcome === "dialog cancel" ? "Cancel" : "Save to folder…", exact: true,
    }).click();
    await expect(dialog).toHaveCount(0);
    if (outcome === "write failure") {
      await expect(page.locator('[data-app-banner="project-error"]')).toContainText("Fixture refused the write.");
    }
    await expect(empty).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Evaluation suites" })).toHaveCount(0);
    await expectDraftPreserved(page);
    expect(inferenceRequests).toEqual([]);
  });
}

test("Evaluations offers the JSON save path when folder access is unavailable", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "showDirectoryPicker", {
    configurable: true, value: undefined,
  }));
  const { empty, inferenceRequests } = await openEmptyEvaluations(page);
  await expect(empty.getByRole("button")).toHaveText([jsonAction]);
  const downloading = page.waitForEvent("download");
  await empty.getByRole("button", { name: jsonAction }).click();
  const download = await downloading;
  const saved = parseProjectJson(await readFile((await download.path())!, "utf8"));
  expect(projectDraft(saved).messages.map(({ role, content }) => ({ role, content }))).toEqual([
    { role: "system", content: [{ type: "text", text: draft }] },
    { role: "user", content: [{ type: "text", text: userMessage }] },
  ]);
  expect(saved.evaluationSuites).toEqual([]);
  await expectEvaluationsReady(page);
  await expectDraftPreserved(page);
  expect(inferenceRequests).toEqual([]);
});

test("the prerequisite action fits short desktop windows in both themes", async ({ page }, testInfo) => {
  await stubProjectDirectory(page, { name: "Projects", files: {} });
  const { empty, inferenceRequests } = await openEmptyEvaluations(page);
  await expect(empty.getByRole("button")).toHaveText([folderAction]);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const width of [880, 1280, 1440]) {
      await page.setViewportSize({ width, height: 720 });
      await expect(empty.getByRole("button")).toBeInViewport();
      await expectDocumentFitsViewport(page);
    }
    await page.screenshot({ path: testInfo.outputPath(`evaluations-empty-${colorScheme}.png`) });
  }
  expect(inferenceRequests).toEqual([]);
});
