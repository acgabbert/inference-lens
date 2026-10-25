import { expect, test } from "@playwright/test";

import {
  BUFFERED_FIXTURE_ENDPOINT,
  openInferenceSettings,
  seedProfile,
  waitForHydration,
} from "./support";

/**
 * A base URL pasted without its `/v1` reaches a real server that answers 404,
 * as a person reading the failed run sees it.
 *
 * The 404 is the buffered fixture's own: it serves only
 * `/v1/chat/completions`, so the unversioned endpoint dials `/chat/completions`
 * and is refused the way a hosted provider would refuse it.
 */
test("a 404 from an unversioned base URL suggests adding /v1", async ({ page }) => {
  const unversioned = BUFFERED_FIXTURE_ENDPOINT.replace(/\/v1$/, "");
  await seedProfile(page, { endpoint: unversioned });
  await page.goto("/");
  await waitForHydration(page);

  const outgoing = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/inference",
  );
  await page.getByRole("button", { name: /run current conversation/i }).click();
  const sent = (await outgoing).request().postDataJSON() as {
    execution: { input: { target: { endpoint: string } } };
  };
  expect(sent.execution.input.target.endpoint, "the run used the unversioned endpoint")
    .toBe(unversioned);

  // A failed run shows the transcript that was sent, then why it failed.
  const failure = page.locator(".response-pane").getByRole("alert");
  await expect(failure).toContainText("Request failed");
  await expect(failure).toContainText(`${unversioned} has no version segment`);
  await expect(failure).toContainText(`try ${BUFFERED_FIXTURE_ENDPOINT}.`);
  // The fixture's own refusal is still shown, so the hint adds rather than replaces.
  await expect(failure).toContainText("Not found.");
  expect(await failure.innerText()).not.toMatch(/NaN|Infinity|undefined|\[object Object\]/);
});

/**
 * Listing models is usually the first request a new connection makes, so the
 * same missing `/v1` should be named there, before any run is sent. The
 * fixture lists models only at `/v1/models`.
 */
test("a model listing refused at an unversioned base URL suggests adding /v1", async ({ page }) => {
  const unversioned = BUFFERED_FIXTURE_ENDPOINT.replace(/\/v1$/, "");
  await seedProfile(page, { endpoint: unversioned, model: "" });
  await page.goto("/");
  await waitForHydration(page);

  const listing = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/models",
  );
  const settings = await openInferenceSettings(page);
  await settings.locator('[data-readiness-control="model"]').click();
  expect((await listing).status(), "the fixture really refused the listing").toBe(404);

  const failure = page.locator(".model-options-error");
  await expect(failure).toContainText(`${unversioned} has no version segment`);
  await expect(failure).toContainText(`try ${BUFFERED_FIXTURE_ENDPOINT}.`);
  await expect(failure).toContainText("Not found.");
});
