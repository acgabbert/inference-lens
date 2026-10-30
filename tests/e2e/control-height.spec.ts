import { expect, test } from "./support/test";
import type { Locator, Page } from "./support/test";

import {
  addEvaluationCase,
  addEvaluationInput,
  createEvaluationSuite,
  evaluationBindingCandidates,
  updateEvaluationCase,
} from "../../packages/core/src/evaluation-suite-authoring";
import {
  createProjectFile,
  createPromptTemplate,
  insertPromptTemplateUse,
} from "../../packages/core/src/project";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  importProject,
  openMode,
  primaryAction,
  seedProfile,
  waitForHydration,
} from "./support";

/**
 * Buttons, single-line inputs and selects share one height, so a row that
 * mixes them lines up without a local override. Selects used to be 32px while
 * buttons and inputs took their height from padding, about 36px, and every row
 * that put them side by side sat out of line: the pinned prompt card, the
 * Prompts insert bar, the evaluation input picker, the topbar.
 *
 * The two-line connection selector in the topbar and the text-only actions
 * ("Remove", "Rename") are not controls of this kind and are not measured.
 */
const CONTROL_HEIGHT = 32;

function project() {
  let file = createProjectFile({
    name: "Control height fixture",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Hello" }],
    },
    idSuffix: "control-height",
    createdAt: "2026-10-30T12:00:00.000Z",
  });
  file = createPromptTemplate(file, {
    name: "Question",
    messages: [{ role: "user", content: "Explain {{topic}}." }],
    variableDefaults: { topic: "indexes" },
    idSuffix: "question",
    createdAt: "2026-10-30T12:00:01.000Z",
  });
  file = insertPromptTemplateUse(file, {
    conversationRevisionId: file.defaults.conversationRevisionId,
    templateId: "template_question",
    itemIndex: 1,
    idSuffix: "question-use",
  });
  const candidates = evaluationBindingCandidates(file, file.defaults.conversationRevisionId);
  const created = createEvaluationSuite(file, "Topics", () => "topics");
  file = created.project;
  const input = addEvaluationInput(file, created.suiteId, candidates[0]!, () => "topic");
  file = input.project;
  const added = addEvaluationCase(file, created.suiteId, () => "case-0");
  return updateEvaluationCase(added.project, created.suiteId, added.caseId, {
    name: "migrations",
    values: { [input.inputId]: "database migrations" },
  });
}

async function expectOneRow(name: string, controls: Locator[]) {
  const boxes = await Promise.all(
    controls.map(async (control) => {
      await expect(control).toBeVisible();
      return (await control.boundingBox())!;
    }),
  );
  const heights = boxes.map((box) => Math.round(box.height));
  expect(heights, `${name} control heights`).toEqual(controls.map(() => CONTROL_HEIGHT));
  const centers = boxes.map((box) => box.y + box.height / 2);
  expect(
    Math.max(...centers) - Math.min(...centers),
    `${name} control centres`,
  ).toBeLessThanOrEqual(1);
}

async function openFixture(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await seedProfile(page, { instanceId: "profile-instance-buffered" });
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, project(), "Control height fixture");
}

test("compose rows line up their controls at the shared height", async ({ page }) => {
  await openFixture(page);

  await expectOneRow("topbar", [
    page.getByLabel("Project menu"),
    page.getByLabel("Run data menu"),
    primaryAction(page, "compose"),
  ]);

  const composer = page.getByRole("region", { name: "Request composer" });
  await expectOneRow("composer actions", [
    composer.getByRole("button", { name: "+ Add message" }),
    composer.getByRole("button", { name: "Insert saved prompt…" }),
    composer.getByRole("button", { name: "Repeat…" }),
    composer.getByRole("button", { name: "Open request composer in focus mode" }),
  ]);

  await expectOneRow("pinned prompt", [
    composer.getByLabel("Pinned revision"),
    composer.getByRole("button", { name: "Edit source" }),
    composer.getByRole("button", { name: "Detach" }),
  ]);
});

test("prompt editor rows line up their controls at the shared height", async ({ page }) => {
  await openFixture(page);
  await openMode(page, "Prompts");

  const editor = page.locator(".template-editor");
  await expectOneRow("prompt content", [
    editor.getByRole("button", { name: "Paste from n8n…" }),
    editor.getByRole("button", { name: "Open prompt editor in focus mode" }),
  ]);
  await expectOneRow("insert bar", [
    page.getByLabel("Position"),
    page.getByRole("button", { name: "Add to conversation" }),
  ]);
});

test("evaluation setup rows line up their controls at the shared height", async ({ page }) => {
  await openFixture(page);
  await openMode(page, "Evaluations");

  await expectOneRow("evaluation input", [
    page.getByRole("button", { name: "Start from prompt…" }),
    page.getByLabel("Existing project revision"),
  ]);
  await expectOneRow("new check", [
    page.getByLabel("New check kind"),
    page.getByRole("button", { name: "+ Add check" }),
  ]);
});
