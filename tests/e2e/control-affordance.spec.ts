import { expect, test } from "@playwright/test";

import { seedProfile, waitForHydration } from "./support";

/**
 * An unfocused text field has to be findable. Every input and select in the app
 * gets its border from one shared rule; a bare `textarea` rule used to strip
 * that border back off, so each textarea was invisible against the panel it sat
 * on until it was focused, and every new one had to re-declare the border by
 * hand. The composer message body is the one deliberate exception: it fills its
 * card edge to edge, so the card supplies the border.
 *
 * This walks the real controls rather than a fixture of them, so a textarea
 * added later is covered without touching this file.
 */
type Field = { label: string; borderWidth: string; borderColor: string; background: string };

async function unfocusedFields(page: import("@playwright/test").Page): Promise<Field[]> {
  return page.$$eval<Field[], HTMLTextAreaElement>(
    "textarea:not(.message-card textarea)",
    (nodes) =>
      nodes
        .filter((node) => node.offsetParent !== null)
        .map((node) => {
          const style = getComputedStyle(node);
          return {
            label: node.getAttribute("aria-label") ?? node.className ?? node.tagName,
            borderWidth: style.borderTopWidth,
            borderColor: style.borderTopColor,
            background: style.backgroundColor,
          };
        }),
  );
}

function expectVisibleEdges(fields: Field[]) {
  expect(fields.length).toBeGreaterThan(0);
  for (const field of fields) {
    expect(field, `${field.label} has no border`).not.toMatchObject({ borderWidth: "0px" });
    expect(field.borderColor, `${field.label} border matches its own fill`).not.toBe(
      field.background,
    );
  }
}

test("tool editor text fields have a visible edge before focus", async ({ page }) => {
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  await page.getByRole("tab", { name: "Tools" }).click();
  await page
    .locator(".tools-tab-toolbar")
    .getByRole("button", { name: "+ Add project tool" })
    .click();

  const description = page.getByLabel("Description").first();
  await expect(description).toBeVisible();

  expectVisibleEdges(await unfocusedFields(page));
});

test("the composer message body stays borderless inside its card", async ({ page }) => {
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);

  const body = page.locator(".message-card textarea").first();
  await expect(body).toBeVisible();
  await expect(body).toHaveCSS("border-top-width", "0px");
  // The card it sits in is what draws the edge in its place.
  await expect(page.locator(".message-card").first()).not.toHaveCSS(
    "border-top-width",
    "0px",
  );
});
