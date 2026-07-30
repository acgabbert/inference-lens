import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const PROFILE_STORAGE_KEY = "inference-lens:inference-profiles:v1";
const STREAMING_STORAGE_KEY = "inference-lens:streaming-preference:v1";

async function seedBufferedProfile(page: Page) {
  await page.addInitScript(({ profileKey, streamingKey }) => {
    localStorage.setItem(profileKey, JSON.stringify({
      profiles: [{
        id: "buffered",
        name: "Buffered fixture",
        provider: "openai-compatible",
        endpoint: "http://127.0.0.1:44014/v1",
        model: "buffered-test-model",
        temperature: 0.7,
      }],
      activeProfileId: "buffered",
    }));
    localStorage.setItem(streamingKey, "buffered");
  }, { profileKey: PROFILE_STORAGE_KEY, streamingKey: STREAMING_STORAGE_KEY });
}

async function waitForHydration(page: Page) {
  await expect(page.getByLabel("Stream response")).not.toBeChecked();
}

const responsiveWidths = [320, 390, 600, 759, 760, 761, 880, 1080, 1440];

test("renders the buffered fixture transcript and exact token totals", async ({ page }) => {
  await seedBufferedProfile(page);
  await page.goto("/");
  await waitForHydration(page);

  await expect(page.getByRole("button", { name: /run request/i })).toBeEnabled();
  await page.getByRole("button", { name: /run request/i }).click();

  const response = page.locator(".response-pane");
  await expect(response).toContainText("Buffered fixture response: 2 + 2 = 4.");
  await expect(response).toContainText("11 tokens");
  await page.getByRole("tab", { name: "Metrics" }).click();
  const metrics = page.locator(".run-metrics");
  await expect(metrics).toContainText("4 in · 7 out");
  await expect(metrics).toContainText("11");
  await expect(response).not.toContainText(/NaN|Infinity|undefined|null/);
});

test("keeps semantic type, state contrast, and layout intact at supported widths", async ({
  page,
}) => {
  await seedBufferedProfile(page);

  for (const width of responsiveWidths) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await waitForHydration(page);

    const layout = await page.evaluate(() => ({
      bodyWidth: document.body.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    }));
    expect(layout.bodyWidth, `page overflow at ${width}px`).toBeLessThanOrEqual(
      layout.viewportWidth,
    );

    const undersizedText = await page.locator("body").evaluate((body) => {
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      const failures: Array<{ text: string; size: number }> = [];
      let node = walker.nextNode();

      while (node) {
        const text = node.textContent?.trim();
        const element = node.parentElement;
        if (text && element && element.getClientRects().length > 0) {
          const size = Number.parseFloat(getComputedStyle(element).fontSize);
          if (size < 11) failures.push({ text: text.slice(0, 40), size });
        }
        node = walker.nextNode();
      }

      return failures;
    });
    expect(undersizedText, `text below 11px at ${width}px`).toEqual([]);

    const undersizedControls = await page
      .locator("button, label, input:not([type=range]), textarea, select")
      .evaluateAll((controls) =>
        controls
          .filter((control) => control.getClientRects().length > 0)
          .map((control) => ({
            label:
              control.getAttribute("aria-label") ??
              control.textContent?.trim().slice(0, 40) ??
              control.tagName,
            size: Number.parseFloat(getComputedStyle(control).fontSize),
          }))
          .filter(({ size }) => size < 12),
      );
    expect(undersizedControls, `controls below 12px at ${width}px`).toEqual([]);

    const mobileNavigation = page.getByRole("navigation", {
      name: "Workbench view",
    });
    if (width <= 760) {
      await expect(mobileNavigation).toBeVisible();
    } else {
      await expect(mobileNavigation).toBeHidden();
    }
  }

  const projectMenu = page.locator(".project-menu > summary");
  await projectMenu.click();
  const enabledState = await page
    .getByRole("button", { name: /^Save/ })
    .evaluate((button) => {
      const style = getComputedStyle(button);
      return { color: style.color, opacity: style.opacity };
    });
  const disabledState = await page
    .getByRole("button", { name: "Export run trace…" })
    .evaluate((button) => {
      const style = getComputedStyle(button);
      return { color: style.color, opacity: style.opacity };
    });
  expect(disabledState).not.toEqual(enabledState);
});

test("uses peer request and response views on a narrow screen", async ({ page }) => {
  await seedBufferedProfile(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await waitForHydration(page);

  const tabs = page.getByRole("navigation", { name: "Workbench view" });
  await expect(tabs).toBeVisible();
  await expect(page.locator(".request-pane")).toBeVisible();
  await expect(page.locator(".response-pane")).toBeHidden();

  const projectMenu = page.locator(".project-menu > summary");
  await expect(projectMenu).toBeVisible();
  await expect(page.locator(".project-menu-label")).toBeHidden();
  const projectMenuBox = await projectMenu.boundingBox();
  expect(projectMenuBox?.width).toBe(38);
  const overflowGlyph = await projectMenu.evaluate((summary) => {
    const style = getComputedStyle(summary, "::before");
    return {
      color: style.color,
      content: style.content,
      visibility: style.visibility,
    };
  });
  expect(overflowGlyph.content).toBe("\"•••\"");
  expect(overflowGlyph.visibility).toBe("visible");
  expect(overflowGlyph.color).not.toBe("rgba(0, 0, 0, 0)");

  await projectMenu.click();
  const projectPopover = page.locator(".project-popover");
  await expect(projectPopover).toBeVisible();
  const projectPopoverBox = await projectPopover.boundingBox();
  expect(
    projectPopoverBox ? projectPopoverBox.x + projectPopoverBox.width : Infinity,
  ).toBeLessThanOrEqual(390);
  await projectMenu.click();
  await expect(projectPopover).toBeHidden();

  await tabs.getByRole("button", { name: "Response" }).click();
  await expect(page.locator(".response-pane")).toBeVisible();
  await expect(page.locator(".request-pane")).toBeHidden();
});
