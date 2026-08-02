import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  createProjectFile,
  serializeProjectFile,
} from "../../packages/core/src/project";

const PROFILE_STORAGE_KEY = "inference-lens:inference-profiles:v1";
const PROFILE_ENDPOINT = "http://127.0.0.1:44014/v1";

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
      endpoint: PROFILE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Hello" }],
      temperature: 0.4,
    },
    idSuffix: "model-picker",
    createdAt: "2026-07-30T12:00:00.000Z",
  });
}

async function seedProfile(page: Page) {
  await page.addInitScript(
    ({ profileKey, endpoint }) => {
      localStorage.setItem(
        profileKey,
        JSON.stringify({
          profiles: [
            {
              id: "buffered",
              name: "Buffered fixture",
              provider: "openai-compatible",
              endpoint,
              model: "buffered-test-model",
              temperature: 0.7,
              favoriteModels: ["buffered-test-model"],
            },
          ],
          activeProfileId: "buffered",
        }),
      );
    },
    { profileKey: PROFILE_STORAGE_KEY, endpoint: PROFILE_ENDPOINT },
  );
}

async function openFixtureProject(page: Page) {
  const project = fixtureProject();
  await page.goto("/");
  // Wait for hydration before driving the menu: `setInputFiles` dispatches a
  // change event, and if React has not attached its handler yet the import is
  // silently dropped and the app stays on "No project open".
  await expect(page.locator(".topbar")).toContainText("Buffered fixture");
  await page.getByLabel("Project menu").click();
  await page.setInputFiles(
    '.project-popover:not(.run-data-popover) input[type="file"]',
    {
      name: "model-picker.project.json",
      mimeType: "application/json",
      buffer: Buffer.from(serializeProjectFile(project)),
    },
  );
  // `Run target:` renders with or without a project, so waiting on it passes
  // vacuously when the import silently fails. Wait for the project itself:
  // without one open, `defaults.target.model` does not exist and the crash
  // under test is unreachable.
  await expect(page.locator("main")).toContainText("Model picker fixture");
  await expect(page.locator("main")).not.toContainText("No project open");
  // The Project menu is a `<details>` that stays open and overlays the request
  // pane; Escape does not close one. Set the state directly, per the recipe in
  // docs/PROVIDER_FIXTURES.md, or it swallows clicks meant for the model field.
  await page.evaluate(() => {
    document
      .querySelectorAll<HTMLDetailsElement>("details.project-menu")
      .forEach((menu) => {
        menu.open = false;
      });
  });
}

test("clearing the model field in an open project does not throw", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await seedProfile(page);
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

  await seedProfile(page);
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

  await seedProfile(page);
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
