import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import {
  addEvaluationCheck,
  addEvaluationCase,
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
} from "../../packages/core/src/project";
import type { ProjectFile } from "../../packages/core/src/project";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  importProject,
  openMode,
  seedProfile,
  waitForHydration,
} from "./support";

const PROJECT_NAME = "Full width evaluations";

/**
 * Two suites and enough cases that the list is longer than a few rows: the
 * failure this spec exists for is a case list that scrolls away from the editor
 * it selects into, and a one-case list cannot exhibit it.
 */
function fixtureProject(): ProjectFile {
  let project = createProjectFile({
    name: PROJECT_NAME,
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Hello" }],
      temperature: 0.4,
    },
    idSuffix: "full-width",
    createdAt: "2026-08-01T12:00:00.000Z",
  });
  project = createPromptTemplate(project, {
    name: "Question",
    messages: [{ role: "user", content: "Explain {{topic}} to engineers." }],
    idSuffix: "question",
    createdAt: "2026-08-01T12:00:01.000Z",
  });
  project = insertPromptTemplateUse(project, {
    conversationRevisionId: project.defaults.conversationRevisionId,
    templateId: "template_question",
    itemIndex: 1,
    idSuffix: "question-use",
  });

  const candidates = evaluationBindingCandidates(
    project,
    project.defaults.conversationRevisionId,
  );
  const topics = createEvaluationSuite(project, "Topic quality", () => "topics");
  project = topics.project;
  const input = addEvaluationInput(project, topics.suiteId, candidates[0]!, () => "topic");
  project = input.project;
  const names = ["migrations", "indexes", "replication", "sharding", "vacuuming", "failover"];
  for (const [index, value] of names.entries()) {
    const added = addEvaluationCase(project, topics.suiteId, () => `case-${index}`);
    project = updateEvaluationCase(added.project, topics.suiteId, added.caseId, {
      name: value,
      values: { [input.inputId]: `database ${value}` },
      // Only the first case carries one, so the disclosure's two states and
      // the per-case remount are both observable.
      ...(index === 0 ? { referenceAnswer: "Explain a safe rollout." } : {}),
    });
    project = addEvaluationCheck(
      project,
      topics.suiteId,
      added.caseId,
      { kind: "contains" },
      () => `check-${index}`,
    );
    const check = project.evaluationSuites[0]!.cases[index]!.checks[0]!;
    project = updateEvaluationCheck(project, topics.suiteId, added.caseId, {
      checkId: check.checkId,
      kind: "contains",
      label: "Mentions database",
      value: "database",
    });
  }

  const safety = createEvaluationSuite(project, "Safety policy", () => "safety");
  return safety.project;
}

async function openEvaluations(page: Page, width: number): Promise<void> {
  await seedProfile(page, {
    endpoint: BUFFERED_FIXTURE_ENDPOINT,
    instanceId: "profile-instance-buffered",
  });
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, fixtureProject(), PROJECT_NAME);
  await openMode(page, "Evaluations");
  await expect(page.locator(".evaluation-editor")).toBeVisible();
}

/**
 * Visible *within the viewport*, not merely rendered. `toBeVisible` passes for
 * an element that sits a thousand pixels below the fold, which is exactly the
 * failure mode the one-long-scroll editor had.
 */
async function inViewport(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return box.top >= 0 &&
      box.bottom <= window.innerHeight &&
      box.height > 0 &&
      box.width > 0;
  });
}

test("the case list and the case editor are both on screen at 1280px", async ({ page }) => {
  await openEvaluations(page, 1280);

  const list = page.locator(".evaluation-case-rail");
  const detail = page.locator(".evaluation-case-detail");
  await expect(list.getByRole("button", { name: "migrations" })).toBeVisible();
  await expect(detail).toContainText("Focused case");

  expect({
    list: await inViewport(list),
    detail: await inViewport(detail),
  }).toEqual({ list: true, detail: true });

  // Selecting the last case must not require scrolling the editor away, and the
  // editor must follow without the list leaving the viewport.
  await list.getByRole("button", { name: "failover" }).click();
  await expect(detail).toHaveAttribute("aria-label", "Edit failover");
  expect({
    list: await inViewport(list),
    detail: await inViewport(detail),
  }).toEqual({ list: true, detail: true });

  // The page itself never scrolls: every region that can overflow owns its own
  // scroll container.
  const page_ = await page.evaluate(() => ({
    horizontal: document.body.scrollWidth <= document.documentElement.clientWidth,
    vertical: document.body.scrollHeight <= document.documentElement.clientHeight + 1,
  }));
  expect(page_).toEqual({ horizontal: true, vertical: true });
});

test("expanding setup does not push the cases off screen", async ({ page }) => {
  await openEvaluations(page, 1280);

  const setup = page.getByRole("button", { name: /^Setup/ });
  await expect(setup).toHaveAttribute("aria-expanded", "true");
  // Everything open at once: the settings panel, the past-executions
  // disclosure, and the band itself. This is the state that used to carry the
  // dataset below the fold.
  await page.getByRole("button", { name: "Execution settings controls" }).click();

  const list = page.locator(".evaluation-case-rail");
  const detail = page.locator(".evaluation-case-detail");
  expect({
    list: await inViewport(list),
    detail: await inViewport(detail),
  }).toEqual({ list: true, detail: true });

  // Shut, the band still states every fact a start depends on, and the primary
  // action and preflight state stay where they were.
  await setup.click();
  await expect(setup).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".evaluation-setup")).toHaveCount(0);
  await expect(setup).toContainText("buffered-test-model");
  await expect(page.locator(".evaluation-preflight")).toContainText("Ready to run");
  await expect(page.locator(".evaluation-preflight")).toContainText("6 selected × 1 rep → 6 runs");
  // This fixture imports a project without mapping its connection, so the start
  // is blocked. The reason must be readable text beside the disabled action
  // with the band shut — a tooltip alone is invisible to keyboard and touch.
  await expect(page.getByRole("button", { name: "Start evaluation…" })).toBeDisabled();
  await expect(page.locator(".evaluation-start-blocked"))
    .toContainText("Map this project's connection to a local profile before starting.");
});

