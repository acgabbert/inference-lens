import { expect, test } from "@playwright/test";

import {
  BUFFERED_FIXTURE_ENDPOINT,
  PROFILE_STORAGE_KEY,
  waitForHydration,
} from "./support";

test("a fresh user can author a session prompt before configuring inference", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/");
  await waitForHydration(page, "OpenAI compatible");
  await expect
    .poll(() =>
      page.evaluate((key) => Boolean(localStorage.getItem(key)), PROFILE_STORAGE_KEY),
    )
    .toBe(true);

  await page.getByRole("tab", { name: /Prompts/ }).click();
  await page.getByRole("button", { name: "New prompt", exact: true }).click();

  await expect(page.getByLabel("Prompt name")).toHaveValue("Untitled prompt");
  await page.getByLabel("Prompt content").fill("Summarize {{topic}} for a new user.");
  await expect(page.getByText("Session draft — not saved after closing.")).toBeVisible();
  expect(pageErrors).toEqual([]);

  await page.getByRole("tab", { name: /Messages/ }).click();
  await page.getByRole("tab", { name: /Prompts/ }).click();
  await expect(page.getByLabel("Prompt content")).toHaveValue(
    "Summarize {{topic}} for a new user.",
  );

  await page.getByRole("button", { name: "Save to project", exact: true }).click();
  const connections = page.getByRole("dialog", { name: "Connections", exact: true });
  await expect(connections).toBeVisible();
  await expect(connections).toContainText(
    "Set a valid endpoint and model to save this prompt to a project.",
  );
  await expect(page.getByLabel("Prompt content")).toHaveValue(
    "Summarize {{topic}} for a new user.",
  );
  expect(pageErrors).toEqual([]);

  await connections.getByLabel("Endpoint", { exact: true }).fill(BUFFERED_FIXTURE_ENDPOINT);
  await connections.getByRole("button", { name: "Close Connections" }).click();
  await page.getByRole("tab", { name: /Messages/ }).click();
  await page.getByRole("button", { name: /Run settings/ }).click();
  await page.getByRole("combobox", { name: "Model" }).fill("buffered-test-model");
  await page.getByRole("combobox", { name: "Model" }).press("Escape");
  await page.getByRole("tab", { name: /Prompts/ }).click();

  await expect(page.getByLabel("Prompt content")).toHaveValue(
    "Summarize {{topic}} for a new user.",
  );
  await page.getByLabel("Prompt content").press("ControlOrMeta+s");
  await expect(page.getByRole("button", { name: "Save to project", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Prompt content")).toHaveValue(
    "Summarize {{topic}} for a new user.",
  );
  await expect(page.locator(".brand")).toContainText("Untitled Inference Lens project");
  expect(pageErrors).toEqual([]);
});
