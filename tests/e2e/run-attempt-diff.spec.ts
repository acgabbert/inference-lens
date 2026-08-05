import { expect, test } from "@playwright/test";

import { seedProfile, waitForHydration } from "./support";

test("a retry defaults to distinct attempts and explains identical request evidence", async ({ page }) => {
  await seedProfile(page, {
    endpoint: "http://127.0.0.1:44015/v1",
    model: "flaky-test-model",
    name: "Flaky fixture",
    streaming: "stream",
  });
  await page.goto("/");
  await waitForHydration(page, "Flaky fixture");

  await page.getByRole("button", { name: /run request/i }).click();
  await expect(page.getByRole("button", { name: /^Retry attempt/ })).toBeVisible();
  await page.getByRole("button", { name: /^Retry attempt/ }).click();
  await expect(page.locator(".response-pane")).toContainText("Recovered on retry.");

  await page.getByRole("button", { name: "Run details" }).click();
  await page.getByRole("tab", { name: "Attempt diff" }).click();
  const panel = page.locator("#run-details-compare-panel");
  await expect(panel).toContainText("Compare provider attempts from this run");
  await expect(panel).toContainText("The request is identical because a retry reuses the same turn input");
  await expect(panel).toContainText("Intentional first-attempt failure.");
  await expect(panel.locator("select").nth(0)).not.toHaveValue("");
  await expect(panel.locator("select").nth(1)).not.toHaveValue("");
  const leftKey = await panel.locator("select").nth(0).inputValue();
  await expect(panel.locator("select").nth(1).locator(`option[value="${leftKey}"]`)).toHaveAttribute("disabled", "");
  await expect(panel).not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);
});
