import { expect, test } from "@playwright/test";
import { createProjectFile } from "../../packages/core/src/project";

import {
  BUFFERED_FIXTURE_ENDPOINT,
  importProject,
  openInferenceSettings,
  openMode,
  seedProfile,
  waitForHydration,
} from "./support";

/** The buffered fixture answers this model with the temperature it was sent. */
const ECHO_TEMPERATURE_MODEL = "echo-temperature-model";

test("project setting overrides are marked and revert one field at a time", async ({
  page,
}) => {
  await seedProfile(page, { model: "profile-model", temperature: 0.3 });
  await page.goto("/");
  await waitForHydration(page);
  const project = createProjectFile({
    name: "Settings inheritance fixture",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "project-model",
      temperature: 0.8,
      messages: [{ role: "user", content: "Compare inherited settings." }],
    },
    idSuffix: "settings-inheritance",
    createdAt: "2026-08-05T12:00:00.000Z",
  });
  await importProject(page, project, "Settings inheritance fixture");

  const collapsedPanel = page.locator('[aria-label="Run settings"]');
  await expect(collapsedPanel.locator(".inference-settings-fact").filter({ hasText: "2 overrides" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Delivery preference" })).toContainText(
    "Session preference",
  );

  const panel = await openInferenceSettings(page);
  await expect(panel.locator(".inference-settings-scope")).toHaveText(
    "Project settings",
  );
  await expect(panel.getByRole("button", { name: "Revert model to profile defaults" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Revert temperature to profile defaults" })).toBeVisible();
  await expect(panel.getByLabel("Stream response")).toHaveCount(0);

  await panel.getByRole("button", { name: "Revert model to profile defaults" }).click();
  await expect(panel.getByLabel("Model", { exact: true })).toHaveValue("profile-model");
  await expect(panel.getByRole("button", { name: "Revert model to profile defaults" })).toHaveCount(0);
  await expect(panel.locator(".temperature-control output")).toHaveText("0.8");

  await panel.getByRole("button", { name: "Revert temperature to profile defaults" }).click();
  await expect(panel.locator(".temperature-control output")).toHaveText("0.3");
  await expect(panel.locator(".inference-settings-override")).toHaveCount(0);
});

test("the collapsed panel reports what the run will send, and expanding reveals the controls", async ({
  page,
}) => {
  await seedProfile(page, { temperature: 0.3 });
  await page.goto("/");
  await waitForHydration(page);

  const panel = page.locator('[aria-label="Run settings"]');
  const toggle = panel.locator(".inference-settings-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  // The model outlives the disclosure: it stays a live field in the summary
  // row, not a chip that collapsing could take away.
  await expect(panel.getByLabel("Model", { exact: true })).toHaveValue(
    "buffered-test-model",
  );
  // Every other value is named while collapsed. These are exact so a
  // formatting regression cannot hide behind a substring match.
  await expect(panel.locator(".inference-settings-fact")).toHaveText([
    "Temp 0.3",
  ]);
  await expect(page.getByRole("region", { name: "Delivery preference" })).toContainText("Buffered");
  // Collapsed means project controls are absent, not merely hidden. Delivery
  // remains independently reachable because it is session-scoped.
  await expect(page.locator(".temperature-control")).toHaveCount(0);
  await expect(page.getByLabel("Stream response")).toBeVisible();

  await openInferenceSettings(page);
  // The global `label:not(.file-button)` rule outranks a bare class selector,
  // so these labels must win specificity or their checkboxes stack above the
  // text instead of sitting beside it.
  await expect(panel.locator(".temperature-toggle")).toHaveCSS("display", "flex");
  await expect(page.getByRole("region", { name: "Delivery preference" }).locator(".streaming-control")).toHaveCSS("display", "flex");
  await expect(page.getByLabel("Stream response")).not.toBeChecked();
  await expect(panel.getByLabel("Model", { exact: true })).toHaveValue(
    "buffered-test-model",
  );
  await expect(panel.locator(".temperature-control output")).toHaveText("0.3");

  // An edit made while expanded is what the summary reports after collapsing.
  await panel.getByRole("slider", { name: "Temperature" }).fill("0.9");
  await toggle.click();
  await expect(panel.locator(".inference-settings-fact")).toHaveText([
    "Temp 0.9",
  ]);

  // And the collapsed panel is not a stale snapshot: the run honours it.
  await page.getByRole("button", { name: /run request/i }).click();
  await expect(page.locator(".response-pane")).toContainText(
    "Buffered fixture response: 2 + 2 = 4.",
  );
  await expect(page.locator(".response-pane")).not.toContainText(
    /NaN|Infinity|undefined/,
  );
});

test("the tool line stays readable while the panel is collapsed", async ({ page }) => {
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);

  // The tool line is a consequence of the settings rather than one of them, so
  // collapsing the panel must not take it with them.
  await expect(page.locator(".request-tool-line")).toContainText(
    "No tools attached to this request.",
  );
  await expect(
    page.locator('[aria-label="Run settings"] .inference-settings-toggle'),
  ).toHaveAttribute("aria-expanded", "false");
});

test("a repeated experiment freezes the settings its dialog was given, then reports them as a record", async ({
  page,
}) => {
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);

  await page.getByRole("button", { name: "Repeat…" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Run this frozen request repeatedly",
  });
  // Expanded here, unlike the composer: deciding these values is why the dialog
  // is open.
  const settings = dialog.locator('[aria-label="Repeated experiment settings"]');
  await expect(settings.locator(".inference-settings-toggle")).toHaveAttribute(
    "aria-expanded",
    "true",
  );

  // Located by role, not by label: focusing the field opens the profile's
  // catalogue inside the same <label>, which changes its accessible name and
  // makes an exact getByLabel stop resolving mid-test.
  const model = settings.getByRole("combobox", { name: /model/i });
  await model.fill(ECHO_TEMPERATURE_MODEL);
  await model.blur();
  await settings.getByLabel("Override temperature").check();
  await settings.getByRole("slider", { name: "Temperature" }).fill("1.3");
  await expect(settings.locator(".temperature-control output")).toHaveText("1.3");
  await dialog.getByLabel("Repetitions").fill("2");
  await expect(dialog).toContainText("Minimum provider calls: 2");

  await dialog.getByRole("button", { name: "Start 2 repetitions" }).click();

  const results = page.getByRole("region", {
    name: "Repeated experiment results",
  });
  await expect(results).toBeVisible();
  // The progress element only renders while the experiment is live, so its
  // absence is what proves every repetition has its final content.
  await expect(page.getByLabel("Experiment progress")).toHaveCount(0);

  // Provider-side proof: the fixture answers with the temperature it actually
  // received, so this fails if the dialog's edits never reached the plan.
  await expect(results).toContainText("Provider received temperature 1.3.");
  await expect(results).not.toContainText(/NaN|Infinity|undefined/);

  // The same panel, now a record of what was frozen — and no control that would
  // invite editing calls the provider has already answered.
  const record = await openInferenceSettings(page, "Repeated experiment settings");
  await expect(record).toContainText(ECHO_TEMPERATURE_MODEL);
  await expect(record).toContainText("1.3");
  await expect(record).toContainText("2 reps");
  await expect(record.locator(".temperature-control")).toHaveCount(0);
  await expect(record.getByLabel("Stream response")).toHaveCount(0);

  // And the composer's own settings were never rewritten by the experiment.
  // Results are read in the Runs mode now, so reaching the composer's own
  // separately labelled panel means going back to Compose for it.
  await openMode(page, "Compose");
  const composer = await openInferenceSettings(page);
  await expect(composer.getByLabel("Model", { exact: true })).toHaveValue(
    "buffered-test-model",
  );
  await expect(composer.locator(".temperature-control")).toContainText(
    "Provider default",
  );
});
