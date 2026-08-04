import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { createProjectFile } from "../../packages/core/src/project";
import type { ProjectFile } from "../../packages/core/src/project";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  importProject,
  primaryAction,
  seedProfile,
  waitForHydration,
} from "./support";

/**
 * The invariant this PR is most likely to break: **a blocked primary action
 * states its reason in visible text.**
 *
 * The app had already paid for that rule once — the readiness notice existed
 * precisely because a disabled topbar button can carry only a native tooltip,
 * which is invisible on touch and unreachable from the keyboard. Compacting
 * that notice into a chip is exactly the change that could quietly give it up,
 * so this asserts the reason with no hover, no expansion, and no pointer at
 * all, and that the disabled button is programmatically tied to it.
 *
 * An unmapped project is the fixture because it is the first readiness rule and
 * needs nothing but an import to reproduce: a project carries no credential, so
 * it cannot run until it is pointed at one of this device's profiles.
 */

const PROJECT_NAME = "Blocker chip fixture";

function fixtureProject(): ProjectFile {
  return createProjectFile({
    name: PROJECT_NAME,
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Say hello." }],
    },
    idSuffix: "blocker-chip",
    createdAt: "2026-08-04T12:00:00.000Z",
  });
}

/** Imported but never mapped, which is what leaves the run blocked. */
async function openUnmappedProject(page: Page, width = 1440): Promise<void> {
  await seedProfile(page, {
    endpoint: BUFFERED_FIXTURE_ENDPOINT,
    instanceId: "profile-instance-buffered",
  });
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, fixtureProject(), PROJECT_NAME);
}

test("a blocked run states its reason in visible text and the button points at it", async ({
  page,
}) => {
  await openUnmappedProject(page);

  const chip = page.getByLabel("Run readiness");
  const summary = page.locator("#run-readiness-summary");
  const run = primaryAction(page, "compose");

  await expect(run).toBeDisabled();
  // The reason, with nothing hovered, nothing focused, and nothing expanded.
  await expect(summary).toBeVisible();
  await expect(summary).toHaveText("This project is not connected to a local profile yet");
  await expect(chip).toContainText("1 blocker");
  // And the fix, as the inline action's own label rather than as prose.
  await expect(chip.getByRole("button", { name: /^Map / })).toBeVisible();
  // Tied to the control it explains, so assistive technology reads the two
  // together rather than announcing a dead button with no cause.
  await expect(run).toHaveAttribute("aria-describedby", "run-readiness-summary");

  // The reason is text in the document, not a `title` the keyboard cannot reach.
  await expect(run).not.toHaveAttribute("title", /./);
  const chipText = await chip.innerText();
  expect(chipText).not.toMatch(/NaN|Infinity|undefined/);
});

test("the chip is one line until asked, and holds the rest behind Details", async ({
  page,
}) => {
  await openUnmappedProject(page);

  const chip = page.getByLabel("Run readiness");
  const details = chip.getByRole("button", { name: "Details" });

  // Collapsed, the chip carries the reason and the fix and stops there. The
  // rule behind the block and the endpoints it compares are the standing
  // multi-line banner this replaced, so none of it is on screen yet.
  await expect(details).toHaveAttribute("aria-expanded", "false");
  await expect(chip).not.toContainText("never carries a credential");
  await expect(chip).not.toContainText(BUFFERED_FIXTURE_ENDPOINT);

  await details.click();
  await expect(details).toHaveAttribute("aria-expanded", "true");
  await expect(chip).toContainText("never carries a credential");
  await expect(chip).toContainText(BUFFERED_FIXTURE_ENDPOINT);
  // The secondary action lives with the explanation, not beside the primary.
  await expect(chip.getByRole("button", { name: "Choose another profile" })).toBeVisible();

  await details.click();
  await expect(chip).not.toContainText("never carries a credential");
});

test("the chip's action still routes to and focuses the exact control", async ({
  page,
}) => {
  await openUnmappedProject(page);

  // The readiness-destination routing is the best thing in the app and the
  // regression this PR is most likely to cause: the chip changed how the
  // action is rendered, not where it goes.
  await page.getByLabel("Run readiness").getByRole("button", { name: /^Map / }).click();

  const focused = page.locator("[data-readiness-control]:focus");
  await expect(focused).toHaveAttribute("data-readiness-control", "project-mapping");
});

test("the chip survives the mobile workbench width", async ({ page }) => {
  await openUnmappedProject(page, 390);

  const chip = page.getByLabel("Run readiness");
  await expect(chip).toBeVisible();
  await expect(page.locator("#run-readiness-summary")).toBeVisible();
  // Narrow enough that the chip wraps; it must still not push its own pane
  // sideways, because a reason scrolled off-screen is a reason not stated.
  const overflow = await chip.evaluate((element) => ({
    chip: element.scrollWidth - element.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
  expect(overflow).toEqual({ chip: 0, body: 0 });
});
