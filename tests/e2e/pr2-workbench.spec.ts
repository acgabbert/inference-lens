import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const PROFILE_STORAGE_KEY = "inference-lens:inference-profiles:v1";
const STREAMING_STORAGE_KEY = "inference-lens:streaming-preference:v1";

async function seedBufferedProfile(page: Page) {
  await page.addInitScript(({ profileKey, streamingKey }) => {
    localStorage.setItem(profileKey, JSON.stringify({
      profiles: [{
        id: "buffered",
        name: "Buffered fixture",
        provider: "openai-compatible",
        endpoint: "http://127.0.0.1:44014/v1",
        model: "buffered-test-model",
        temperature: 0.7,
      }],
      activeProfileId: "buffered",
    }));
    localStorage.setItem(streamingKey, "buffered");
  }, { profileKey: PROFILE_STORAGE_KEY, streamingKey: STREAMING_STORAGE_KEY });
}

async function waitForHydration(page: Page) {
  await expect(page.getByLabel("Stream response")).not.toBeChecked();
}

test("renders the buffered fixture transcript and exact token totals", async ({ page }) => {
  await seedBufferedProfile(page);
  await page.goto("/");
  await waitForHydration(page);

  await expect(page.getByRole("button", { name: /run request/i })).toBeEnabled();
  await page.getByRole("button", { name: /run request/i }).click();

  const response = page.locator(".response-pane");
  await expect(response).toContainText("Buffered fixture response: 2 + 2 = 4.");
  await expect(response).toContainText("11 tokens");
  await page.getByRole("tab", { name: "Metrics" }).click();
  const metrics = page.locator(".run-metrics");
  await expect(metrics).toContainText("4 in · 7 out");
  await expect(metrics).toContainText("11");
  await expect(response).not.toContainText(/NaN|Infinity|undefined|null/);
});

test("uses peer request and response views on a narrow screen", async ({ page }) => {
  await seedBufferedProfile(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await waitForHydration(page);

  const tabs = page.getByRole("navigation", { name: "Workbench view" });
  await expect(tabs).toBeVisible();
  await expect(page.locator(".request-pane")).toBeVisible();
  await expect(page.locator(".response-pane")).toBeHidden();

  await tabs.getByRole("button", { name: "Response" }).click();
  await expect(page.locator(".response-pane")).toBeVisible();
  await expect(page.locator(".request-pane")).toBeHidden();
});
