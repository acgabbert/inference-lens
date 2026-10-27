import { expect, test } from "@playwright/test";

import { seedProfile, waitForHydration } from "./support";

import { controlledStream } from "./support/controlled-stream";

/** Reads the formatted Elapsed/Duration value back as milliseconds. */
function parseDuration(text: string): number {
  const ms = /^(\d+) ms$/.exec(text);
  if (ms) return Number(ms[1]);
  const seconds = /^(\d+\.\d+) s$/.exec(text);
  if (seconds) return Number(seconds[1]) * 1000;
  throw new Error(`Unrecognized duration: ${text}`);
}

test("the run summary's Elapsed keeps counting while the provider holds back the first byte", async ({ page }) => {
  const provider = await controlledStream();
  try {
    await seedProfile(page, { endpoint: provider.endpoint, model: "controlled-stream", streaming: "stream" });
    await page.goto("/");
    await waitForHydration(page);
    await page.getByRole("button", { name: "Run current conversation ⌘↵" }).click();
    await expect.poll(() => provider.request()).toMatchObject({ stream: true, model: "controlled-stream" });

    const summary = page.getByLabel("Run summary");
    await expect(summary).toContainText("Running");
    const elapsed = summary.locator("div", { has: page.locator("dt", { hasText: /^Elapsed$/ }) }).locator("dd");

    // No event arrives while the provider stalls, so only a live clock can
    // move this past a second.
    await expect
      .poll(async () => parseDuration((await elapsed.textContent()) ?? ""), { timeout: 5_000 })
      .toBeGreaterThan(1_000);

    provider.send("Answer.");
    provider.finish();
    await expect(summary).toContainText("Completed");
    const duration = summary.locator("div", { has: page.locator("dt", { hasText: /^Duration$/ }) }).locator("dd");
    const settled = parseDuration((await duration.textContent()) ?? "");
    expect(settled).toBeGreaterThan(1_000);
    // A finished run shows the recorded duration, not a clock still running.
    await page.waitForTimeout(500);
    expect(parseDuration((await duration.textContent()) ?? "")).toBe(settled);
    await expect(summary).not.toContainText(/NaN|Infinity|undefined/);
  } finally {
    await provider.close();
  }
});
