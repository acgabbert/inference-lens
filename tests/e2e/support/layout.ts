import { expect, type Locator, type Page } from "@playwright/test";

/** Visibility alone permits a collapsed scroller with overflowing descendants. */
export async function expectTableContentHeight(scroller: Locator): Promise<void> {
  await expect(scroller.locator("thead")).toBeAttached();
  const geometry = await scroller.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const table = element.querySelector("table")!.getBoundingClientRect();
    const header = element.querySelector("thead")!.getBoundingClientRect();
    return {
      height: element.clientHeight,
      tableHeight: table.height,
      headerTop: header.top - box.top,
      headerBottom: header.bottom - box.top,
    };
  });
  expect(geometry.height, JSON.stringify(geometry)).toBeGreaterThan(0);
  expect(geometry.height, JSON.stringify(geometry)).toBeGreaterThanOrEqual(geometry.tableHeight - 1);
  expect(geometry.headerTop).toBeGreaterThanOrEqual(0);
  expect(geometry.headerBottom).toBeLessThanOrEqual(geometry.height + 1);
}

export async function expectDocumentFitsViewport(page: Page): Promise<void> {
  const geometry = await page.evaluate(() => ({
    height: document.scrollingElement!.scrollHeight,
    viewportHeight: innerHeight,
    width: document.scrollingElement!.scrollWidth,
    viewportWidth: innerWidth,
  }));
  expect(geometry.height, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.width, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.viewportWidth);
}
