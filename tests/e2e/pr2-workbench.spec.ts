import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { RunCoordinator } from "../../packages/core/src/run-kernel/coordinator";
import { createResolvedRunInput } from "../../packages/core/src/run-kernel/run-execution";
import type {
  ResolvedTemplateUse,
  ToolDefinition,
} from "../../packages/core/src/run-kernel/types";
import { createRunTrace } from "../../packages/core/src/run-kernel/reducer";
import { serializeRunTrace } from "../../packages/core/src/run-trace";

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

function importedTraceContents(
  templateResolutions: ResolvedTemplateUse[] = [],
): string {
  const input = createResolvedRunInput(
    {
      provider: "openai-compatible",
      endpoint: "https://api.example.com/v1",
      model: "imported-model",
      messages: [{
        role: "user",
        content: templateResolutions.length > 0
          ? "Explain atomic branches."
          : "Imported request",
      }],
    },
    {
      conversationId: "conversation_mobile-import",
      conversationRevisionId: "revision_mobile-import",
    },
    [] as ToolDefinition[],
    templateResolutions,
    "mobile-import",
    "2026-07-30T12:00:00.000Z",
  );
  const coordinator = new RunCoordinator(input);
  const { execution } = coordinator.start();
  coordinator.accept({
    type: "text_delta",
    text: "Imported response",
    source: { exchangeId: execution.exchangeId, frameIndex: 0 },
  });
  coordinator.accept({
    type: "completed",
    finishReason: { normalized: "stop" },
    source: { exchangeId: execution.exchangeId, frameIndex: 0 },
  });
  coordinator.finishTurnStream();
  return serializeRunTrace(createRunTrace(coordinator.state));
}

const importedTemplateResolution = {
  templateUseId: "template-use_question",
  templateId: "template_question",
  templateRevisionId: "template-revision_question-2",
  templateName: "Question",
  messages: [{ role: "user", content: "Explain {{topic}}." }],
  variableDefaults: { topic: "branching" },
  values: { topic: "atomic branches" },
  outputMessageIds: ["message_mobile-import-0"],
} satisfies ResolvedTemplateUse;

const responsiveWidths = [320, 390, 600, 759, 760, 761, 880, 1080, 1440];

