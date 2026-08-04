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
  openInferenceSettings,
  seedProfile,
  waitForHydration,
  openMode,
} from "./support";

const REPETITIONS = 3;
const PROJECT_NAME = "Batch progress fixture";
const PROFILE_INSTANCE_ID = "profile-instance-buffered";

/**
 * Holds every provider call until the test releases it, one at a time.
 *
 * The released request still goes to the buffered fixture — this paces the
 * batch, it does not fabricate a response. That matters: the finished count is
 * derived from terminal run status, so a hand-written body could report a cell
 * finished for reasons the real transport never produces.
 *
 * The controller is sequential, so at most one call is ever parked here. That
 * is what makes each intermediate count a stable assertion rather than a race:
 * between releases the batch is genuinely stopped mid-flight.
 *
 * Gate the app's own inference route, not `**\/v1/chat/completions`: the
 * browser posts to `INFERENCE_API_PATH` and the server talks to the provider,
 * so routing the provider URL intercepts nothing and every release times out.
 */
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

async function startBatch(page: Page) {
  await page.getByLabel("Message 1 content").fill("Repeat this request");
  await page.getByRole("button", { name: "Repeat…" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Run this frozen request repeatedly",
  });
  await dialog.getByLabel("Repetitions").fill(String(REPETITIONS));
  await dialog
    .getByRole("button", { name: `Start ${REPETITIONS} repetitions` })
    .click();
}

test("the repeated-experiment finished count advances mid-batch, not only at the end", async ({
  page,
}) => {
  const releaseOne = await gateProviderCalls(page);
  await seedProfile(page, { favoriteModels: ["buffered-test-model"] });
  await page.goto("/");
  await waitForHydration(page);

  await startBatch(page);

  const workspace = page.getByRole("region", {
    name: "Repeated experiment results",
  });
  // Nothing has been released, so the batch is parked on its first call.
  await expect(workspace).toContainText(`0 of ${REPETITIONS} finished`);

  // The assertion that matters: each count is observed while the batch is still
  // running, with later repetitions provably unstarted. A count that only
  // arrives with the final result cannot satisfy this.
  for (let finished = 1; finished < REPETITIONS; finished += 1) {
    await releaseOne();
    await expect(workspace).toContainText(`${finished} of ${REPETITIONS} finished`);
    await expect(page.getByRole("progressbar", { name: "Experiment progress" }))
      .toHaveAttribute("value", String(finished));
  }

  await releaseOne();
  // The live clock retires on the terminal emission, so the progress bar going
  // away is the completion signal rather than a count.
  await expect(page.getByRole("progressbar", { name: "Experiment progress" }))
    .toHaveCount(0);
  await expect(workspace).toContainText(`${REPETITIONS} requested repetitions`);
  await expect(workspace).toContainText(`${REPETITIONS} completed`);

  const summary = await workspace
    .getByLabel("Repeated experiment summary")
    .innerText();
  expect(summary).not.toMatch(/NaN|Infinity|undefined/);
});

function fixtureProject(): ProjectFile {
  const project = createProjectFile({
    name: PROJECT_NAME,
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Hello" }],
    },
    idSuffix: "batch-progress",
    createdAt: "2026-08-03T12:00:00.000Z",
  });
  return createPromptTemplate(project, {
    name: "Question",
    messages: [{ role: "user", content: "Explain {{topic}}." }],
    idSuffix: "question",
    createdAt: "2026-08-03T12:00:01.000Z",
  });
}

/** Authors the smallest suite that can run: one bound input, one check. */
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

test("the evaluation finished count advances mid-batch, not only at the end", async ({
  page,
}) => {
  const releaseOne = await gateProviderCalls(page);
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

  await authorRunnableSuite(page);
  await (await openInferenceSettings(page, "Evaluation execution settings"))
    .getByLabel("Repetitions")
    .fill(String(REPETITIONS));
  await page
    .locator(".evaluation-editor")
    .getByRole("button", { name: "Start evaluation…" })
    .click();
  await page
    .getByRole("dialog", { name: /Start “Untitled evaluation”/ })
    .getByRole("button", { name: `Start ${REPETITIONS} calls` })
    .click();

  const results = page.locator(".evaluation-results-workspace");
  await expect(results).toContainText(`0 of ${REPETITIONS} finished`);

  for (let finished = 1; finished < REPETITIONS; finished += 1) {
    await releaseOne();
    await expect(results).toContainText(`${finished} of ${REPETITIONS} finished`);
    await expect(page.getByRole("progressbar", { name: "Evaluation progress" }))
      .toHaveAttribute("value", String(finished));
  }

  await releaseOne();
  await expect(page.getByRole("progressbar", { name: "Evaluation progress" }))
    .toHaveCount(0);
  await expect(results).toContainText("1 / 1 passed");
  await expect(results).toContainText(
    `${REPETITIONS} passed · 0 failed · 0 not evaluated`,
  );
  expect(await results.innerText()).not.toMatch(/NaN|Infinity|undefined/);
});
