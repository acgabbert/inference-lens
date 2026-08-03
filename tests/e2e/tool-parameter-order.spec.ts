import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { seedProfile, waitForHydration } from "./support";

/**
 * A tool's parameter order is sent to the provider verbatim, so it is authored
 * data rather than presentation. These specs check the order the request pane
 * shows against the request the workbench actually built, because the two can
 * disagree: canonicalizing serialization once sorted schema properties
 * alphabetically behind the editor's back.
 */
async function addToolWithParameters(
  page: Page,
  parameters: readonly string[],
): Promise<void> {
  await page.getByRole("tab", { name: "Tools" }).click();
  await page
    .locator(".tools-tab-toolbar")
    .getByRole("button", { name: "+ Add project tool" })
    .click();

  for (const [index, name] of parameters.entries()) {
    await page.getByRole("button", { name: "+ Add parameter" }).first().click();
    await page
      .locator(".tool-editor")
      .first()
      .locator(".schema-property")
      .nth(index)
      .getByLabel("Name")
      .fill(name);
  }
}

/** The exact body the workbench handed to the HTTP client for this run. */
async function sentRequestBody(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Run details" }).click();
  await page.getByRole("tab", { name: "Events" }).click();
  const evidence = page.locator(".request-evidence").first();
  await expect(evidence).toBeVisible();
  return (await evidence.locator(".request-evidence-body").textContent()) ?? "";
}

test("parameters reach the provider in the authored order, not alphabetically", async ({
  page,
}) => {
  await seedProfile(page, { capabilityOverrides: { tools: true } });
  await page.goto("/");
  await waitForHydration(page);

  // Authored in reverse alphabetical order, so sorted output is distinguishable
  // from authored output rather than coincidentally identical.
  await addToolWithParameters(page, ["zulu", "alpha"]);
  await page.getByLabel("Function name").first().fill("ordered_tool");

  await page.getByRole("button", { name: /run request/i }).click();
  await expect(page.locator(".response-pane")).toContainText(
    "Buffered fixture response",
  );

  const body = await sentRequestBody(page);
  expect(body).toContain('"ordered_tool"');
  expect(body.indexOf('"zulu"')).toBeGreaterThan(-1);
  expect(body.indexOf('"zulu"')).toBeLessThan(body.indexOf('"alpha"'));
});

test("moving a parameter up changes the order sent to the provider", async ({
  page,
}) => {
  await seedProfile(page, { capabilityOverrides: { tools: true } });
  await page.goto("/");
  await waitForHydration(page);

  await addToolWithParameters(page, ["first_param", "second_param"]);
  await page.getByRole("button", { name: "Move second_param up" }).click();

  // The editor is the first evidence: the fields must have moved with the row.
  const names = page.locator(".tool-editor .schema-property input").first();
  await expect(names).toHaveValue("second_param");

  await page.getByRole("button", { name: /run request/i }).click();
  await expect(page.locator(".response-pane")).toContainText(
    "Buffered fixture response",
  );

  const body = await sentRequestBody(page);
  expect(body.indexOf('"second_param"')).toBeLessThan(
    body.indexOf('"first_param"'),
  );
});

test("moving a tool down changes its position in the tools array sent", async ({
  page,
}) => {
  await seedProfile(page, { capabilityOverrides: { tools: true } });
  await page.goto("/");
  await waitForHydration(page);

  await page.getByRole("tab", { name: "Tools" }).click();
  const addTool = page
    .locator(".tools-tab-toolbar")
    .getByRole("button", { name: "+ Add project tool" });
  await addTool.click();
  await page.locator(".tool-editor").nth(0).getByLabel("Function name").fill("tool_early");
  await addTool.click();
  await page.locator(".tool-editor").nth(1).getByLabel("Function name").fill("tool_late");

  await page.getByRole("button", { name: "Move tool_early later in the request" }).click();
  await expect(
    page.locator(".tool-editor").nth(0).getByLabel("Function name"),
  ).toHaveValue("tool_late");

  await page.getByRole("button", { name: /run request/i }).click();
  await expect(page.locator(".response-pane")).toContainText(
    "Buffered fixture response",
  );

  const body = await sentRequestBody(page);
  expect(body.indexOf('"tool_late"')).toBeLessThan(body.indexOf('"tool_early"'));
});
