import { expect, test } from "@playwright/test";

import { seedProfile, waitForHydration } from "./support";

test.beforeEach(async ({ page }) => {
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
});

test("header menus dismiss predictably and restore focus on Escape", async ({ page }) => {
  const projectToggle = page.getByLabel("Project menu");
  const projectMenu = page.locator("details.project-menu");
  const runDataToggle = page.getByLabel("Run data menu");
  const runDataMenu = page.locator("details.run-data-menu");

  await projectToggle.click();
  await expect(projectMenu).toHaveAttribute("open", "");

  await runDataToggle.click();
  await expect(projectMenu).not.toHaveAttribute("open", "");
  await expect(runDataMenu).toHaveAttribute("open", "");

  await page.keyboard.press("Escape");
  await expect(runDataMenu).not.toHaveAttribute("open", "");
  await expect(runDataToggle).toBeFocused();

  await projectToggle.click();
  await page.locator(".brand").click();
  await expect(projectMenu).not.toHaveAttribute("open", "");
});
