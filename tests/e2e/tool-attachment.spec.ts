import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { openAttachToolMenu, seedProfile, waitForHydration } from "./support";
import { expectModalContract } from "./support/modal";

/**
 * Every route a tool takes into a request starts from one "Attach tool" menu
 * on the attached list, and every route asks the same question — this tab or
 * the project — with the same default. The list is then the only place a tool
 * is attached, detached, or reordered; the project cards below only edit.
 *
 * "This tab" is the default because attaching to the project changes a saved
 * project default that every run in the project picks up.
 */

async function openTools(page: Page) {
  await seedProfile(page, { capabilityOverrides: { tools: true } });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByRole("tab", { name: "Tools" }).click();
  return page.getByRole("region", { name: "Tools attached to this request" });
}

/** Model-visible names in the order the attached list shows them. */
function attachedNames(page: Page) {
  return page
    .getByRole("region", { name: "Tools attached to this request" })
    .locator(".tool-manifest-name code")
    .allTextContents();
}

/** The exact body the workbench handed to the HTTP client for this run. */
async function sentRequestBody(page: Page): Promise<string> {
  await page.getByRole("button", { name: /run current conversation/i }).click();
  await expect(page.locator(".response-pane")).toContainText("Buffered fixture response");
  await page.getByRole("button", { name: "Run details" }).click();
  await page.getByRole("tab", { name: "Events" }).click();
  const evidence = page.locator(".request-evidence").first();
  await expect(evidence).toBeVisible();
  return (await evidence.locator(".request-evidence-body").textContent()) ?? "";
}

