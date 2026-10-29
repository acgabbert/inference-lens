import { expect, test } from "./support/test";
import { openMode, openToolLibrary, seedProfile, waitForHydration } from "./support";
import { expectDocumentFitsViewport } from "./support/layout";

for (const size of [
  { width: 1280, height: 720 },
  { width: 1280, height: 560 },
  { width: 390, height: 844 },
]) {
  test(`tool library keeps its workspace reachable with a validation error at ${size.width}×${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    await seedProfile(page);
    await page.goto("/");
    await waitForHydration(page);
    await openMode(page, "Compose");
    await page.getByRole("tab", { name: /Tools/ }).click();
    const dialog = await openToolLibrary(page);
    // Enough definitions to require the sidebar's own scroll viewport too.
    for (let index = 0; index < 18; index += 1) {
      await dialog.getByRole("button", { name: "+ New library tool" }).click();
    }
    await dialog.getByLabel("Description", { exact: true }).fill("A reusable tool with a long description. ".repeat(20));
    await dialog.getByLabel("Function name", { exact: true }).fill("");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog.locator(".registry-error")).toHaveText("Function name is required.");

    const geometry = await dialog.evaluate((modal) => {
      const workspace = modal.querySelector<HTMLElement>(".registry-workspace")!;
      const box = modal.getBoundingClientRect();
      return {
        modalHeight: modal.clientHeight,
        contentHeight: modal.scrollHeight,
        workspaceBottom: workspace.getBoundingClientRect().bottom - box.top,
      };
    });
    expect(geometry.contentHeight, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.modalHeight);
    expect(geometry.workspaceBottom).toBeLessThanOrEqual(geometry.modalHeight + 1);
    for (const selector of [".registry-sidebar", ".registry-editor"]) {
      const pane = dialog.locator(selector);
      const scrolled = await pane.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
        return { bottom: element.scrollTop + element.clientHeight, content: element.scrollHeight };
      });
      expect(scrolled.bottom).toBe(scrolled.content);
    }
    await expectDocumentFitsViewport(page);
  });
}
