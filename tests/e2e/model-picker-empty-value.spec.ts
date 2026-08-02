import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { createProjectFile } from "../../packages/core/src/project";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  importProject,
  seedProfile,
  waitForHydration,
} from "./support";

/**
 * An open project is the condition that makes an empty model fatal: a project's
 * `defaults.target.model` is `z.string().trim().min(1)`, so committing a blank
 * field reaches `updateProjectDraft` and throws `ProjectValidationError`.
 * Without a project the same edit only touches the active profile, so this
 * regression is unreachable unless a project is loaded first.
 */
function fixtureProject() {
  return createProjectFile({
    name: "Model picker fixture",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Hello" }],
      temperature: 0.4,
    },
    idSuffix: "model-picker",
    createdAt: "2026-07-30T12:00:00.000Z",
  });
}

async function openFixtureProject(page: Page) {
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, fixtureProject(), "Model picker fixture");
}

test("clearing the model field in an open project does not throw", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await seedProfile(page, { favoriteModels: ["buffered-test-model"] });
  await openFixtureProject(page);

  const model = page.locator('input[data-readiness-control="model"]');
  await model.click();
  await model.fill("");
  // The field itself must accept being empty — clearing to retype is ordinary.
  await expect(model).toHaveValue("");

  // Blur is what the user reported as fatal.
  await page.locator("body").click();

  expect(pageErrors).toEqual([]);
  // There is no "no model" a project can hold, so the model still in effect
  // comes back rather than the app entering an unrepresentable state.
  await expect(model).toHaveValue("buffered-test-model");
  await expect(page.locator("body")).not.toContainText(
    "Invalid Inference Lens project",
  );
  await expect(page.locator("body")).not.toContainText("ProjectValidationError");
});

test("typing a replacement model after clearing commits the new id", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await seedProfile(page, { favoriteModels: ["buffered-test-model"] });
  await openFixtureProject(page);

  const model = page.locator('input[data-readiness-control="model"]');
  await model.click();
  await model.fill("");
  await model.fill("replacement-model");
  await page.locator("body").click();

  expect(pageErrors).toEqual([]);
  await expect(model).toHaveValue("replacement-model");
});

test("a favorite stays selectable when the catalogue cannot be listed", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await seedProfile(page, { favoriteModels: ["buffered-test-model"] });
  // Fail discovery outright: a favorite is a stored id, so it must survive a
  // provider whose optional catalogue endpoint is unreachable. Discovery goes
  // through the app's own `/api/models` proxy (MODELS_API_PATH), not to the
  // provider URL from the browser, so that is the route to intercept.
  await page.route("**/api/models", (route) => route.abort());
  await openFixtureProject(page);

  const model = page.locator('input[data-readiness-control="model"]');
  // Click somewhere neutral first. Importing a project leaves focus in a state
  // where the next click on the field does not produce a `focus` event, and the
  // menu only opens on focus — so a bare click here silently opens nothing.
  await page.locator("body").click();
  await model.click();
  await expect(model).toHaveAttribute("aria-expanded", "true");

  const listbox = page.locator('[role="listbox"]');
  await expect(listbox).toContainText("Favorites");
  await expect(
    listbox.getByRole("option", { name: "buffered-test-model" }),
  ).toBeVisible();

  expect(pageErrors).toEqual([]);
});
