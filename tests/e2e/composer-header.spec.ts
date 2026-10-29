import { expect, test } from "./support/test";
import type { Page } from "./support/test";

import { createProjectFile } from "../../packages/core/src/project";
import {
  importProject,
  openAttachToolMenu,
  PROJECT_PROFILE_MAP_STORAGE_KEY,
  seedProfile,
  waitForHydration,
} from "./support";

/**
 * The chrome above the first message editor (UX plan section 8). The pane
 * positions and tabs already say which pane is which, so the headings that
 * repeated it are gone; the panes keep their names as regions.
 */

/**
 * Where the first message editor's textarea started on `main` before this
 * change, at 1280×800 (the plan's "about y=385" measured the editor card).
 */
const BASELINE_FIRST_MESSAGE_TOP = 426.5;
const MINIMUM_GAIN = 100;

test("the first message editor starts at least 100px higher than in 0.6.0", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);

  const box = await page.getByLabel("Message 1 content").boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeLessThanOrEqual(BASELINE_FIRST_MESSAGE_TOP - MINIMUM_GAIN);
});

test("a project model that differs from the profile keeps the budget and the protocol", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const instanceId = "profile-instance-header-budget";
  const project = createProjectFile({
    name: "Header budget project",
    request: {
      provider: "openai-compatible",
      endpoint: "http://127.0.0.1:44014/v1",
      model: "a-long-dated-model-identifier-2026-10-28-preview",
      messages: [{ role: "user", content: "Check the header." }],
    },
    idSuffix: "header-budget",
    createdAt: "2026-10-28T12:00:00.000Z",
  });
  await seedProfile(page, { name: "Header budget fixture", instanceId });
  await page.addInitScript(
    ({ mapKey, projectId, instanceId }) => {
      localStorage.setItem(
        mapKey,
        JSON.stringify({ [projectId]: { profileId: "buffered", profileInstanceId: instanceId } }),
      );
    },
    { mapKey: PROJECT_PROFILE_MAP_STORAGE_KEY, projectId: project.projectId, instanceId },
  );
  await page.goto("/");
  await waitForHydration(page, "Header budget fixture");
  await importProject(page, project, "Header budget project");

  const composer = page.getByRole("region", { name: "Request composer" });
  // The override is marked on the model field itself, not on a line of its own.
  await expect(composer.getByRole("button", { name: /^Revert model to/ })).toBeVisible();
  const box = await page.getByLabel("Message 1 content").boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeLessThanOrEqual(BASELINE_FIRST_MESSAGE_TOP - MINIMUM_GAIN);

  const protocol = composer.locator(".inference-settings-fact").first();
  await expect(protocol).toHaveText("Chat Completions");
  expect(
    await protocol.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
});

test("the request and response panes keep their names without headings", async ({ page }) => {
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);

  await expect(page.getByRole("region", { name: "Request composer" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Response output" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Composer", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Live output", exact: true })).toHaveCount(0);
});

test("the tool line is absent when nothing is attached", async ({ page }) => {
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);

  await expect(page.locator(".request-tool-line")).toHaveCount(0);
  // The Tools tab count still says 0.
  await expect(page.getByRole("tab", { name: /^Tools/ })).toContainText("0");
});

async function attachTabTool(page: Page): Promise<void> {
  await page.getByRole("tab", { name: /^Tools/ }).click();
  const menu = await openAttachToolMenu(page);
  await menu.getByRole("button", { name: "New definition" }).click();
  await page.getByRole("tab", { name: /^Messages/ }).click();
}

test("an attached tool keeps its line, and Review opens the Tools tab", async ({ page }) => {
  await seedProfile(page, { capabilityOverrides: { tools: true } });
  await page.goto("/");
  await waitForHydration(page);
  await attachTabTool(page);

  const line = page.locator(".request-tool-line");
  await expect(line).toContainText("1 tool attached");
  await expect(line).not.toHaveClass(/blocked/);
  await line.getByRole("button", { name: "Review" }).click();
  await expect(page.getByRole("region", { name: "Tools attached to this request" })).toBeVisible();
});

test("a blocked attachment stays visible while settings are collapsed", async ({ page }) => {
  await seedProfile(page, { capabilityOverrides: { tools: false } });
  await page.goto("/");
  await waitForHydration(page);
  await attachTabTool(page);

  await expect(
    page.locator('[aria-label="Run settings"] .inference-settings-toggle'),
  ).toHaveAttribute("aria-expanded", "false");
  const line = page.locator(".request-tool-line.blocked");
  await expect(line).toBeVisible();
  await expect(line).toContainText("unavailable because this profile does not allow tool calling");
});

test("the Chat / Decision switch shares the header row with the request tabs", async ({ page }) => {
  await page.setViewportSize({ width: 880, height: 720 });
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);

  const kind = page.getByRole("radiogroup", { name: "Request kind" });
  const tabs = page.getByRole("tablist", { name: "Request editor" });
  await expect(kind).toBeVisible();
  const [kindBox, tabsBox] = [await kind.boundingBox(), await tabs.boundingBox()];
  // One row at the narrowest desktop width: no label wraps over the tabs.
  expect(Math.abs(kindBox!.y - tabsBox!.y)).toBeLessThan(kindBox!.height);
  expect(kindBox!.x + kindBox!.width).toBeLessThanOrEqual(tabsBox!.x);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // The same switch heads the Decision composer, beside its Form / JSON tabs.
  await kind.getByRole("radio", { name: "Decision" }).click();
  await expect(page.getByRole("radiogroup", { name: "Request kind" })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Decision editor" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Decision request" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Decision", exact: true })).toHaveCount(0);
  await page.getByRole("radiogroup", { name: "Request kind" }).getByRole("radio", { name: "Chat" }).click();
  await expect(page.getByLabel("Message 1 content")).toBeVisible();
});

test("focus mode leaves the Chat / Decision switch behind its scrim", async ({ page }) => {
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);

  await page.getByRole("button", { name: "Open request composer in focus mode" }).click();
  const dialog = page.getByRole("dialog", { name: "Request composer focus mode" });
  await expect(dialog.getByLabel("Message 1 content")).toBeFocused();
  // Switching kind would unmount the dialog under the keyboard; the switch is
  // part of the docked layout, as it was before it joined the header.
  expect(await dialog.getByRole("radiogroup", { name: "Request kind" }).count()).toBe(0);

  await dialog.getByRole("button", { name: "Exit request composer focus mode" }).click();
  await expect(page.getByRole("radiogroup", { name: "Request kind" })).toBeVisible();
});
