import { expect, test } from "./support/test";
import type { Locator, Page } from "./support/test";

import {
  BUFFERED_FIXTURE_ENDPOINT,
  primaryAction,
  seedProfile,
  waitForHydration,
} from "./support";

/**
 * Per-message transcript actions (UX discoverability plan, section 9).
 *
 * Each row's disclosure is its own button, the actions sit beside it as text
 * buttons rather than inside it, and a collapsed row still exposes them in tab
 * order. `pending-branch.spec.ts` and `response-copy.spec.ts` cover what the
 * actions do; this spec covers where they live and what they cost the row.
 */

const ANSWER = "Buffered fixture response: 2 + 2 = 4.";

async function finishedRun(page: Page): Promise<Locator> {
  await seedProfile(page, { endpoint: BUFFERED_FIXTURE_ENDPOINT });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Message 1 content").fill("What is 2 + 2?");
  await page.getByLabel("Message 2 content").fill("Explain the answer in one line.");
  await primaryAction(page, "compose").click();
  const transcript = page.getByLabel("Run transcript");
  await expect(transcript).toContainText(ANSWER);
  return transcript;
}

test("a message's disclosure is a real button that holds no other control", async ({ page }) => {
  const transcript = await finishedRun(page);

  // The row used to be a role="button" div wrapping the action buttons.
  await expect(transcript.locator('[role="button"]')).toHaveCount(0);
  const disclosures = transcript.locator("button[aria-expanded]");
  expect(await disclosures.count()).toBeGreaterThan(0);
  expect(await disclosures.locator("button, [role='button']").count()).toBe(0);
});

test("a collapsed row keeps its actions in tab order and reveals them on focus", async ({ page }) => {
  const transcript = await finishedRun(page);
  const system = transcript.locator("article").filter({ hasText: "system" }).first();
  await expect(system.getByRole("button", { name: /^Expand system message/ })).toBeVisible();

  const edit = system.getByRole("button", { name: "Edit from here" });
  await edit.focus();
  await expect(edit).toBeFocused();
  // Reachable and, once focused, actually on screen rather than clipped away.
  await expect(edit).toBeInViewport({ ratio: 1 });
  expect(await edit.evaluate((node) => Number(getComputedStyle(node).opacity))).toBe(1);

  // Tab order runs disclosure, then actions, with nothing nested in between.
  await system.getByRole("button", { name: /^Expand system message/ }).focus();
  await page.keyboard.press("Tab");
  await expect(edit).toBeFocused();
});

test("an expanded message shows its actions without hover or focus", async ({ page }) => {
  const transcript = await finishedRun(page);
  const assistant = transcript.locator("article").filter({ hasText: "assistant" });
  await expect(assistant.getByRole("button", { name: /^Collapse assistant message/ })).toBeVisible();
  await page.mouse.move(0, 0);
  for (const name of ["Edit from here", "Copy Markdown"]) {
    const action = assistant.getByRole("button", { name });
    await expect(action).toBeVisible();
    expect(await action.evaluate((node) => Number(getComputedStyle(node).opacity))).toBe(1);
  }
});

test("at 880px an action label stays on one line and the preview keeps its width", async ({ page }) => {
  await page.setViewportSize({ width: 880, height: 720 });
  const transcript = await finishedRun(page);
  const system = transcript.locator("article").filter({ hasText: "system" }).first();
  const row = system.getByRole("button", { name: /^Expand system message/ });
  await row.hover();

  const edit = system.getByRole("button", { name: "Edit from here" });
  // Count rendered line boxes of the label itself; box height includes padding.
  const lines = await edit.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
  });
  expect(lines).toBe(1);

  const preview = system.locator(".transcript-preview");
  const previewBox = await preview.boundingBox();
  const rowBox = await system.boundingBox();
  expect(previewBox!.width).toBeGreaterThan(rowBox!.width * 0.4);
});