test("suites are a list, not a select, and no focus mode remains", async ({ page }) => {
  await openEvaluations(page, 1280);

  const rail = page.getByRole("navigation", { name: "Evaluation suites" });
  await expect(rail.getByRole("button", { name: /Topic quality/ })).toBeVisible();
  await expect(rail.getByRole("button", { name: /Safety policy/ })).toBeVisible();

  // Switching suites re-targets the header, the cases, and the preview.
  await rail.getByRole("button", { name: /Safety policy/ }).click();
  await expect(page.locator(".evaluation-editor h2")).toHaveText("Safety policy");
  await expect(page.locator(".evaluation-editor")).toContainText("No cases yet");

  await rail.getByRole("button", { name: /Topic quality/ }).click();
  await expect(page.locator(".evaluation-editor h2")).toHaveText("Topic quality");

  // The two focus modes the overhaul set out to remove: this is the evaluation
  // one, and there is no dialog left for it to open into.
  await expect(page.getByLabel("Open evaluation editor in focus mode")).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Evaluation editor focus mode" })).toHaveCount(0);
  // One disclosure per job: the revision picker is a flat control now.
  await expect(page.getByText("Use a project revision…")).toHaveCount(0);
  await expect(page.getByLabel("Existing project revision")).toBeVisible();
});

test("the provider input can be put away and brought back", async ({ page }) => {
  await openEvaluations(page, 1280);

  const preview = page.getByRole("complementary", { name: "Provider input" });
  await expect(preview).toBeVisible();
  const wideDetail = await page.locator(".evaluation-case-detail").boundingBox();

  await preview.getByRole("button", { name: "Hide provider input" }).click();
  await expect(preview).toHaveCount(0);
  const restore = page.getByRole("button", { name: "Show provider input" });
  await expect(restore).toBeVisible();

  // Putting it away is what buys the case editor its width; if it did not, the
  // control would be pointless.
  const widerDetail = await page.locator(".evaluation-case-detail").boundingBox();
  expect(widerDetail!.width).toBeGreaterThan(wideDetail!.width);

  await restore.click();
  await expect(page.getByRole("complementary", { name: "Provider input" })).toBeVisible();
});

test("the setup band says it can be shut, and shutting it gives the cases the height", async ({ page }) => {
  await openEvaluations(page, 1280);

  const setup = page.getByRole("button", { name: /^Setup/ });
  // Open by default, so the affordance has to be on the control itself: a
  // chevron plus a hint naming what shutting it hides.
  await expect(setup).toHaveAttribute("aria-expanded", "true");
  await expect(setup).toContainText("Hide");

  const before = (await page.locator(".evaluation-cases-workspace").boundingBox())!.height;
  await setup.click();
  await expect(setup).toContainText("Show input, settings, and tools");
  const after = (await page.locator(".evaluation-cases-workspace").boundingBox())!.height;
  expect(after).toBeGreaterThan(before);
});

test("the reference answer sits below the checks and stays with its own case", async ({ page }) => {
  await openEvaluations(page, 1280);

  const detail = page.locator(".evaluation-case-detail");
  const reference = detail.locator(".evaluation-reference-answer");

  // Checks are what the case asserts, so they come first in the document.
  const order = await detail.evaluate((element) => {
    const checks = element.querySelector(".evaluation-check-list");
    const ref = element.querySelector(".evaluation-reference-answer");
    return Boolean(checks && ref &&
      checks.compareDocumentPosition(ref) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(order).toBe(true);

  // migrations has one written, so it is not hidden from the author who wrote it.
  await expect(reference).toHaveAttribute("open", "");
  const written = page.getByLabel("Reference answer migrations");
  await expect(written).toHaveValue("Explain a safe rollout.");

  // Edit it, so the field is dirty, then focus a case that has no reference.
  await written.fill("Explain a safe rollout, with a rollback step.");
  await written.blur();

  await page.locator(".evaluation-case-rail").getByRole("button", { name: "indexes" }).click();
  await expect(detail).toHaveAttribute("aria-label", "Edit indexes");
  // Shut, because this case has nothing written — an empty optional field does
  // not outrank the checks.
  await expect(reference).not.toHaveAttribute("open", "");
  await reference.getByText("Reference answer").click();
  // The regression the case editor's key exists for: reusing the instance left
  // the previous case's edited text in this uncontrolled field.
  await expect(page.getByLabel("Reference answer indexes")).toHaveValue("");

  // And the edit is still on the case it was made against.
  await page.locator(".evaluation-case-rail").getByRole("button", { name: "migrations" }).click();
  await expect(page.getByLabel("Reference answer migrations"))
    .toHaveValue("Explain a safe rollout, with a rollback step.");
});

// 1280 is the acceptance width; the others are the mode strip's own breakpoints,
// which the added suite rail must not break.
for (const width of [390, 760, 1100, 1280, 1440]) {
  test(`the evaluation surface fits its viewport at ${width}px`, async ({ page }) => {
    await openEvaluations(page, width);

    await expect(page.getByRole("navigation", { name: "Evaluation suites" })).toBeVisible();
    await expect(page.locator(".evaluation-case-rail")).toBeVisible();
    await expect(page.locator(".evaluation-editor"))
      .not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);

    const horizontal = await page.evaluate(
      () => document.body.scrollWidth <= document.documentElement.clientWidth,
    );
    expect(horizontal).toBe(true);
  });
}
