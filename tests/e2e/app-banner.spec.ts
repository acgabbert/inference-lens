import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { seedProfile, waitForHydration } from "./support";

/**
 * One banner slot, whatever else is true.
 *
 * Before the notification system each standing condition decided its own
 * visibility, so two could be on screen at once — a failure bar under the
 * topbar and an environment advisory floating over the workbench — with nothing
 * stating which mattered more. The tier now has a stated priority and a single
 * slot, and the property worth testing in a browser rather than in a unit is
 * that the losing condition is *reported* and then genuinely takes the slot
 * once the winner is gone. A priority that silently swallowed the second
 * problem would pass the unit test and still strand the user.
 *
 * Both conditions are staged deterministically. Waiting for a real untrusted
 * origin or a real corrupt project on disk would make this a test of luck.
 */

/**
 * Stages the environment advisory.
 *
 * `insecureOriginNotice` is a pure function of `window.isSecureContext`, the
 * hostname, and the port, and the suite is served over loopback — which
 * browsers trust, so the advisory can never arise on its own here. Overriding
 * the one input the app reads produces the real notice through the real code
 * path; nothing about the notice itself is faked.
 */
async function stageUntrustedOrigin(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });
  });
}

/** Stages the failure by importing something that is not a project. */
async function stageProjectImportFailure(page: Page): Promise<void> {
  await page.getByLabel("Project menu").click();
  await page.setInputFiles(
    '.project-popover:not(.run-data-popover) input[type="file"]',
    {
      name: "not-a-project.json",
      mimeType: "application/json",
      buffer: Buffer.from("{ this is not a project }"),
    },
  );
  await page.evaluate(() => {
    document
      .querySelectorAll<HTMLDetailsElement>("details.project-menu")
      .forEach((menu) => {
        menu.open = false;
      });
  });
}

const banners = (page: Page) => page.locator("[data-app-banner]");

test("two standing conditions produce one banner, and the loser is named and then shown", async ({
  page,
}) => {
  await stageUntrustedOrigin(page);
  await seedProfile(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await waitForHydration(page);

  // The advisory alone holds the slot.
  await expect(banners(page)).toHaveCount(1);
  await expect(banners(page)).toHaveAttribute("data-app-banner", "insecure-origin");
  await expect(banners(page)).not.toContainText("waiting behind this one");

  await stageProjectImportFailure(page);

  // The failure outranks it, and there is still exactly one banner.
  await expect(banners(page)).toHaveCount(1);
  await expect(banners(page)).toHaveAttribute("data-app-banner", "project-error");
  // The parser's own wording is the browser's and is not asserted; that it
  // reached the banner as readable text rather than a placeholder is.
  expect(await banners(page).innerText()).not.toMatch(
    /NaN|undefined|\[object Object\]/,
  );
  // Suppression is stated rather than silent. This is the line that makes one
  // slot honest instead of lossy.
  await expect(banners(page)).toContainText("1 more notice is waiting behind this one.");

  await banners(page).getByRole("button", { name: "Dismiss" }).click();

  // And the displaced condition really does return, rather than having been
  // dropped when it lost.
  await expect(banners(page)).toHaveCount(1);
  await expect(banners(page)).toHaveAttribute("data-app-banner", "insecure-origin");
  await expect(banners(page)).toContainText("not served from a trusted origin");

  await banners(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(banners(page)).toHaveCount(0);
});

/**
 * A failure interrupts; an advisory does not. Someone may have been reading
 * past an environment note for minutes, and re-announcing it assertively would
 * cut across whatever they are doing now — while a failure that has just
 * refused their work is exactly what should.
 */
test("the banner's politeness follows its tone", async ({ page }) => {
  await stageUntrustedOrigin(page);
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);

  await expect(banners(page)).toHaveAttribute("role", "status");
  await stageProjectImportFailure(page);
  await expect(banners(page)).toHaveAttribute("role", "alert");
});
