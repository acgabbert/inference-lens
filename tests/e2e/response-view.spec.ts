import { expect, test, type Page } from "@playwright/test";

import { seedProfile, waitForHydration } from "./support";

import { controlledStream } from "./support/controlled-stream";

const MARKDOWN_PREVIEW_STORAGE_KEY = "inference-lens:markdown-preview:v1";

/**
 * The math fixture's multi-line answer overflows the output pane at this
 * height, so following, scrolling away, and jumping back are observable as
 * scroll positions rather than assumed.
 */
async function runMathAnswer(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 520 });
  await seedProfile(page, {
    model: "math-output-model",
    favoriteModels: ["math-output-model"],
  });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Message 1 content").fill("Show me the identity");
  await page.getByRole("button", { name: "Run current conversation ⌘↵" }).click();
  await expect(page.locator(".markdown-body").first()).toBeVisible();
}

function distanceFromBottom(page: Page): Promise<number> {
  return page.locator(".output-scroll").evaluate(
    (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
  );
}

async function scrollOutputToTop(page: Page): Promise<void> {
  await page.locator(".output-scroll").evaluate((element) => {
    element.scrollTop = 0;
  });
}

test("the response follows new output until the reader scrolls away, and a new run resumes it", async ({
  page,
}) => {
  await runMathAnswer(page);
  const jump = page.getByRole("button", { name: "Jump to latest ↓" });

  const overflow = await page.locator(".output-scroll").evaluate(
    (element) => element.scrollHeight - element.clientHeight,
  );
  expect(overflow).toBeGreaterThan(56);
  await expect.poll(() => distanceFromBottom(page)).toBeLessThan(1);
  await expect(jump).toHaveCount(0);

  await scrollOutputToTop(page);
  await expect(jump).toBeVisible();

  await jump.click();
  await expect(jump).toHaveCount(0);
  await expect.poll(() => distanceFromBottom(page)).toBeLessThan(1);

  await scrollOutputToTop(page);
  await expect(jump).toBeVisible();
  await page.getByRole("button", { name: "Run current conversation ⌘↵" }).click();
  await expect(jump).toHaveCount(0);
  await expect.poll(() => distanceFromBottom(page)).toBeLessThan(1);
});

test("the Markdown or Raw choice is stored and restored on reload", async ({ page }) => {
  await runMathAnswer(page);
  const rendering = page.getByRole("tablist", { name: "Output rendering" });

  await expect(rendering.getByRole("tab", { name: "Markdown" })).toHaveAttribute("aria-selected", "true");
  await rendering.getByRole("tab", { name: "Raw" }).click();
  await expect(page.locator(".markdown-body")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), MARKDOWN_PREVIEW_STORAGE_KEY))
    .toBe("raw");

  await page.reload();
  await waitForHydration(page);
  await expect(rendering.getByRole("tab", { name: "Raw" })).toHaveAttribute("aria-selected", "true");
  // Loading the preference must not write the default over it.
  expect(
    await page.evaluate((key) => localStorage.getItem(key), MARKDOWN_PREVIEW_STORAGE_KEY),
  ).toBe("raw");

  await page.getByLabel("Message 1 content").fill("Show me the identity");
  await page.getByRole("button", { name: "Run current conversation ⌘↵" }).click();
  await expect(page.locator(".output-scroll")).toContainText(String.raw`\( x_1 + y_2 \)`);
  await expect(page.locator(".markdown-body")).toHaveCount(0);

  await rendering.getByRole("tab", { name: "Markdown" }).click();
  await expect(page.locator(".markdown-body").first()).toBeVisible();
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), MARKDOWN_PREVIEW_STORAGE_KEY))
    .toBe("markdown");
});

test("following responds to successive streamed deltas and respects scrolling away", async ({ page }) => {
  const provider = await controlledStream();
  try {
    await page.setViewportSize({ width: 1280, height: 520 });
    await seedProfile(page, { endpoint: provider.endpoint, model: "controlled-stream", streaming: "stream" });
    await page.goto("/");
    await waitForHydration(page);
    await page.getByRole("button", { name: "Run current conversation ⌘↵" }).click();
    await expect.poll(() => provider.request()).toMatchObject({ stream: true, model: "controlled-stream" });
    const output = page.locator(".output-scroll");
    const jump = page.getByRole("button", { name: "Jump to latest ↓" });
    const block = (label: string) => Array.from({ length: 30 }, (_, i) => `${label} line ${i + 1}.`).join("\n\n") + "\n\n";

    provider.send(block("First"));
    await expect(output).toContainText("First line 30.");
    expect(await output.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(56);
    await expect.poll(() => distanceFromBottom(page)).toBeLessThan(1);
    provider.send(block("Second"));
    await expect(output).toContainText("Second line 30.");
    await expect.poll(() => distanceFromBottom(page)).toBeLessThan(1);

    await scrollOutputToTop(page);
    await expect(jump).toBeVisible();
    provider.send(block("Third"));
    await expect(output).toContainText("Third line 30.");
    await expect.poll(() => output.evaluate((element) => element.scrollTop)).toBe(0);
    await expect(jump).toBeVisible();
    await jump.click();
    await expect.poll(() => distanceFromBottom(page)).toBeLessThan(1);
    provider.send(block("Fourth"));
    await expect(output).toContainText("Fourth line 30.");
    await expect.poll(() => distanceFromBottom(page)).toBeLessThan(1);
    await expect(jump).toHaveCount(0);
    // All assertions above happen while the provider still holds the stream open.
    provider.finish();
    await expect(page.getByLabel("Run summary")).toContainText("Completed");
    await expect(output).not.toContainText(/NaN|Infinity|undefined/);
  } finally {
    await provider.close();
  }
});
