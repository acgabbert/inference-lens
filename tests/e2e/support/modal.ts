import { expect, type Locator, type Page } from "@playwright/test";

/**
 * The shared modal contract (`app/modal-dialog.client.tsx`), driven from the
 * keyboard: opening from a focused control moves focus in and locks page
 * scroll, Tab and Shift+Tab stay inside, Escape closes only this dialog, and
 * focus returns to `restoreTo`. Pass a callback as `open` when no focusable
 * control opens the dialog (a file input, say); `restoreTo` then defaults to
 * no check.
 */
export async function expectModalContract(
  page: Page,
  {
    open,
    dialog,
    restoreTo = typeof open === "function" ? undefined : open,
    remainsOpen,
  }: {
    open: Locator | (() => Promise<void>);
    dialog: Locator;
    restoreTo?: Locator;
    /** A surface the dialog is layered over, which the same Escape must not close. */
    remainsOpen?: Locator;
  },
): Promise<void> {
  if (typeof open === "function") {
    await open();
  } else {
    await open.focus();
    await open.press("Enter");
  }
  await expect(dialog).toBeVisible();

  const focusInside = () => dialog.evaluate((element) => element.contains(document.activeElement));
  await expect.poll(focusInside, { message: "focus moves into the dialog when it opens" }).toBe(true);
  expect(await page.evaluate(() => document.body.style.overflow), "page behind is scroll-locked").toBe("hidden");
  for (let press = 0; press < 3; press += 1) {
    await page.keyboard.press("Shift+Tab");
    expect(await focusInside(), `Shift+Tab press ${press + 1} stays inside the dialog`).toBe(true);
  }
  for (let press = 0; press < 8; press += 1) {
    await page.keyboard.press("Tab");
    expect(await focusInside(), `Tab press ${press + 1} stays inside the dialog`).toBe(true);
  }

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  if (remainsOpen) await expect(remainsOpen, "Escape closes only the topmost dialog").toBeVisible();
  if (restoreTo) await expect(restoreTo).toBeFocused();
  if (!remainsOpen) {
    expect(await page.evaluate(() => document.body.style.overflow), "scroll lock is released").not.toBe("hidden");
  }
}