test("renders the buffered fixture transcript and exact token totals", async ({ page }) => {
  await seedBufferedProfile(page);
  await page.goto("/");
  await waitForHydration(page);

  await expect(page.getByRole("button", { name: /run request/i })).toBeEnabled();
  await page.getByRole("button", { name: /run request/i }).click();

  const response = page.locator(".response-pane");
  await expect(response).toContainText("Buffered fixture response: 2 + 2 = 4.");
  const summary = response.getByLabel("Run summary");
  await expect(page.getByRole("button", { name: "Run details" })).toBeInViewport();
  await expect(summary.getByText("Tokens", { exact: true })).toBeVisible();
  await expect(summary.getByText("11", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Run details" }).click();
  await expect(page.getByRole("tab", { name: "Templates" })).toHaveCount(0);
  await page.getByRole("tab", { name: "Metrics" }).click();
  const metrics = page.locator(".run-metrics");
  await expect(metrics).toContainText("4 in · 7 out");
  await expect(metrics).toContainText("11");
  await expect(response).not.toContainText(/NaN|Infinity|undefined|null/);
});

test("retires previous run details when a repeated experiment starts", async ({ page }) => {
  await seedBufferedProfile(page);
  await page.goto("/");
  await waitForHydration(page);

  await page.getByRole("button", { name: /run request/i }).click();
  await expect(page.locator(".response-pane")).toContainText(
    "Buffered fixture response: 2 + 2 = 4.",
  );
  await page.getByRole("button", { name: "Run details" }).click();
  await expect(page.getByRole("tab", { name: "Metrics" })).toBeVisible();

  await page.getByRole("button", { name: "Repeat…" }).click();
  await page.getByLabel("Repetitions").fill("2");
  await page.getByRole("button", { name: "Start 2 repetitions" }).click();

  await expect(
    page.getByRole("region", { name: "Repeated experiment results" }),
  ).toBeVisible();
  await expect(page.getByRole("tab", { name: "Metrics" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Run details" })).toBeDisabled();
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
      await expect(mobileNavigation.getByRole("button")).toHaveCount(3);
      await mobileNavigation.getByRole("button", { name: "Inspect" }).click();
      await expect(page.locator(".inspect-view")).toBeVisible();
      await expect(page.locator(".response-view")).toBeHidden();
      await mobileNavigation.getByRole("button", { name: "Request" }).click();
      await expect(page.locator(".request-pane")).toBeVisible();
    } else {
      await expect(mobileNavigation).toBeHidden();
      await expect(page.locator(".request-pane")).toBeVisible();
      await expect(page.locator(".response-pane")).toBeVisible();
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
  await projectMenu.click();
  await page.locator(".run-data-menu > summary").click();
  const disabledState = await page
    .getByRole("button", { name: "Export run trace…" })
    .evaluate((button) => {
      const style = getComputedStyle(button);
      return { color: style.color, opacity: style.opacity };
    });
  expect(disabledState).not.toEqual(enabledState);
});

test("uses peer request, response, and inspect views on a narrow screen", async ({ page }) => {
  await seedBufferedProfile(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await waitForHydration(page);

  const tabs = page.getByRole("navigation", { name: "Workbench view" });
  await expect(tabs).toBeVisible();
  await expect(page.locator(".request-pane")).toBeVisible();
  await expect(page.locator(".response-pane")).toBeHidden();
  await expect(tabs.getByRole("button")).toHaveCount(3);

  const projectMenu = page.locator(".project-menu > summary");
  await expect(projectMenu).toBeVisible();
  await expect(page.locator(".project-menu-label")).toBeHidden();
  const runDataMenu = page.locator(".run-data-menu > summary");
  await expect(runDataMenu).toBeVisible();
  await expect(page.locator(".run-data-menu-label")).toBeHidden();
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
  const projectPopover = page.locator(".project-menu .project-popover");
  await expect(projectPopover).toBeVisible();
  await expect(projectPopover.getByText("Project", { exact: true })).toBeVisible();
  await expect(projectPopover).not.toContainText("Run history");
  await expect(projectPopover).not.toContainText("Local tool library");
  await expect(projectPopover).not.toContainText("Import prompt from n8n");
  const projectPopoverBox = await projectPopover.boundingBox();
  expect(
    projectPopoverBox ? projectPopoverBox.x + projectPopoverBox.width : Infinity,
  ).toBeLessThanOrEqual(390);
  await projectMenu.click();
  await expect(projectPopover).toBeHidden();
  await runDataMenu.click();
  const runDataPopover = page.locator(".run-data-popover");
  await expect(runDataPopover.getByText("Run data", { exact: true })).toBeVisible();
  await expect(runDataPopover).toContainText("Run history");
  await expect(runDataPopover).toContainText("Import run trace");
  await expect(runDataPopover).toContainText("Export run trace");
  await expect(runDataPopover).toContainText("Download diagnostics");
  await runDataMenu.click();

  await tabs.getByRole("button", { name: "Response" }).click();
  await expect(page.locator(".response-pane")).toBeVisible();
  await expect(page.locator(".request-pane")).toBeHidden();
  await expect(page.locator(".response-view")).toBeVisible();
  await expect(page.locator(".inspect-view")).toBeHidden();

  await page.getByRole("button", { name: /run request/i }).click();
  await expect(page.locator(".response-pane")).toContainText(
    "Buffered fixture response: 2 + 2 = 4.",
  );
  await expect(tabs.getByRole("button", { name: "Response" })).toHaveClass(
    /active/,
  );

  await tabs.getByRole("button", { name: "Inspect" }).click();
  await expect(page.locator(".response-view")).toBeHidden();
  await expect(page.locator(".inspect-view")).toBeVisible();
  await expect(page.locator(".inspect-view")).toContainText("Completed");
  await expect(page.locator(".inspect-view")).not.toContainText(
    /NaN|Infinity|undefined/,
  );

  await page.getByRole("button", { name: "Run details" }).click();
  await page.getByRole("tab", { name: "Metrics" }).click();
  await expect(page.getByRole("tabpanel", { name: "Metrics" })).toBeVisible();

  await tabs.getByRole("button", { name: "Response" }).click();
  await expect(page.locator(".response-view")).toBeVisible();
  await expect(page.locator(".response-view .trace-panel")).toHaveCount(0);

  await tabs.getByRole("button", { name: "Inspect" }).click();
  await expect(page.getByRole("tab", { name: "Metrics" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("groups lifecycle and run-data actions by owner", async ({ page }) => {
  await seedBufferedProfile(page);
  await page.setViewportSize({ width: 1080, height: 900 });
  await page.goto("/");
  await waitForHydration(page);

  await page.getByRole("tab", { name: "Prompt library" }).click();
  await expect(
    page.getByRole("button", { name: "Import from n8n…" }),
  ).toBeVisible();

  await page.getByRole("tab", { name: "Tools" }).click();
  await expect(
    page.getByRole("button", { name: "Browse local library" }),
  ).toBeVisible();

  await page.getByLabel("Project menu").click();
  const projectMenu = page.locator(".project-menu .project-popover");
  await expect(projectMenu).toContainText("Project");
  await expect(projectMenu).toContainText("Import project");
  await expect(projectMenu).toContainText("Export project");
  await expect(projectMenu).not.toContainText("Run history");
  await expect(projectMenu).not.toContainText("Download diagnostics");

  await page.getByLabel("Project menu").click();
  await page.getByLabel("Run data menu").click();
  const runDataMenu = page.locator(".run-data-popover");
  await expect(runDataMenu).toContainText("Run data");
  await expect(runDataMenu).toContainText("Run history");
  await expect(runDataMenu).toContainText("Import run trace");
  await expect(runDataMenu).toContainText("Export run trace");
  await expect(runDataMenu).toContainText("Download diagnostics");
  await expect(runDataMenu).not.toContainText("Import project");
});

test("selects Inspect when a trace is explicitly imported", async ({ page }) => {
  await seedBufferedProfile(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await waitForHydration(page);

  await page.locator(".run-data-menu > summary").click();
  await page.getByLabel("Import run trace…").setInputFiles({
    name: "run_mobile-import.json",
    mimeType: "application/json",
    buffer: Buffer.from(importedTraceContents()),
  });

  const tabs = page.getByRole("navigation", { name: "Workbench view" });
  await expect(tabs.getByRole("button", { name: "Inspect" })).toHaveClass(
    /active/,
  );
  await expect(page.locator(".inspect-view")).toContainText("Completed");
  await expect(page.locator(".inspect-view")).toContainText("Run details");
  await expect(page.getByRole("tab", { name: "Templates" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /^Events/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator(".response-view")).toBeHidden();
});

test("shows Templates only with captured evidence and restores its selection", async ({
  page,
}) => {
  await seedBufferedProfile(page);
  await page.goto("/");
  await waitForHydration(page);

  const importTrace = async (name: string, contents: string) => {
    await page.locator(".run-data-menu > summary").click();
    await page.getByLabel("Import run trace…").setInputFiles({
      name,
      mimeType: "application/json",
      buffer: Buffer.from(contents),
    });
  };

  await importTrace(
    "run_with-template-evidence.json",
    importedTraceContents([importedTemplateResolution]),
  );
  const templatesTab = page.getByRole("tab", { name: "Templates 1" });
  await expect(templatesTab).toBeVisible();
  await templatesTab.click();
  await expect(page.getByRole("tabpanel", { name: "Templates 1" })).toContainText(
    "Question",
  );

  await importTrace("run_without-template-evidence.json", importedTraceContents());
  await expect(page.getByRole("tab", { name: /Templates/ })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: /^Events/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("tabpanel", { name: /^Events/ })).toBeVisible();

  await importTrace(
    "run_with-template-evidence-again.json",
    importedTraceContents([importedTemplateResolution]),
  );
  await expect(templatesTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "Templates 1" })).toContainText(
    "atomic branches",
  );
  await expect(page.locator(".inspect-view")).not.toContainText(
    /NaN|Infinity|undefined/,
  );
});
