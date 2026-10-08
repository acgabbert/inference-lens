import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { createProjectFile } from "../../packages/core/src/project";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  importProject,
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

const ANSWER = "Buffered fixture response: 2 + 2 = 4.";

function pendingBranchChip(page: Page): Locator {
  return page.getByRole("status").filter({ hasText: "Pending branch" });
}

async function runOriginal(page: Page): Promise<void> {
  await seedProfile(page, { endpoint: BUFFERED_FIXTURE_ENDPOINT });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Message 1 content").fill("What is 2 + 2?");
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
  const parentRunId = await chip.locator("code").first().innerText();
  expect(parentRunId).toMatch(/^run_/);
  return parentRunId;
}

test("editing from a transcript message branches the next run from it", async ({ page }) => {
  await runOriginal(page);

  const parentRunId = await editFromFirstMessage(page);
  const chip = pendingBranchChip(page);
  await expect(chip).toContainText(`Branching from run ${parentRunId} at message`);
  await expect(chip).toContainText("The original trace is unchanged.");
  // No project folder was open, so the parent trace exists only in memory.
  await expect(chip.getByRole("button", { name: "Save trace…" })).toBeVisible();
  expect(await chip.innerText()).not.toMatch(/NaN|Infinity|undefined/);
  await expect(page.getByLabel("Message 1 content")).toHaveValue("What is 2 + 2?");
  await expect(page.getByLabel("Message 2 content")).toHaveCount(0);

  await page.getByLabel("Message 1 content").fill("What is 3 + 3?");
  await primaryAction(page, "compose").click();
  await expect(page.getByLabel("Run transcript")).toContainText(ANSWER);
  await expect(page.locator(".branch-provenance")).toHaveText(
    `Branched from run ${parentRunId}.`,
  );
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
