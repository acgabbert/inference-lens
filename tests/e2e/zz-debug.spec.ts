import { expect, test } from "./support/test";
import { seedProfile, waitForHydration } from "./support";
test.use({ layoutAudit: false });
test("debug", async ({ page }) => {
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  await page.getByRole("button", { name: /run current conversation/i }).click();
  await expect(page.locator(".response-pane")).toContainText("Buffered fixture response");
  await page.getByRole("button", { name: "Run details" }).click();
  await page.getByRole("tab", { name: "Metrics" }).click();
  for (const size of [{ width: 1280, height: 720 }, { width: 1280, height: 560 }]) {
    await page.setViewportSize(size);
    await page.waitForTimeout(300);
    console.log(JSON.stringify(await page.locator(".response-pane").evaluate((pane) => {
      const walk = (n: Element, d: number): unknown[] => { const c = getComputedStyle(n); const row = [d, n.tagName + "." + [...n.classList].join("."), n.clientHeight, n.scrollHeight, c.display, c.flex, c.minHeight, c.maxHeight]; return d > 2 ? [row] : [row, ...[...n.children].flatMap((k) => walk(k, d + 1))]; };
      return walk(pane, 0);
    })));
  }
});
