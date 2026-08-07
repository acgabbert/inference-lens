import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { createEvaluationSuite } from "../../packages/core/src/evaluation-suite-authoring";
import {
  createProjectFile,
  parseProjectFile,
} from "../../packages/core/src/project";
import type { ProjectFile } from "../../packages/core/src/project";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  importProject,
  openMode,
  seedProfile,
  waitForHydration,
} from "./support";

/**
 * UX PR2's progressive-disclosure pass: Configurations and Tools collapse
 * behind a summary until there is something in them worth opening for, and a
 * suite with zero cases reads that as its primary next step rather than as a
 * peer of the setup band.
 */

function freshSuiteProject(): ProjectFile {
  const initial = createProjectFile({
    name: "Setup disclosure fixture",
    idSuffix: "setup-disclosure",
    createdAt: "2026-08-06T12:00:00.000Z",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Hello" }],
    },
  });
  const { project } = createEvaluationSuite(initial, "Fresh suite", () => "fresh");
  return project;
}

/** One suite, one unmapped connection requirement, a single default configuration. */
function unmappedProject(): ProjectFile {
  const initial = createProjectFile({
    name: "Unmapped disclosure fixture",
    idSuffix: "unmapped-disclosure",
    createdAt: "2026-08-06T12:00:01.000Z",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Hello" }],
    },
  });
  return parseProjectFile({
    ...initial,
    evaluationSuites: [{
      id: "evaluation-suite_unmapped",
      name: "Unmapped suite",
      input: {
        kind: "conversation-revision",
        conversationRevisionId: initial.defaults.conversationRevisionId,
      },
      execution: {
        target: structuredClone(initial.defaults.target),
        responseMode: "buffered",
        options: {},
        repetitions: 1,
        toolIds: [],
      },
      variants: [{ id: "evaluation-variant_default", name: "Default", overrides: {} }],
      inputBindings: [],
      cases: [{
        id: "evaluation-case_one",
        name: "One",
        values: {},
        checks: [{ checkId: "check_one", kind: "contains", value: "hi", caseSensitive: false }],
      }],
    }],
  });
}

async function openEvaluations(page: Page, project: ProjectFile, name: string): Promise<void> {
  await seedProfile(page, { endpoint: BUFFERED_FIXTURE_ENDPOINT });
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, project, name);
  await openMode(page, "Evaluations");
  await expect(page.locator(".evaluation-editor")).toBeVisible();
}

test("a fresh suite's single default configuration starts collapsed with an honest summary", async ({ page }) => {
  await openEvaluations(page, freshSuiteProject(), "Setup disclosure fixture");
  const toggle = page.getByRole("button", { name: /^Configurations/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toContainText("1 configuration (Default, inherits everything)");
  // The row itself is not in the DOM output while the band is shut — the
  // disclosure hides the control surface, not just its visibility.
  await expect(page.getByRole("article", { name: "Configuration Default" })).toHaveCount(0);

  const toolsToggle = page.getByRole("button", { name: /^Tools/ });
  await expect(toolsToggle).toHaveAttribute("aria-expanded", "false");
  await expect(toolsToggle).toContainText("None exposed");
});

test("adding a second configuration opens the disclosure and updates the summary", async ({ page }) => {
  await openEvaluations(page, freshSuiteProject(), "Setup disclosure fixture");
  const toggle = page.getByRole("button", { name: /^Configurations/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  await page.getByRole("button", { name: "+ Add configuration" }).click();

  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toContainText("2 configurations: Default, New configuration");
  await expect(page.getByRole("article", { name: "Configuration Default" })).toBeVisible();
  await expect(page.getByRole("article", { name: "Configuration New configuration" })).toBeVisible();
});

test("a suite with an override loaded from disk opens Configurations by default", async ({ page }) => {
  const project = freshSuiteProject();
  const suite = project.evaluationSuites[0]!;
  suite.variants[0]!.overrides = { options: { temperature: 0.9 } };
  await openEvaluations(page, project, "Setup disclosure fixture");

  const toggle = page.getByRole("button", { name: /^Configurations/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toContainText("1 configuration (Default)");
  await expect(toggle).not.toContainText("inherits everything");
});

test("an unmapped-profile blocker stays visible while Configurations is shut", async ({ page }) => {
  await openEvaluations(page, unmappedProject(), "Unmapped disclosure fixture");
  const editor = page.locator(".evaluation-editor");
  const toggle = page.getByRole("button", { name: /^Configurations/ });

  // One configuration, no override: the disclosure has nothing to show yet.
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(editor).toContainText(
    "Map “Default connection” to a local profile for configuration “Default”.",
  );
});

test("the Configurations toggle stays within its row at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openEvaluations(page, freshSuiteProject(), "Setup disclosure fixture");
  const toggle = page.getByRole("button", { name: /^Configurations/ });
  const fits = await toggle.evaluate((element) => element.scrollWidth <= element.clientWidth + 1);
  expect(fits).toBe(true);
});

test("an empty suite's dataset reads as the primary next step, not an inline note", async ({ page }) => {
  await openEvaluations(page, freshSuiteProject(), "Setup disclosure fixture");
  const editor = page.locator(".evaluation-editor");
  await expect(editor).toContainText("No cases yet");
  const action = editor.getByRole("button", { name: "+ Add case", exact: true });
  await expect(action).toHaveClass(/\bprimary\b/);
  // Only one "+ Add case" affordance exists while the suite is empty — the
  // section heading's own button is withheld so the empty state is not a
  // peer to an identical control above it.
  await expect(editor.getByRole("button", { name: "+ Add case", exact: true })).toHaveCount(1);

  await action.click();
  await expect(editor).not.toContainText("No cases yet");
});
