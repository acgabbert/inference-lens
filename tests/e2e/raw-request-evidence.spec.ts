import { expect, test } from "@playwright/test";

import { seedProfile, waitForHydration } from "./support";

/**
 * The workbench already recorded the exact bytes it sent; what it did not do
 * was make them reachable. Comparing this workbench's request against another
 * client's is only conclusive on those bytes, so the panel has to offer them
 * verbatim rather than a re-serialized projection of them.
 */
test("the sent request can be copied for comparison against another client", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);

  await page.getByRole("button", { name: /run request/i }).click();
  await expect(page.locator(".response-pane")).toContainText(
    "Buffered fixture response",
  );

  await page.getByRole("button", { name: "Run details" }).click();
  await page.getByRole("tab", { name: "Events" }).click();
  const evidence = page.locator(".request-evidence").first();
  // The credential never reaches the panel, and the panel says so rather than
  // dropping the header and implying none was sent.
  await expect(evidence).toContainText("authorization");
  await expect(evidence).not.toContainText("Bearer sk-");

  await evidence.getByRole("button", { name: "Copy raw request" }).click();
  await expect(evidence).toContainText("Copied the exact bytes sent.");

  const copied = await page.evaluate(() => navigator.clipboard.readText());
  // The copy is the bytes sent, not the reformatted display, so it can be
  // diffed byte-for-byte against another client's payload.
  expect(copied).toBe(JSON.stringify(JSON.parse(copied)));
  const sent = JSON.parse(copied) as { model: string; stream: boolean };
  expect(sent.model).toBe("buffered-test-model");
  expect(sent.stream).toBe(false);
});
