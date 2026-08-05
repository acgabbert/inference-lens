import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  createProjectFile,
  createPromptTemplate,
} from "../../packages/core/src/project";
import type { ProjectFile } from "../../packages/core/src/project";
import { INFERENCE_API_PATH } from "../../packages/contracts/src/inference";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  PROJECT_PROFILE_MAP_STORAGE_KEY,
  importProject,
  openMode,
  primaryAction,
  seedProfile,
  toast,
  waitForHydration,
} from "./support";

/**
 * The affordance the Runs mode was made conditional on.
 *
 * Moving results out of the pane the user was looking at bought each pane one
 * fixed meaning, and cost something specific: a batch that finishes while the
 * user is composing no longer appears anywhere they can see. D2 accepted that
 * trade only on the condition that finishing announces itself, which is what
 * this spec exercises — the toast, its action, and the fact that the message
 * survives the toast expiring.
 *
 * Every provider call is parked, so the batch finishes exactly when this spec
 * says it does. Without that, "the toast appeared" and "the spec happened to
 * look while it was still on screen" are the same observation.
 */

const PROJECT_NAME = "Completion toast fixture";
const PROFILE_INSTANCE_ID = "profile-instance-buffered";

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

function fixtureProject(): ProjectFile {
  const project = createProjectFile({
    name: PROJECT_NAME,
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Hello" }],
    },
    idSuffix: "completion-toast",
    createdAt: "2026-08-04T12:00:00.000Z",
  });
  return createPromptTemplate(project, {
    name: "Question",
    messages: [{ role: "user", content: "Explain {{topic}}." }],
    idSuffix: "question",
    createdAt: "2026-08-04T12:00:01.000Z",
  });
}

async function open(page: Page): Promise<void> {
  const project = fixtureProject();
  await seedProfile(page, { instanceId: PROFILE_INSTANCE_ID });
  await page.addInitScript(
    ({ mapKey, projectId, instanceId }) => {
      localStorage.setItem(
        mapKey,
        JSON.stringify({
          [projectId]: { profileId: "buffered", profileInstanceId: instanceId },
        }),
      );
    },
    {
      mapKey: PROJECT_PROFILE_MAP_STORAGE_KEY,
      projectId: project.projectId,
      instanceId: PROFILE_INSTANCE_ID,
    },
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, project, PROJECT_NAME);
  await openMode(page, "Evaluations");
}

/**
 * The smallest suite that can run: one bound input, one case, one check the
 * buffered fixture provably satisfies, so the pass rate in the toast is a
 * number this spec can predict rather than merely read back.
 */
async function authorRunnableSuite(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Create evaluation suite" }).click();
  await page.getByRole("button", { name: "Start from saved prompt…" }).click();
  const prompt = page.getByRole("dialog", { name: "Start from saved prompt" });
  await prompt.getByRole("radio", { name: "Question" }).check();
  await prompt.getByRole("button", { name: "Start from saved prompt" }).click();

  await page
    .getByLabel("Template variable to bind")
    .selectOption({ label: "Question · topic" });
  await page.getByRole("button", { name: "+ Add case input" }).click();
  await page.getByRole("button", { name: "+ Add case", exact: true }).click();
  await page.getByLabel("Untitled case topic").fill("database migrations");
  await page.getByLabel("New check kind").selectOption({ label: "Contains text" });
  await page.getByRole("button", { name: "+ Add check" }).click();
  const expected = page.locator(".evaluation-editor").getByLabel("Expected text");
  await expected.fill("Buffered fixture");
  await expected.blur();
}

async function startEvaluation(page: Page): Promise<void> {
  await primaryAction(page, "evaluations").click();
  await page
    .getByRole("dialog", { name: /Start “Untitled evaluation”/ })
    .getByRole("button", { name: "Start 1 calls" })
    .click();
}

