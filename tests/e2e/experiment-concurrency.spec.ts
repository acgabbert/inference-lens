import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  addEvaluationCase,
  addEvaluationCheck,
  addEvaluationInput,
  createEvaluationSuite,
  evaluationBindingCandidates,
  updateEvaluationCase,
  updateEvaluationCheck,
} from "../../packages/core/src/evaluation-suite-authoring";
import {
  createProjectFile,
  createPromptTemplate,
  insertPromptTemplateUse,
  serializeProjectFile,
} from "../../packages/core/src/project";
import type { ProjectFile } from "../../packages/core/src/project";
import { INFERENCE_API_PATH } from "../../packages/contracts/src/inference";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  PROJECT_PROFILE_MAP_STORAGE_KEY,
  openMode,
  primaryAction,
  seedProfile,
  stubProjectDirectory,
  waitForHydration,
} from "./support";

/**
 * Cells running at once, as a person watching the batch sees them.
 *
 * Every provider call is parked at the app's own inference route until the
 * spec releases it, so the number parked *is* the number in flight: a spec
 * that let the buffered fixture answer would race the screen, and could pass
 * having never had two cells running at the same moment.
 */

async function gateProviderCalls(page: Page) {
  const parked: (() => void)[] = [];
  await page.route(`**${INFERENCE_API_PATH}`, async (route) => {
    await new Promise<void>((resolve) => parked.push(resolve));
    await route.continue();
  });
  return {
    /** Calls the app has made and the spec has not yet let through. */
    parked: () => parked.length,
    /** Lets through the call at `index` in arrival order; defaults to the latest. */
    release(index = parked.length - 1) {
      const [resolve] = parked.splice(index, 1);
      resolve!();
    },
  };
}

/** Long enough for a fourth call to have arrived if the limit let it through. */
async function noFurtherCalls(page: Page) {
  await page.waitForTimeout(400);
}

test("a repeated experiment runs up to its limit at once and records it beside the latency", async ({ page }) => {
  const gate = await gateProviderCalls(page);
  await seedProfile(page, { favoriteModels: ["buffered-test-model"] });
  await page.goto("/");
  await waitForHydration(page);

  await page.getByLabel("Message 1 content").fill("Repeat this request");
  await page.getByRole("button", { name: "Repeat…" }).click();
  const dialog = page.getByRole("dialog", { name: "Run this frozen request repeatedly" });
  await dialog.getByLabel("Repetitions", { exact: true }).fill("4");
  const atOnce = dialog.getByLabel("Run at once");
  await expect(atOnce, "a start dialog always opens at one").toHaveValue("1");
  await atOnce.fill("3");
  await expect(dialog).toContainText("Up to 3 run at once");
  await dialog.getByRole("button", { name: "Start 4 repetitions" }).click();

  const results = page.getByRole("region", { name: "Repeated experiment results" });
  await expect.poll(gate.parked).toBe(3);
  await noFurtherCalls(page);
  expect(gate.parked(), "the limit holds the fourth repetition back").toBe(3);
  await expect(results).toContainText("0 of 4 finished · Running 3 repetitions");
  await expect(results.locator(".repeated-experiment-row.active")).toHaveCount(3);
  await expect(results.locator(".repeated-experiment-row-pending")).toHaveText([
    "Running…", "Running…", "Running…", "Waiting",
  ]);

  // The last call to arrive finishes first. Its slot goes to the fourth
  // repetition, and the screen counts three running again, not four.
  gate.release();
  await expect(results).toContainText("1 of 4 finished");
  await expect.poll(gate.parked).toBe(3);
  await expect(results).toContainText("Running 3 repetitions");

  while (gate.parked() > 0) gate.release();
  await expect(results).toContainText("4 completed");
  await expect(results.locator(".repeated-experiment-row strong")).toHaveText([
    "Repetition 1", "Repetition 2", "Repetition 3", "Repetition 4",
  ]);
  await expect(results.locator(".repeated-experiment-row.active")).toHaveCount(0);
  await expect(results).toContainText("Measured with up to 3 repetitions at once.");
  expect(await results.innerText()).not.toMatch(/NaN|Infinity|undefined|\[object Object\]/);
});

const PROJECT_NAME = "Concurrency fixture";
const PROFILE_INSTANCE_ID = "profile-instance-buffered";

/** Two cases whose checks pass against the buffered fixture, one repetition each. */
function runnableProject(): ProjectFile {
  let project = createProjectFile({
    name: PROJECT_NAME,
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Hello" }],
    },
    idSuffix: "concurrency",
    createdAt: "2026-10-09T12:00:00.000Z",
  });
  project = createPromptTemplate(project, {
    name: "Question",
    messages: [{ role: "user", content: "Explain {{topic}}." }],
    idSuffix: "question",
    createdAt: "2026-10-09T12:00:01.000Z",
  });
  project = insertPromptTemplateUse(project, {
    conversationRevisionId: project.defaults.conversationRevisionId,
    templateId: "template_question",
    itemIndex: 1,
    idSuffix: "question-use",
  });
  const candidates = evaluationBindingCandidates(project, project.defaults.conversationRevisionId);
  const created = createEvaluationSuite(project, "Topics", () => "topics");
  project = created.project;
  const input = addEvaluationInput(project, created.suiteId, candidates[0]!, () => "topic");
  project = input.project;
  for (const [index, value] of ["migrations", "replication"].entries()) {
    const added = addEvaluationCase(project, created.suiteId, () => `case-${index}`);
    project = updateEvaluationCase(added.project, created.suiteId, added.caseId, {
      name: value,
      values: { [input.inputId]: `database ${value}` },
    });
    project = addEvaluationCheck(project, created.suiteId, added.caseId, { kind: "contains" }, () => `check-${index}`);
    const check = project.evaluationSuites[0]!.cases[index]!.checks[0]!;
    project = updateEvaluationCheck(project, created.suiteId, added.caseId, {
      checkId: check.checkId,
      kind: "contains",
      label: "Answered by the fixture",
      value: "Buffered fixture",
    });
  }
  return project;
}

