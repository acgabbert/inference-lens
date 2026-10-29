import { expect, test } from "./support/test";
import type { Locator, Page } from "./support/test";

import { createProjectFile } from "../../packages/core/src/project";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  importProject,
  openMode,
  primaryAction,
  seedProfile,
  waitForHydration,
} from "./support";

/**
 * The pending branch from "Edit from here" to the run that consumes it.
 *
 * `runs-result-discovery.spec.ts` covers branching from a saved trace in Runs.
 * Nothing drove the live transcript's "Edit from here": the composer's
 * pending-branch chip, its save-the-parent action for an unsaved trace, the
 * provenance a branched run records, discarding, and the project import that
 * drops a branch whose parent no longer applies.
 */

const USER_PROMPT = "Explain the answer in one line.";
const ANSWER = "Buffered fixture response: 2 + 2 = 4.";

function pendingBranchChip(page: Page): Locator {
  return page.getByRole("status").filter({ hasText: "Pending branch" });
}

async function runOriginal(page: Page): Promise<void> {
  await seedProfile(page, { endpoint: BUFFERED_FIXTURE_ENDPOINT });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Message 1 content").fill("What is 2 + 2?");
  // The default user prompt varies; the notice names the run by this one.
  await page.getByLabel("Message 2 content").fill(USER_PROMPT);
  await primaryAction(page, "compose").click();
  await expect(page.getByLabel("Run transcript")).toContainText(ANSWER);
}

async function editFromFirstMessage(page: Page): Promise<string> {
  await page
    .getByLabel("Run transcript")
    .getByRole("button", { name: "Edit from here" })
    .first()
    .click();
  const chip = pendingBranchChip(page);
  await expect(chip).toBeVisible();
  // The IDs are debugging detail: in the notice's title, off the visible text.
  const ids = (await chip.locator("[title]").getAttribute("title"))?.split(" · ") ?? [];
  expect(ids).toEqual([expect.stringMatching(/^run_/), expect.stringMatching(/^message_/)]);
  return ids[0]!;
}

for (const width of [1440, 390]) {
  test(`editing from Runs opens the pending branch in Compose at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await runOriginal(page);
    await openMode(page, "Runs");
    const modes = page.getByRole("navigation", { name: "Application mode" });
    await expect(modes.getByRole("button", { name: "Runs", exact: true }))
      .toHaveAttribute("aria-current", "page");
    await page.getByLabel("Run transcript")
      .getByRole("button", { name: "Edit from here" }).first().click();

    await expect(modes.getByRole("button", { name: "Compose", exact: true }))
      .toHaveAttribute("aria-current", "page");
    await expect(pendingBranchChip(page)).toBeVisible();
    await expect(page.getByLabel("Message 1 content")).toBeVisible();
    await expect(page.getByLabel("Message 1 content")).toHaveValue("What is 2 + 2?");
    await expect(page.getByLabel("Message 2 content")).toHaveCount(0);

    // Returning to Runs still shows the complete original transcript.
    await openMode(page, "Runs");
    await expect(page.getByLabel("Run transcript")).toContainText(ANSWER);
    await openMode(page, "Compose");
    await expect(pendingBranchChip(page)).toBeVisible();
  });
}

test("editing from a transcript message branches the next run from it", async ({ page }) => {
  await runOriginal(page);

  const parentRunId = await editFromFirstMessage(page);
  const chip = pendingBranchChip(page);
  // Named the way the transcript and Runs name it, never by raw IDs.
  // The title is the run's request excerpt, as Runs lists it. Message 1 of
  // the default draft is the system message.
  await expect(chip).toContainText(`Branching from \u201c${USER_PROMPT}\u201d at Message 1 \u00b7 system.`);
  await expect(chip).toContainText("The original trace is unchanged.");
  expect(await chip.innerText()).not.toMatch(/\b(run|message)_[A-Za-z0-9]/);
  // No project folder was open, so the parent trace exists only in memory.
  await expect(chip.getByRole("button", { name: "Save trace…" })).toBeVisible();
  expect(await chip.innerText()).not.toMatch(/NaN|Infinity|undefined/);
  await expect(page.getByLabel("Message 1 content")).toHaveValue("What is 2 + 2?");
  await expect(page.getByLabel("Message 2 content")).toHaveCount(0);

  await page.getByLabel("Message 1 content").fill("What is 3 + 3?");
  await primaryAction(page, "compose").click();
  await expect(page.getByLabel("Run transcript")).toContainText(ANSWER);
  // The trace records only the parent's IDs, so the line names no run.
  const provenance = page.locator(".branch-provenance");
  await expect(provenance).toHaveText("Branched from an earlier run.");
  await expect(provenance.locator("[title]")).toHaveAttribute("title", parentRunId);
  // The run consumed the branch.
  await expect(chip).toHaveCount(0);
});

test("a pending branch can be discarded", async ({ page }) => {
  await runOriginal(page);
  await editFromFirstMessage(page);

  await pendingBranchChip(page).getByRole("button", { name: "Discard branch" }).click();
  await expect(pendingBranchChip(page)).toHaveCount(0);

  await primaryAction(page, "compose").click();
  await expect(page.getByLabel("Run transcript")).toContainText(ANSWER);
  await expect(page.locator(".branch-provenance")).toHaveCount(0);
});

test("applying a project's draft drops the pending branch", async ({ page }) => {
  await runOriginal(page);
  await editFromFirstMessage(page);

  const name = "Pending branch fixture";
  await importProject(
    page,
    createProjectFile({
      name,
      request: {
        provider: "openai-compatible",
        endpoint: BUFFERED_FIXTURE_ENDPOINT,
        model: "buffered-test-model",
        messages: [{ role: "user", content: "From the project." }],
      },
      idSuffix: "pending-branch",
      createdAt: "2026-10-08T12:00:00.000Z",
    }),
    name,
  );
  await expect(page.getByLabel("Message 1 content")).toHaveValue("From the project.");
  await expect(pendingBranchChip(page)).toHaveCount(0);
});

for (const key of ["Enter", " "]) {
  test(`"Edit from here" starts a branch from the keyboard (${key === " " ? "Space" : key})`, async ({ page }) => {
    await runOriginal(page);
    const transcript = page.getByLabel("Run transcript");
    await transcript.getByRole("button", { name: "Edit from here" }).first().focus();
    await page.keyboard.press(key);

    await expect(pendingBranchChip(page)).toBeVisible();
    // The key belongs to the button, not to the message row around it.
    await expect(
      transcript.getByRole("button", { name: "Expand system message" }),
    ).toBeVisible();
  });
}

test("a transcript message row still toggles from the keyboard", async ({ page }) => {
  await runOriginal(page);
  const transcript = page.getByLabel("Run transcript");
  await transcript.getByRole("button", { name: "Expand system message" }).focus();
  await page.keyboard.press("Enter");
  await expect(transcript.getByRole("button", { name: "Collapse system message" })).toBeFocused();
  await page.keyboard.press(" ");
  await expect(transcript.getByRole("button", { name: "Expand system message" })).toBeFocused();
  await expect(pendingBranchChip(page)).toHaveCount(0);
});