test("a batch that finishes off-screen announces itself and its action lands on the results", async ({
  page,
}) => {
  const releaseOne = await gateProviderCalls(page);
  await open(page);
  await authorRunnableSuite(page);
  await startEvaluation(page);

  // Starting a batch opens Runs to watch it. Walking away from that is the
  // situation the toast exists for, so the spec walks away.
  await openMode(page, "Compose");
  const finished = toast(page, "Evaluation finished");
  await expect(finished, "nothing has finished yet").toHaveCount(0);

  await releaseOne();

  // The pass rate is asserted, not just the headline: the toast reports the
  // outcome of a one-case suite whose single check the fixture satisfies, so
  // "1/1 case passed" is derivable from the fixture rather than read back from
  // whatever the app happened to render.
  await expect(finished).toBeVisible();
  await expect(finished).toContainText("1/1 case passed");
  expect(await finished.innerText()).not.toMatch(/NaN|Infinity|undefined/);

  // The rule that lets this tier expire at all: the message is also somewhere
  // non-transient. The Runs dot carries the same outcome and does not time out.
  const runs = page
    .getByRole("navigation", { name: "Application mode" })
    .getByRole("button", { name: "Runs" });
  await expect(runs).toContainText("finished, 1/1 case passed, not yet viewed");

  await finished.getByRole("button", { name: "View results" }).click();
  await expect(runs).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".evaluation-results-workspace")).toContainText(
    "1 / 1 passed",
  );
  // Acting on a toast consumes it. Leaving it behind would invite a second
  // click that navigates somewhere the user is already standing.
  await expect(finished).toHaveCount(0);
});

/**
 * Suppressed where it would be noise. The results are on screen and updating
 * live; a toast whose only action navigates to the mode already showing is a
 * message about nothing, and it would cover the very results it announced.
 */
test("no completion toast arrives while the results are already being watched", async ({
  page,
}) => {
  const releaseOne = await gateProviderCalls(page);
  await open(page);
  await authorRunnableSuite(page);
  await startEvaluation(page);

  await releaseOne();
  const results = page.locator(".evaluation-results-workspace");
  await expect(results).toContainText("1 / 1 passed");
  await expect(toast(page, "Evaluation finished")).toHaveCount(0);
});

/** Authors just enough to publish one plain, action-less confirmation. */
async function publishPlainToast(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Create evaluation suite" }).click();
  await page.getByRole("button", { name: "Start from saved prompt…" }).click();
  const prompt = page.getByRole("dialog", { name: "Start from saved prompt" });
  await prompt.getByRole("radio", { name: "Question" }).check();
  await prompt.getByRole("button", { name: "Start from saved prompt" }).click();
}

/**
 * The old bottom-right notice stack went `position: static` on phones, because
 * a standing floating notice covered most of the viewport and swallowed clicks
 * meant for the app underneath. Toasts stay floating — they have to be readable
 * without scrolling — so the same hazard is answered by the region being inert
 * everywhere except on a toast itself. That is what this checks: the mode strip
 * is still operable with a toast on screen at phone width.
 */
test("a toast on a phone covers nothing it does not occupy", async ({ page }) => {
  await open(page);
  await page.setViewportSize({ width: 390, height: 780 });
  await publishPlainToast(page);

  const confirmation = toast(page, "Evaluation input now uses “Question”");
  await expect(confirmation).toBeVisible();

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    overflow.scrollWidth,
    "the toast must not push the page into sideways scrolling",
  ).toBeLessThanOrEqual(overflow.clientWidth);

  // Navigation still works with the toast on screen. A region that took pointer
  // events across its whole box would fail here rather than merely look wrong.
  await openMode(page, "Compose");
});

/**
 * The acceptance criterion that a toast cannot expire underneath someone
 * reading it. Six seconds is generous for a glance and short for a decision,
 * which is exactly why the pause has to work rather than the duration being
 * raised until the problem is rare.
 */
test("hovering a toast stops its clock, and leaving restarts it", async ({ page }) => {
  test.slow();
  await open(page);

  // A plain confirmation carries no action, so it takes the six-second
  // lifetime rather than the twelve-second one.
  await publishPlainToast(page);

  const confirmation = toast(page, "Evaluation input now uses “Question”");
  await expect(confirmation).toBeVisible();
  await confirmation.hover();

  // Comfortably past the lifetime. An unpaused toast would have retired twice
  // over by now, so this failing means the clock never stopped.
  await page.waitForTimeout(9_000);
  await expect(confirmation).toBeVisible();

  // Leaving resumes from what was left, so it retires shortly after rather than
  // starting a fresh six seconds.
  await page.mouse.move(0, 0);
  await expect(confirmation).toHaveCount(0, { timeout: 15_000 });
});
