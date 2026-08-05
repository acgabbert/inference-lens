import { expect, test } from "@playwright/test";

import { createProjectFile, createPromptTemplate } from "../../packages/core/src/project";
import { importProject, seedProfile, waitForHydration } from "./support";

function pasteProject() {
  let project = createProjectFile({
    name: "n8n paste fixture",
    request: { provider: "openai-compatible", endpoint: "http://127.0.0.1:44014/v1", model: "buffered-test-model", messages: [{ role: "user", content: "Unused" }] },
    idSuffix: "n8n-paste", createdAt: "2026-08-05T12:00:00.000Z",
  });
  project = createPromptTemplate(project, {
    name: "Paste prompt", messages: [{ role: "user", content: "Before: " }], variableDefaults: {},
    idSuffix: "n8n-paste", revisionIdSuffix: "n8n-paste-1", createdAt: "2026-08-05T12:01:00.000Z",
  });
  return project;
}

test("keeps the empty paste state compact and its suggestion toggle aligned", async ({ page }) => {
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, pasteProject(), "n8n paste fixture");
  await page.getByRole("tab", { name: /Prompts 1/ }).click();
  await page.getByRole("button", { name: "Paste from n8n…" }).click();

  const dialog = page.getByRole("dialog", { name: "Paste from n8n" });
  await expect(dialog.getByLabel("Converted text preview")).toBeHidden();
  const preference = dialog.getByText("Suggest this when n8n expressions are pasted");
  const checkbox = dialog.getByRole("checkbox", { name: "Suggest this when n8n expressions are pasted" });
  const preferenceBox = await preference.boundingBox();
  const checkboxBox = await checkbox.boundingBox();
  expect(preferenceBox).not.toBeNull();
  expect(checkboxBox).not.toBeNull();
  expect(checkboxBox!.width).toBeLessThanOrEqual(20);
  expect(checkboxBox!.x).toBeCloseTo(preferenceBox!.x, 0);
  expect(checkboxBox!.y).toBeGreaterThanOrEqual(preferenceBox!.y);
  expect(checkboxBox!.y + checkboxBox!.height).toBeLessThanOrEqual(preferenceBox!.y + preferenceBox!.height);
});

test("converts explicit and ordinary n8n template paste without changing native text", async ({ page }) => {
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, pasteProject(), "n8n paste fixture");
  await page.getByRole("tab", { name: /Prompts 1/ }).click();
  const content = page.getByLabel("Prompt content");

  await content.focus();
  await content.evaluate((element) => {
    const textarea = element as HTMLTextAreaElement;
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  });
  await page.getByRole("button", { name: "Paste from n8n…" }).click();
  const dialog = page.getByRole("dialog", { name: "Paste from n8n" });
  await dialog.getByLabel("Copied n8n content").fill('{{ $json.topic }}');
  await expect(dialog.getByLabel("Converted text preview")).toContainText("{{topic}}");
  await dialog.getByRole("button", { name: "Insert converted text" }).click();
  await expect(content).toHaveValue("Before: {{topic}}");
  await expect(page.locator(".template-variable-rail")).toContainText("{{topic}}");

  await content.evaluate((element) => {
    const textarea = element as HTMLTextAreaElement;
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    const data = new DataTransfer();
    data.setData("text/plain", '{{ $json.title.toUpperCase() }}');
    textarea.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
  });
  const suggestion = page.getByRole("dialog", { name: "Convert pasted n8n expressions?" });
  await expect(suggestion).toContainText("Suggested from the expression's only data reference.");
  await suggestion.getByRole("button", { name: "Convert n8n expressions" }).click();
  await expect(content).toHaveValue("Before: {{topic}}{{title}}");
  await expect(content).not.toHaveValue(/NaN|Infinity|undefined/);
});