test("one Attach tool menu replaces the separate add buttons and defaults to this tab", async ({ page }) => {
  const manifest = await openTools(page);
  await expect(page.getByRole("button", { name: "+ Add project tool" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "+ Add tool", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Browse local library" })).toHaveCount(0);

  const menu = await openAttachToolMenu(page);
  await expect(menu.getByRole("radio", { name: "This tab only" })).toBeChecked();
  await expect(menu.getByRole("button", { name: "From local library…" })).toBeVisible();
  await expect(menu.getByRole("button", { name: "From MCP server…" })).toBeVisible();
  await menu.getByRole("button", { name: "New definition" }).click();

  // A new tab tool is edited where it is listed, and is not a project tool.
  const row = manifest.getByRole("listitem");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("This tab");
  await expect(page.getByText("Project tools · 0", { exact: true })).toBeVisible();
  await row.getByLabel("Function name").fill("lookup_order");
  expect(await attachedNames(page)).toEqual(["lookup_order"]);

  expect(await sentRequestBody(page)).toContain('"lookup_order"');
});

test("a project tool detached from the list stays in the project and is re-attached from the menu", async ({ page }) => {
  const manifest = await openTools(page);
  let menu = await openAttachToolMenu(page);
  await menu.getByRole("radio", { name: "Project" }).check();
  await menu.getByRole("button", { name: "New definition" }).click();

  await expect(manifest.getByRole("listitem")).toContainText("Project");
  await expect(page.getByText("Project tools · 1", { exact: true })).toBeVisible();
  const card = page.locator(".tool-list > .tool-editor").first();
  // The card edits; attaching is the list's job.
  await expect(card.getByRole("checkbox", { name: "Attach to requests" })).toHaveCount(0);
  await expect(card).toContainText("Attached");

  await manifest.getByRole("button", { name: "Detach tool_1" }).click();
  await expect(manifest.getByRole("listitem")).toHaveCount(0);
  await expect(card).toContainText("Not attached");

  // A project attach is a deliberate choice each time, never a leftover one.
  menu = await openAttachToolMenu(page);
  await expect(menu.getByRole("radio", { name: "This tab only" })).toBeChecked();
  await menu.getByRole("button", { name: "Attach tool_1" }).click();
  expect(await attachedNames(page)).toEqual(["tool_1"]);
});

test("reordering in the attached list skips detached project tools and changes the request sent", async ({ page }) => {
  const manifest = await openTools(page);
  for (const name of ["alpha", "bravo", "charlie"]) {
    const menu = await openAttachToolMenu(page);
    await menu.getByRole("radio", { name: "Project" }).check();
    await menu.getByRole("button", { name: "New definition" }).click();
    await page.locator(".tool-list > .tool-editor").last().getByLabel("Function name").fill(name);
  }
  await manifest.getByRole("button", { name: "Detach bravo" }).click();
  expect(await attachedNames(page)).toEqual(["alpha", "charlie"]);

  // Against the full project array this would only swap alpha past the
  // detached bravo, and the list — and the request — would not change.
  await manifest.getByRole("button", { name: "Move alpha later in the request" }).click();
  expect(await attachedNames(page)).toEqual(["charlie", "alpha"]);

  const body = await sentRequestBody(page);
  expect(body.indexOf('"charlie"')).toBeLessThan(body.indexOf('"alpha"'));
  expect(body).not.toContain('"bravo"');
});

test("the local library attaches to the destination chosen in the menu", async ({ page }) => {
  const manifest = await openTools(page);
  const menu = await openAttachToolMenu(page);
  await menu.getByRole("radio", { name: "Project" }).check();
  await menu.getByRole("button", { name: "From local library…" }).click();

  const dialog = page.getByRole("dialog", { name: "Local tool library" });
  await dialog.getByRole("button", { name: "+ New library tool" }).click();
  await dialog.getByLabel("Function name", { exact: true }).fill("lookup_account");
  await expect(dialog.getByRole("radio", { name: "Project" })).toBeChecked();
  await dialog.getByRole("button", { name: "Attach", exact: true }).click();
  await expect(dialog).toContainText("Attached to the project");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();

  await expect(manifest.getByRole("listitem")).toContainText("lookup_account");
  await expect(manifest.getByRole("listitem")).toContainText("Project");
});

test("an MCP tool whose name a detached project tool holds reads as in use, not attached", async ({ page }) => {
  const manifest = await openTools(page);
  let menu = await openAttachToolMenu(page);
  await menu.getByRole("radio", { name: "Project" }).check();
  await menu.getByRole("button", { name: "New definition" }).click();
  await page.locator(".tool-list > .tool-editor").first().getByLabel("Function name").fill("lookup_record");
  await manifest.getByRole("button", { name: "Detach lookup_record" }).click();

  menu = await openAttachToolMenu(page);
  await menu.getByRole("button", { name: "From MCP server…" }).click();
  const panel = page.getByRole("region", { name: "MCP servers" });
  await panel.getByRole("button", { name: "Connect and browse tools" }).click();
  const tool = panel.getByRole("article").filter({ hasText: "Look up a record" });
  await expect(tool).toContainText("Name in use");
  await expect(tool).not.toContainText("Already attached");
});

test("the local library and the delete confirmation over it follow the modal contract", async ({ page }) => {
  await openTools(page);
  await openAttachToolMenu(page);
  const library = page.getByRole("dialog", { name: "Local tool library" });
  await expectModalContract(page, {
    open: page.getByRole("group", { name: "Attach a tool" }).getByRole("button", { name: "From local library…" }),
    dialog: library,
    restoreTo: page.getByRole("button", { name: "Attach tool", exact: true }),
  });

  await openAttachToolMenu(page);
  await page.getByRole("button", { name: "From local library…" }).click();
  await library.getByRole("button", { name: "+ New library tool" }).click();
  await library.getByLabel("Function name", { exact: true }).fill("lookup_account");
  await library.getByRole("button", { name: "Save", exact: true }).click();
  await expectModalContract(page, {
    open: library.getByRole("button", { name: "Delete", exact: true }),
    dialog: page.getByRole("dialog", { name: 'Delete "lookup_account"?' }),
    remainsOpen: library,
  });
});
