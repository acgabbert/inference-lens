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

/** One place the layout stops a reader from reaching content. */
export interface LayoutProblem {
  kind: "clipped" | "starved" | "document";
  element: string;
  clientHeight: number;
  scrollHeight: number;
  top?: number;
  bottom?: number;
}

export interface LayoutAuditOptions {
  /** Selectors for elements whose clipping or small scroller is deliberate. */
  ignore?: readonly string[];
}

/**
 * Every place on the page where content is out of reach.
 *
 * - `clipped`: an `overflow-y: hidden | clip` box hiding more than a line of its
 *   content, which nothing can scroll to.
 * - `starved`: a scroller that overflows but was left too short to read
 *   (`toBeVisible()` passes on a 0px scroller, so this measures geometry).
 * - `document`: the shell itself scrolls, which the workbench never should.
 *
 * Form fields, code, single-line truncation, line clamps and visually-hidden
 * text clip on purpose and are skipped. So is any box that already runs past
 * the viewport: its scrolling parent is what reaches it, and that parent is
 * checked in its own right.
 */
export async function collectLayoutProblems(
  page: Page,
  { ignore = [] }: LayoutAuditOptions = {},
): Promise<LayoutProblem[]> {
  return page.evaluate((ignored) => {
    const clipTolerance = 12;
    const minimumScrollerHeight = 90;
    const skippedTags = new Set(["INPUT", "TEXTAREA", "SELECT", "PRE", "CODE", "svg", "OPTION"]);
    const problems: LayoutProblem[] = [];
    const describe = (element: Element): string => {
      const path: string[] = [];
      for (let node: Element | null = element; node && node !== document.body && path.length < 4; node = node.parentElement) {
        const classes = [...node.classList].slice(0, 3).map((name) => `.${name}`).join("");
        const label = node.getAttribute("aria-label");
        path.unshift(`${node.tagName.toLowerCase()}${classes}${label ? `[aria-label="${label}"]` : ""}`);
      }
      return path.join(" > ");
    };
    for (const element of document.body.querySelectorAll<HTMLElement>("*")) {
      if (skippedTags.has(element.tagName) || element.closest("pre, svg")) continue;
      if (!element.checkVisibility({ visibilityProperty: true })) continue;
      if (ignored.some((selector) => element.closest(selector))) continue;
      const style = getComputedStyle(element);
      const { clientHeight, scrollHeight } = element;
      if (clientHeight <= 1 || element.clientWidth <= 1) continue;
      const box = element.getBoundingClientRect();
      if (box.top < -1 || box.bottom > innerHeight + 1) continue;
      const overflow = style.overflowY;
      const geometry = { element: describe(element), clientHeight, scrollHeight, top: Math.round(box.top), bottom: Math.round(box.bottom) };
      if (overflow === "hidden" || overflow === "clip") {
        if (style.textOverflow === "ellipsis" || style.whiteSpace === "nowrap") continue;
        if (style.webkitLineClamp !== "none") continue;
        if (scrollHeight - clientHeight > clipTolerance) problems.push({ kind: "clipped", ...geometry });
      } else if (overflow === "auto" || overflow === "scroll") {
        if (scrollHeight > clientHeight + 1 && clientHeight < minimumScrollerHeight) {
          problems.push({ kind: "starved", ...geometry });
        }
      }
    }
    const root = document.scrollingElement!;
    if (root.scrollHeight > innerHeight || root.scrollWidth > innerWidth) {
      problems.push({ kind: "document", element: "document", clientHeight: innerHeight, scrollHeight: root.scrollHeight });
    }
    return problems;
  }, [...ignore]);
}

/**
 * The page lets a reader reach all of its content. Retried briefly, because a
 * pane mid-transition is not a layout bug; the failure lists the geometry.
 */
export async function expectLayoutFits(page: Page, options: LayoutAuditOptions = {}): Promise<void> {
  await expect(async () => {
    const problems = await collectLayoutProblems(page, options);
    expect(problems, `layout at ${JSON.stringify(page.viewportSize())}:\n${JSON.stringify(problems, null, 2)}`).toEqual([]);
  }).toPass({ timeout: 2_000 });
}