/** A project folder, so each evaluation's result is written and read back from disk. */
async function openDurableProject(page: Page, project: ProjectFile): Promise<void> {
  await seedProfile(page, { endpoint: BUFFERED_FIXTURE_ENDPOINT, instanceId: PROFILE_INSTANCE_ID });
  await page.addInitScript(
    ({ mapKey, projectId, instanceId }) => {
      localStorage.setItem(mapKey, JSON.stringify({
        [projectId]: { profileId: "buffered", profileInstanceId: instanceId },
      }));
    },
    { mapKey: PROJECT_PROFILE_MAP_STORAGE_KEY, projectId: project.projectId, instanceId: PROFILE_INSTANCE_ID },
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubProjectDirectory(page, {
    name: "concurrency-fixture",
    files: { "project.json": serializeProjectFile(project) },
    directories: ["traces", "experiments"],
  });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project folder…" }).click();
  await expect(page.locator(".brand")).toContainText(PROJECT_NAME);
  await page.locator(".project-menu").evaluate((element) => element.removeAttribute("open"));
  await openMode(page, "Evaluations");
}

async function openStartDialog(page: Page) {
  await expect(page.locator(".evaluation-editor")).toContainText("Ready to run");
  await primaryAction(page, "evaluations").click();
  return page.getByRole("dialog", { name: /Start “Topics”/ });
}

test("an evaluation runs cells at once, and a comparison names the concurrency it changed", async ({ page }) => {
  const gate = await gateProviderCalls(page);
  await openDurableProject(page, runnableProject());

  // The baseline runs at the default: one call at a time.
  let dialog = await openStartDialog(page);
  await expect(dialog.getByLabel("Run at once")).toHaveValue("1");
  await expect(dialog).toContainText("runs sequentially");
  await dialog.getByRole("button", { name: "Start 2 calls" }).click();
  const results = page.locator(".evaluation-results-workspace");
  await expect.poll(gate.parked).toBe(1);
  await noFurtherCalls(page);
  expect(gate.parked(), "the default runs one cell at a time").toBe(1);
  gate.release();
  await expect.poll(gate.parked).toBe(1);
  gate.release();
  await expect(results).toContainText("2 / 2 passed");
  await expect(results).not.toContainText("at once");

  await results.getByRole("button", { name: "Back to editing" }).click();
  await page.locator(".evaluation-suite-history").getByText("Past executions").click();
  const entries = page.locator(".evaluation-suite-history-entry");
  await expect(entries).toHaveCount(1);
  await entries.first().getByRole("button", { name: "Pin as baseline…" }).click();
  await page.getByLabel("Baseline name").fill("One at a time");
  await entries.first().getByRole("button", { name: "Save baseline" }).click();
  await expect(entries.first()).toContainText("Baseline · One at a time");

  // The candidate runs both cells at once.
  dialog = await openStartDialog(page);
  await expect(dialog.getByLabel("Run at once"), "the last choice is not remembered").toHaveValue("1");
  await dialog.getByLabel("Run at once").fill("2");
  await expect(dialog).toContainText("runs up to 2 at once");
  await dialog.getByRole("button", { name: "Start 2 calls" }).click();
  await expect.poll(gate.parked).toBe(2);
  await expect(results).toContainText("0 of 2 finished · 2 running");
  await expect(results.getByText("Running… · Pending while this run is active")).toHaveCount(2);
  gate.release();
  gate.release();
  await expect(results).toContainText("2 / 2 passed");
  await expect(results).toContainText("up to 2 at once");
  expect(await results.innerText()).not.toMatch(/NaN|Infinity|undefined|\[object Object\]/);

  await results.getByRole("button", { name: "Back to editing" }).click();
  await expect(entries).toHaveCount(2);
  const candidate = entries.filter({ hasNotText: "Baseline · One at a time" });
  const baselineOption = candidate.getByLabel("Compare against baseline").locator("option", { hasText: "One at a time" });
  await candidate.getByLabel("Compare against baseline").selectOption({ label: (await baselineOption.innerText()).trim() });
  await candidate.getByRole("button", { name: "Compare" }).click();

  const comparison = page.getByRole("region", { name: "Evaluation comparison" });
  const drift = comparison.getByLabel("Execution differences");
  await expect(drift).toContainText("did not run under the same conditions");
  const row = drift.locator("tr").filter({ hasText: "Concurrency" });
  await expect(row).toContainText("one at a time");
  await expect(row).toContainText("up to 2 at once");
  await expect(comparison).not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);
});
