/**
 * Every spec's `test`: Playwright's own, plus a layout audit after each test.
 *
 * A pane stops scrolling in states no layout spec is aimed at — after a run,
 * after pinning a prompt, in a short window — so the check runs wherever the
 * suite already goes rather than at moments someone remembered to choose. It
 * runs at the test's own viewport, then in a short desktop window and on a
 * phone, where starved scrollers show up first.
 *
 * Opt out per file or describe block with `test.use({ layoutAudit: false })`,
 * or pass `{ ignore: [selector] }` for a deliberate clip.
 *
 * `test.use({ personalWorkbench: true })` points a spec at the second app
 * server, which runs with the shared assets 2b gate on (playwright.config.ts).
 */
import { test as base } from "@playwright/test";

import { expectLayoutFits, type LayoutAuditOptions } from "./layout";

export * from "@playwright/test";

const auditViewports = [
  { width: 1280, height: 560 },
  { width: 390, height: 844 },
];

/** The gated app server (`personalWorkbenchAppPort` in playwright.config.ts). */
export const PERSONAL_WORKBENCH_ORIGIN = "http://127.0.0.1:4301";

export const test = base.extend<{
  layoutAudit: false | LayoutAuditOptions;
  personalWorkbench: boolean;
  auditLayout: void;
}>({
  layoutAudit: [{}, { option: true }],
  personalWorkbench: [false, { option: true }],
  baseURL: async ({ baseURL, personalWorkbench }, provide) => {
    await provide(personalWorkbench ? PERSONAL_WORKBENCH_ORIGIN : baseURL);
  },
  auditLayout: [
    async ({ context, layoutAudit, baseURL }, use, testInfo) => {
      await use();
      if (layoutAudit === false || testInfo.status !== "passed") return;
      const pages = context.pages().filter((page) => !page.isClosed() && baseURL && page.url().startsWith(baseURL));
      for (const page of pages) {
        await base.step(`layout fits: ${new URL(page.url()).pathname}`, async () => {
          const original = page.viewportSize();
          for (const viewport of [...(original ? [original] : []), ...auditViewports]) {
            await page.setViewportSize(viewport);
            await expectLayoutFits(page, layoutAudit);
          }
        });
      }
    },
    { auto: true },
  ],
});
