import { expect, test } from "@playwright/test";

import { seedProfile, waitForHydration } from "./support";

/**
 * A tool's description is the main lever on tool-selection quality and is
 * routinely a multi-line brief, so the field has to accept newlines and keep
 * them. The function name is the opposite: providers document
 * `^[a-zA-Z0-9_-]{1,64}$`, so the editor has to say so before the request is
 * built rather than letting the provider reject it.
 */
async function openToolEditor(page: import("@playwright/test").Page) {
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  await page.getByRole("tab", { name: "Tools" }).click();
  await page
    .locator(".tools-tab-toolbar")
    .getByRole("button", { name: "+ Add project tool" })
    .click();
}

test("a tool description keeps the newlines typed into it", async ({ page }) => {
  await openToolEditor(page);

  const description = page.getByLabel("Description").first();
  await expect(description).toHaveJSProperty("tagName", "TEXTAREA");

  const brief = [
    "Look up the current weather for one city.",
    "",
    "Use when the user names a place and asks about conditions.",
    "Do not use for forecasts more than 24 hours out.",
  ].join("\n");
  await description.fill(brief);

  await expect(description).toHaveValue(brief);
  // The manifest above the editor reads the same draft the request is built
  // from, so this is the value that would be serialized.
  await expect(page.locator(".tool-manifest-list")).toContainText(
    "Look up the current weather for one city.",
  );
});

test("a function name with a space is called out in the editor", async ({ page }) => {
  await openToolEditor(page);

  const name = page.getByLabel("Function name").first();
  await name.fill("get weather");

  const warning = page.getByRole("alert").filter({ hasText: "no spaces" });
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("1–64 letters, digits, underscores, or dashes");
  await expect(name).toHaveAttribute("aria-invalid", "true");

  await name.fill("get_weather");
  await expect(warning).toBeHidden();
  await expect(name).not.toHaveAttribute("aria-invalid", "true");
});
