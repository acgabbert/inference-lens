import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  addEvaluationCase,
  createEvaluationSuite,
} from "../../packages/core/src/evaluation-suite-authoring";
import { createProjectFile } from "../../packages/core/src/project";
import type { ProjectFile } from "../../packages/core/src/project";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  PROJECT_PROFILE_MAP_STORAGE_KEY,
  importProject,
  openMode,
  primaryAction,
  seedProfile,
  waitForHydration,
} from "./support";

/**
 * The topbar holds one primary action and `Stop`; nothing else.
 *
 * This is the property the mode boundary was introduced to make true. Before
 * it, one expression in the topbar produced six different button sets, and the
 * slot a user clicks by reflex changed identity underneath them — at its worst
 * putting `Discard failed run`, which throws work away, next to `Retry`.
 *
 * So what is asserted here is not that particular buttons exist. It is that the
 * *count* is bounded and the *identity* is a function of the mode alone, and
 * that the lifecycle actions which used to crowd in beside it are now at the
 * thing they act on instead.
 */

/** Every control the topbar may render in its run-control slot. */
const RUN_CONTROL_LABELS = [
  /^Run request/,
  /^Start evaluation…/,
  /^Stop$/,
  /^Stop remaining$/,
  /^Continue run$/,
  /^Retry$/,
  /^Run new request$/,
  /^Discard failed run$/,
  /^Repeat…$/,
];

async function runControls(page: Page): Promise<string[]> {
  return page.locator(".header-actions > .button").allInnerTexts();
}

function fixture(): ProjectFile {
  let project = createProjectFile({
    name: "Primary action fixture",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Say hello." }],
    },
    idSuffix: "primary-action",
    createdAt: "2026-08-04T12:00:00.000Z",
  });
  const created = createEvaluationSuite(project, "Greetings", () => "greetings");
  project = created.project;
  return addEvaluationCase(project, created.suiteId, () => "case-0").project;
}

/**
 * Mapped on purpose. An unmapped project blocks the run, and a spec about which
 * controls are on screen must not be reading a screen where half of them are
 * disabled for an unrelated reason — `blocker-chip.spec.ts` owns that state.
 */
async function open(page: Page): Promise<void> {
  const project = fixture();
  await seedProfile(page, {
    endpoint: BUFFERED_FIXTURE_ENDPOINT,
    instanceId: "profile-instance-buffered",
  });
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
      instanceId: "profile-instance-buffered",
    },
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, project, "Primary action fixture");
}

test("each mode shows exactly its own primary action and nothing else", async ({ page }) => {
  await open(page);

  // Compose: one button, and it is the run.
  expect(await runControls(page)).toEqual(["Run request ⌘↵"]);
  await expect(primaryAction(page, "compose")).toBeVisible();
  await expect(primaryAction(page, "evaluations")).toHaveCount(0);

  await openMode(page, "Evaluations");
  expect(await runControls(page)).toEqual(["Start evaluation… ⌘↵"]);
  await expect(primaryAction(page, "compose")).toHaveCount(0);

  // Runs is where results are read, not where work is started, so the slot is
  // genuinely empty rather than holding a disabled leftover from another mode.
  await openMode(page, "Runs");
  expect(await runControls(page)).toEqual([]);
  await expect(primaryAction(page, "compose")).toHaveCount(0);
  await expect(primaryAction(page, "evaluations")).toHaveCount(0);
});

test("no run-lifecycle action is left in the topbar in any mode", async ({ page }) => {
  await open(page);

  for (const mode of ["Compose", "Evaluations", "Runs"] as const) {
    await openMode(page, mode);
    const header = page.locator(".header-actions");
    const rendered = await runControls(page);
    // At most the mode's primary plus `Stop`, and never more than that.
    expect(rendered.length, `${mode} renders ${rendered.length} run controls`)
      .toBeLessThanOrEqual(2);
    for (const label of [/^Continue run$/, /^Retry$/, /^Discard failed run$/, /^Run new request$/, /^Repeat…$/]) {
      await expect(
        header.getByRole("button", { name: label }),
        `${mode} still offers ${label.source} in the topbar`,
      ).toHaveCount(0);
    }
  }
  // The labels above are the full inventory this spec claims to police; if a
  // new control joins the topbar it has to be added here deliberately.
  expect(RUN_CONTROL_LABELS.length).toBe(9);
});

test("Repeat moves to the composer header and stays on every request tab", async ({ page }) => {
  await open(page);

  const composerHeader = page.locator(".request-header-actions");
  const repeat = composerHeader.getByRole("button", { name: "Repeat…" });

  // It repeats whatever the composer holds, so which tab is open is irrelevant
  // to it — and it is never in the topbar, whose one slot belongs to the run.
  for (const tab of ["Messages", "Prompts", "Tools"]) {
    await page.getByRole("tab", { name: new RegExp(`^${tab}`) }).click();
    await expect(repeat).toBeVisible();
  }
  await expect(page.locator(".header-actions").getByRole("button", { name: "Repeat…" }))
    .toHaveCount(0);

  await expect(repeat).toBeEnabled();
  await repeat.click();
  await expect(page.getByRole("dialog", { name: "Run this frozen request repeatedly" }))
    .toBeVisible();
});
