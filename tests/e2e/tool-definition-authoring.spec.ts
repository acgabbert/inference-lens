import { expect, test } from "@playwright/test";

import { addProjectTool, openMcpServers, seedProfile, waitForHydration } from "./support";

/**
 * A tool's description is the main lever on tool-selection quality and is
 * routinely a multi-line brief, so the field has to accept newlines and keep
 * them. The function name is the opposite: providers document
 * `^[a-zA-Z0-9_-]{1,64}$`, so the editor has to say so before the request is
 * built rather than letting the provider reject it.
 */
async function openToolEditor(page: import("@playwright/test").Page) {
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  await page.getByRole("tab", { name: "Tools" }).click();
  await addProjectTool(page);
}

test("a tool description keeps the newlines typed into it", async ({ page }) => {
  await openToolEditor(page);

  const description = page.getByLabel("Description").first();
  await expect(description).toHaveJSProperty("tagName", "TEXTAREA");

  const brief = [
    "Look up the current weather for one city.",
    "",
    "Use when the user names a place and asks about conditions.",
    "Do not use for forecasts more than 24 hours out.",
  ].join("\n");
  await description.fill(brief);

  await expect(description).toHaveValue(brief);
  // The manifest above the editor reads the same draft the request is built
  // from, so this is the value that would be serialized.
  await expect(page.locator(".tool-manifest-list")).toContainText(
    "Look up the current weather for one city.",
  );
});

test("a function name with a space is called out in the editor", async ({ page }) => {
  await openToolEditor(page);

  const name = page.getByLabel("Function name").first();
  await name.fill("get weather");

  const warning = page.getByRole("alert").filter({ hasText: "no spaces" });
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("1–64 letters, digits, underscores, or dashes");
  await expect(name).toHaveAttribute("aria-invalid", "true");

  await name.fill("get_weather");
  await expect(warning).toBeHidden();
  await expect(name).not.toHaveAttribute("aria-invalid", "true");
});

test("clearing a function name keeps the editor open", async ({ page }) => {
  await openToolEditor(page);

  const name = page.getByLabel("Function name").first();
  await name.fill("get_weather");
  // Cmd+Delete on macOS empties the field in one input event; so does any
  // other way of erasing the last character.
  await name.fill("");

  await expect(name).toHaveValue("");
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator(".tool-manifest-list")).toContainText("Unnamed tool");
  await expect(
    page.getByRole("heading", { name: "Inference Lens needs to reload" }),
  ).toHaveCount(0);
});

for (const width of [1440, 1000]) {
  test(`parameter fields share one baseline at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await openToolEditor(page);
    await page.getByRole("button", { name: "+ Add parameter" }).click();

    // Name, Type, and Required sit in the first line at every width; a select
    // or checkbox box shorter than the inputs drops its label below theirs.
    const row = page.locator(".schema-property-row").first();
    const labels = row.locator(":scope > label");
    await expect(labels.first()).toContainText("Name");
    const tops = await Promise.all(
      [0, 1, 2].map(async (index) =>
        Math.round((await labels.nth(index).boundingBox())!.y),
      ),
    );
    expect(new Set(tops).size, `label tops ${tops.join(", ")}`).toBe(1);

    // The MCP panel follows the tool list, so it takes the same gutter.
    const toolLeft = (await page.locator(".tool-list > .tool-editor").first().boundingBox())!.x;
    const mcpLeft = (await (await openMcpServers(page)).boundingBox())!.x;
    expect(mcpLeft).toBe(toolLeft);
  });
}
