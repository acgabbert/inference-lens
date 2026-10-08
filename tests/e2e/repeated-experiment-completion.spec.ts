import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { INFERENCE_API_PATH } from "../../packages/contracts/src/inference";
import { openMode, seedProfile, toast, waitForHydration } from "./support";

/**
 * The repeated-experiment half of the completion signal.
 *
 * `evaluation-completion-toast.spec.ts` and `runs-indicator.spec.ts` cover an
 * evaluation, whose toast and dot both carry a pass rate. A repeated
 * experiment decides nothing, so it has its own toast copy and must leave the
 * dot neutral rather than borrow a verdict. Both come from the same finished
 * queue, which this spec drives from the other session's `onFinished`.
 *
 * Every provider call is parked so the batch finishes exactly when the spec
 * releases it, after it has left Runs.
 */

const REPETITIONS = 2;

async function gateProviderCalls(page: Page) {
  const parked: (() => void)[] = [];
  await page.route(`**${INFERENCE_API_PATH}`, async (route) => {
    await new Promise<void>((resolve) => parked.push(resolve));
    await route.continue();
  });
  return async function releaseOne(): Promise<void> {
    await expect.poll(() => parked.length).toBeGreaterThan(0);
    parked.shift()!();
  };
}

function runsButton(page: Page) {
  return page
    .getByRole("navigation", { name: "Application mode" })
    .getByRole("button", { name: "Runs" });
}

test("a repeated experiment that finishes off-screen announces itself and leaves a neutral dot", async ({
  page,
}) => {
  const releaseOne = await gateProviderCalls(page);
  await seedProfile(page, { favoriteModels: ["buffered-test-model"] });
  await page.goto("/");
  await waitForHydration(page);

  await page.getByLabel("Message 1 content").fill("Repeat this request");
  await page.getByRole("button", { name: "Repeat…" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Run this frozen request repeatedly",
  });
  await dialog.getByLabel("Repetitions").fill(String(REPETITIONS));
  await dialog
    .getByRole("button", { name: `Start ${REPETITIONS} repetitions` })
    .click();

  await openMode(page, "Compose");
  const dot = runsButton(page).locator("[data-mode-indicator]");
  await expect(dot).toHaveAttribute("data-mode-indicator", "running");
  const finished = toast(page, "Repeated experiment finished");
  await expect(finished, "nothing has finished yet").toHaveCount(0);

  for (let released = 0; released < REPETITIONS; released += 1) await releaseOne();

  await expect(finished).toBeVisible();
  await expect(finished).toContainText(`${REPETITIONS} repetitions completed.`);
  expect(await finished.innerText()).not.toMatch(/NaN|Infinity|undefined/);
  await expect(dot).toHaveAttribute("data-mode-indicator", "neutral");
  await expect(runsButton(page)).toContainText("finished, not yet viewed");

  await finished.getByRole("button", { name: "View results" }).click();
  await expect(runsButton(page)).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("region", { name: "Repeated experiment results" }),
  ).toContainText(`${REPETITIONS} completed`);
  await expect(finished).toHaveCount(0);
  await expect(dot).toHaveCount(0);

  // Read stays read once the user leaves Runs again.
  await openMode(page, "Compose");
  await expect(dot).toHaveCount(0);
});
