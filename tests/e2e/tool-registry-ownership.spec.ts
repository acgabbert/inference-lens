import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import type { ToolRegistryV1 } from "../../packages/core/src/tool-registry";
import { seedProfile, waitForHydration } from "./support";

const TOOL_REGISTRY_STORAGE_KEY = "inference-lens:tool-registry:v1";

const seededRegistry: ToolRegistryV1 = {
  schemaVersion: 1,
  tools: [
    {
      id: "registry-tool_seeded",
      name: "lookup_order",
      description: "Find an order by its number.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      createdAt: "2026-10-08T12:00:00.000Z",
      updatedAt: "2026-10-08T12:00:00.000Z",
    },
  ],
};

function storedToolNames(page: Page) {
  return page.evaluate((key) => {
    const stored = JSON.parse(localStorage.getItem(key) ?? "null") as
      | ToolRegistryV1
      | null;
    return stored?.tools.map(({ name }) => name);
  }, TOOL_REGISTRY_STORAGE_KEY);
}

async function openLibrary(page: Page) {
  await page.getByRole("tab", { name: "Tools" }).click();
  await page.getByRole("button", { name: "Browse local library" }).click();
  return page.getByRole("dialog", { name: "Local tool library" });
}

/**
 * The library is device-local: it is read once after hydration and every
 * change is written back. The write must wait for that read, or the empty
 * registry the page starts with would replace the stored one on load.
 */
test("the local tool library loads what is stored and writes edits back across a reload", async ({
  page,
}) => {
  await seedProfile(page);
  // Seed once: an init script runs on every navigation, and the reload below
  // has to read what the app wrote, not this fixture again. Seeding after
  // hydration lets the first load's own read and write settle first.
  await page.goto("/");
  await waitForHydration(page);
  await page.evaluate(
    ([key, registry]) => localStorage.setItem(key, registry),
    [TOOL_REGISTRY_STORAGE_KEY, JSON.stringify(seededRegistry)],
  );
  await page.reload();
  await waitForHydration(page);

  const library = await openLibrary(page);
  await expect(library.locator(".registry-list")).toContainText("lookup_order");
  expect(await storedToolNames(page)).toEqual(["lookup_order"]);

  await library.getByRole("button", { name: "+ New library tool" }).click();
  await library.getByLabel("Function name").fill("cancel_order");
  await library.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => storedToolNames(page)).toEqual([
    "lookup_order",
    "cancel_order",
  ]);

  await page.reload();
  await waitForHydration(page);
  const reopened = await openLibrary(page);
  await expect(reopened.locator(".registry-list")).toContainText("lookup_order");
  await expect(reopened.locator(".registry-list")).toContainText("cancel_order");
});
