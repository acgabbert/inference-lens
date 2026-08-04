import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import {
  createProjectFile,
  createPromptTemplate,
} from "../../packages/core/src/project";
import type { ProjectFile } from "../../packages/core/src/project";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  PROJECT_PROFILE_MAP_STORAGE_KEY,
  importProject,
  openInferenceSettings,
  seedProfile,
  waitForHydration,
  openMode,
} from "./support";

const PROJECT_NAME = "Evaluation execution fixture";
const PROFILE_INSTANCE_ID = "profile-instance-buffered";

/**
 * The buffered fixture rejects a request that carries `temperature` for this
 * model, so a passing run is provider-side proof that the suite's "Provider
 * default" reached the wire — not merely that the UI displayed it.
 */
const PROVIDER_DEFAULT_MODEL = "provider-default-temperature-model";
const PROVIDER_DEFAULT_ANSWER = "Provider received no temperature override.";
/** The fixture answers this model with the temperature it was actually sent. */
const ECHO_TEMPERATURE_MODEL = "echo-temperature-model";

function fixtureProject(): ProjectFile {
  const project = createProjectFile({
    name: PROJECT_NAME,
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Hello" }],
      temperature: 0.4,
    },
    idSuffix: "execution",
    createdAt: "2026-08-01T12:00:00.000Z",
  });
  return createPromptTemplate(project, {
    name: "Question",
    messages: [{ role: "user", content: "Explain {{topic}} to {{audience}}." }],
    variableDefaults: { audience: "engineers" },
    idSuffix: "question",
    createdAt: "2026-08-01T12:00:01.000Z",
  });
}

/**
 * Opens Evaluations with the project's connection already mapped, because
 * these specs are about what the suite owns rather than about the mapping
 * drawer, which `evaluation-suite-authoring.spec.ts` drives directly.
 */
async function openMappedEvaluations(page: Page, project: ProjectFile): Promise<void> {
  await seedProfile(page, { instanceId: PROFILE_INSTANCE_ID });
  await page.addInitScript(
    ({ mapKey, projectId, instanceId }) => {
      localStorage.setItem(
        mapKey,
        JSON.stringify({
          [projectId]: { profileId: "buffered", profileInstanceId: instanceId },
        }),
      );
    },
    {
      mapKey: PROJECT_PROFILE_MAP_STORAGE_KEY,
      projectId: project.projectId,
      instanceId: PROFILE_INSTANCE_ID,
    },
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, project, PROJECT_NAME);
  await openMode(page, "Evaluations");
}

async function useSavedPrompt(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Start from saved prompt…" }).click();
  const dialog = page.getByRole("dialog", { name: "Start from saved prompt" });
  await dialog.getByRole("radio", { name }).check();
  await dialog.getByRole("button", { name: "Start from saved prompt" }).click();
  await expect(page.locator(".evaluation-authoring-notice")).toContainText(
    `Evaluation input now uses “${name}”`,
  );
}

/** Binds `topic` and authors one case that supplies it. */
async function authorSingleCase(page: Page, value: string): Promise<void> {
  await page.getByLabel("Template variable to bind").selectOption({ label: "Question · topic" });
  await page.getByRole("button", { name: "+ Add case input" }).click();
  await page.getByRole("button", { name: "+ Add case", exact: true }).click();
  await page.getByLabel("Untitled case topic").fill(value);
}

test("using a saved prompt moves the evaluation input and leaves Messages alone", async ({ page }) => {
  await openMappedEvaluations(page, fixtureProject());

  await page.getByRole("button", { name: "Create evaluation suite" }).click();
  await useSavedPrompt(page, "Question");

  const editor = page.locator(".evaluation-editor");
  await expect(editor.locator(".evaluation-input-summary")).toContainText("Question · “Explain");

  // The composer is the whole point of the contract: before PR10a this flow
  // rewrote it. Its message must still be the project's own authored one.
  await openMode(page, "Compose");
  await page.getByRole("tab", { name: /Messages/ }).click();
  const firstMessage = page.getByLabel("Message 1 content");
  await expect(firstMessage).toHaveValue("Hello");
  await expect(page.locator(".composer")).not.toContainText("Explain {{topic}}");

  // And returning finds the suite's own input still pinned.
  await openMode(page, "Evaluations");
  await expect(editor.locator(".evaluation-input-summary")).toContainText("Question · “Explain");
});

test("suite execution settings reach the provider without changing Messages settings", async ({ page }) => {
  await openMappedEvaluations(page, fixtureProject());

  await page.getByRole("button", { name: "Create evaluation suite" }).click();
  await useSavedPrompt(page, "Question");
  await authorSingleCase(page, "database migrations");
  await page.getByLabel("New check kind").selectOption({ label: "Contains text" });
  await page.getByRole("button", { name: "+ Add check" }).click();
  const expected = page.locator(".evaluation-editor").getByLabel("Expected text");
  await expected.fill(PROVIDER_DEFAULT_ANSWER);
  await expected.blur();

  // Both settings are moved away from the project's: the model differs, and
  // the temperature is cleared. The fixture answers this model only when no
  // temperature field is present at all.
  const executionSettings = await openInferenceSettings(page, "Evaluation execution settings");
  const model = executionSettings.getByLabel("Model", { exact: true });
  await model.fill(PROVIDER_DEFAULT_MODEL);
  await model.blur();
  // Clearing the override is what removes the field entirely; the slider keeps
  // showing the remembered value but nothing sends it.
  await executionSettings.getByLabel("Override temperature").uncheck();
  await expect(executionSettings.locator(".temperature-control")).toContainText("Provider default");

  const editor = page.locator(".evaluation-editor");
  await expect(editor).toContainText("Ready to run");
  await editor.getByRole("button", { name: "Start evaluation…" }).click();
  const confirmation = page.getByRole("dialog", { name: /Start “Untitled evaluation”/ });
  await expect(confirmation).toContainText(PROVIDER_DEFAULT_MODEL);
  await confirmation.getByRole("button", { name: "Start 1 call" }).click();

  const results = page.locator(".evaluation-results-workspace");
  await expect(results).toContainText("1 / 1 passed");
  await expect(results).not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);
  await results.getByRole("button", { name: "Open Response & Inspect" }).first().click();
  await expect(page.getByLabel("Run transcript")).toContainText(PROVIDER_DEFAULT_ANSWER);

  // Messages kept the project's own model and temperature throughout. Opening a
  // trace moves the evaluation into the request pane, so return before asking
  // the composer anything.
  await page.getByRole("button", { name: "Back to evaluation" }).click();
  await openMode(page, "Compose");
  await page.getByRole("tab", { name: /Messages/ }).click();
  await openInferenceSettings(page);
  await expect(page.locator(".temperature-control output")).toHaveText("0.4");
  await expect(page.locator(".topbar")).toContainText("buffered-test-model");
  await expect(page.locator(".topbar")).not.toContainText(PROVIDER_DEFAULT_MODEL);
});

test("the execution slider sends the temperature it shows, and a favorite fills the model", async ({ page }) => {
  await openMappedEvaluations(page, fixtureProject());

  await page.getByRole("button", { name: "Create evaluation suite" }).click();
  await useSavedPrompt(page, "Question");
  await authorSingleCase(page, "database migrations");

  const executionSettings = await openInferenceSettings(page, "Evaluation execution settings");
  const model = executionSettings.getByLabel("Model", { exact: true });
  await model.fill(ECHO_TEMPERATURE_MODEL);
  // The suite's field offers no catalogue — its connection requirement need not
  // be the active profile — so an unlisted id must stay usable, and the menu
  // must not open over the form with nothing in it.
  await expect(executionSettings.locator(".model-options")).toHaveCount(0);
  await model.blur();

  const temperature = executionSettings.getByRole("slider", { name: "Temperature" });
  await temperature.fill("1.4");
  await expect(executionSettings.locator(".temperature-control output")).toHaveText("1.4");
  await expect(executionSettings.locator(".temperature-warning")).toContainText("Experimental above 1.0");

  const editor = page.locator(".evaluation-editor");
  await page.getByLabel("New check kind").selectOption({ label: "Contains text" });
  await page.getByRole("button", { name: "+ Add check" }).click();
  const expected = editor.getByLabel("Expected text");
  await expected.fill("Provider received temperature 1.4.");
  await expected.blur();

  await expect(editor).toContainText("Ready to run");
  await editor.getByRole("button", { name: "Start evaluation…" }).click();
  await page.getByRole("dialog", { name: /Start “Untitled evaluation”/ })
    .getByRole("button", { name: "Start 1 call" }).click();

  // Provider-side proof: the fixture answers with the temperature it was sent,
  // so this fails if the slider's value never left the suite's settings.
  const results = page.locator(".evaluation-results-workspace");
  await expect(results).toContainText("1 / 1 passed");
  await results.getByRole("button", { name: "Open Response & Inspect" }).first().click();
  await expect(page.getByLabel("Run transcript")).toContainText("Provider received temperature 1.4.");
  await page.getByRole("button", { name: "Back to evaluation" }).click();

  // Favorites are the one list the field can offer honestly: they are ids this
  // device pinned, not a claim about what this target serves.
  await openMode(page, "Compose");
  await page.getByRole("tab", { name: /Messages/ }).click();
  await (await openInferenceSettings(page)).getByLabel("Model", { exact: true }).click();
  await page.getByRole("button", { name: `Favorite ${ECHO_TEMPERATURE_MODEL}` }).click();
  await openMode(page, "Evaluations");
  await openInferenceSettings(page, "Evaluation execution settings");

  await model.fill("echo");
  await executionSettings.getByRole("option", { name: ECHO_TEMPERATURE_MODEL }).click();
  await expect(model).toHaveValue(ECHO_TEMPERATURE_MODEL);
});

test("an empty regex is an accepted draft that preflight blocks until it has a pattern", async ({ page }) => {
  await openMappedEvaluations(page, fixtureProject());

  await page.getByRole("button", { name: "Create evaluation suite" }).click();
  await useSavedPrompt(page, "Question");
  await authorSingleCase(page, "database migrations");

  const editor = page.locator(".evaluation-editor");
  const start = editor.getByRole("button", { name: "Start evaluation…" });
  await page.getByLabel("New check kind").selectOption({ label: "Contains text" });
  await page.getByRole("button", { name: "+ Add check" }).click();
  const expected = editor.getByLabel("Expected text");
  await expected.fill("Buffered fixture");
  await expected.blur();
  await expect(start).toBeEnabled();

  // Adding the check succeeds — an unfinished pattern is authored state, not a
  // rejected edit — and the block lands in preflight rather than at the add.
  await page.getByLabel("New check kind").selectOption({ label: "Regex" });
  await page.getByRole("button", { name: "+ Add check" }).click();
  await expect(editor.locator(".evaluation-check-card")).toHaveCount(2);
  await expect(editor.locator(".evaluation-diagnostics")).toContainText(
    'A regex check on case "Untitled case" needs a pattern.',
  );
  await expect(editor).toContainText("1 setup issue");
  await expect(start).toBeDisabled();

  const pattern = editor.locator(".evaluation-check-card")
    .filter({ hasText: "RE2 syntax" })
    .getByLabel("Pattern");
  await pattern.fill("Buffered fixture");
  await pattern.blur();
  await expect(editor).toContainText("Ready to run");
  await expect(start).toBeEnabled();
});

test("the missing-variable action adds the case input that clears the setup issue", async ({ page }) => {
  await openMappedEvaluations(page, fixtureProject());

  await page.getByRole("button", { name: "Create evaluation suite" }).click();
  await useSavedPrompt(page, "Question");
  // A case with no binding for `topic` cannot resolve the template.
  await page.getByRole("button", { name: "+ Add case", exact: true }).click();

  const editor = page.locator(".evaluation-editor");
  await expect(editor.locator(".evaluation-diagnostics")).toContainText(
    "cannot resolve template variable",
  );
  const action = editor.locator(".evaluation-resolution-action");
  await expect(action).toContainText("Add a case input for");
  await action.getByRole("button", { name: "+ Add case input" }).click();

  // The binding alone does not clear the issue: a case still needs a value,
  // and preflight has to keep saying so until one is supplied.
  await expect(editor.locator(".evaluation-diagnostics")).toContainText("has no value for input");
  await page.getByLabel("Untitled case topic").fill("database migrations");
  const diagnostics = editor.locator(".evaluation-diagnostics");
  await expect(diagnostics).not.toContainText("cannot resolve template variable");
  await expect(diagnostics).not.toContainText("has no value for input");
  await expect(editor.locator(".evaluation-resolution-action")).toHaveCount(0);
  // What remains is the unrelated, still-true issue that the case has no
  // checks — proof the action cleared its own class of error and no other.
  await expect(diagnostics).toContainText("needs at least one deterministic check");
  await expect(editor).toContainText("1 setup issue");
});

test("a run in progress reports running state and ticks the elapsed clock", async ({ page }) => {
  await openMappedEvaluations(page, fixtureProject());

  // The real fixture still serves every response; only their arrival is
  // delayed, so the in-progress window is long enough to observe. Provider
  // calls leave the browser through the app's own inference route, so that is
  // where the delay has to sit.
  //
  // The batch is deliberately several calls long so that repetitions finish
  // underneath the clock: elapsed has to keep counting across that churn, not
  // restart with each progress update.
  await page.route("**/api/inference", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.continue();
  });

  await page.getByRole("button", { name: "Create evaluation suite" }).click();
  await useSavedPrompt(page, "Question");
  await authorSingleCase(page, "database migrations");
  await page.getByLabel("New check kind").selectOption({ label: "Contains text" });
  await page.getByRole("button", { name: "+ Add check" }).click();
  const expected = page.locator(".evaluation-editor").getByLabel("Expected text");
  await expected.fill("Buffered fixture");
  await expected.blur();
  await (await openInferenceSettings(page, "Evaluation execution settings"))
    .getByLabel("Repetitions").fill("6");

  await page.locator(".evaluation-editor").getByRole("button", { name: "Start evaluation…" }).click();
  await page.getByRole("dialog", { name: /Start “Untitled evaluation”/ })
    .getByRole("button", { name: "Start 6 calls" }).click();

  const results = page.locator(".evaluation-results-workspace");
  const summary = results.getByRole("region", { name: "As run summary" });
  await expect(summary).toContainText("In progress");
  // A run still in flight must not be reported as a verdict, and the removed
  // non-control text must not come back.
  await expect(summary).not.toContainText("Did not pass");
  await expect(results).not.toContainText("Open when finished");
  await expect(results).toContainText("Running…");
  await expect(results.locator(".run-history-status.running").first()).toBeVisible();

  // The clock is owned by the elapsed interval, not by result arrival, so it
  // keeps counting across every repetition that finishes under it.
  const header = results.locator(".evaluation-results-header");
  await expect(header).toContainText("0:03 elapsed", { timeout: 10_000 });

  await expect(results).toContainText("1 / 1 passed", { timeout: 15_000 });
  await expect(results).toContainText("6 passed · 0 failed · 0 not evaluated");
  await expect(results).toContainText("66 tokens · 6/6 runs reported");
  await expect(results).not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);
});

/**
 * The panel is one component with three mounts, so its controls must not be
 * restyled by whichever page they land in. The suite's mount sits inside
 * `.evaluation-preflight`, whose own `label`, `input`, and `output` rules match
 * the panel's at equal specificity and used to win on source order: the
 * checkboxes stacked above their text, their hit boxes stretched across the
 * column, and the temperature readout lost its field.
 */
async function settingsLayout(panel: Locator) {
  return panel.evaluate((element) => {
    const checkboxLayout = (selector: string) => {
      const label = element.querySelector<HTMLElement>(selector);
      const input = label?.querySelector<HTMLInputElement>('input[type="checkbox"]');
      const text = label?.querySelector<HTMLElement>("span");
      if (!label || !input || !text) return "missing";
      const box = input.getBoundingClientRect();
      const words = text.getBoundingClientRect();
      // Beside, not above: the glyph sits left of its text and the two overlap
      // vertically. A stretched box is the other half of the same failure.
      const beside = box.right <= words.left && box.bottom > words.top;
      return `${beside ? "beside" : "stacked"}/${box.width < 30 ? "compact" : "stretched"}`;
    };
    const style = (selector: string) => {
      const node = element.querySelector<HTMLElement>(selector);
      return node ? getComputedStyle(node) : null;
    };
    const output = style(".temperature-control output");
    const hint = style(".streaming-control small");
    return {
      temperature: checkboxLayout(".temperature-toggle"),
      streaming: checkboxLayout(".streaming-control"),
      readout: output ? `${output.borderTopWidth}/${output.textAlign}` : "missing",
      hint: hint ? `${hint.fontSize}/${hint.lineHeight}` : "missing",
    };
  });
}

test("the suite's settings panel lays its controls out like the composer's", async ({ page }) => {
  await openMappedEvaluations(page, fixtureProject());
  await page.getByRole("button", { name: "Create evaluation suite" }).click();
  await useSavedPrompt(page, "Question");

  const suite = await settingsLayout(
    await openInferenceSettings(page, "Evaluation execution settings"),
  );
  await openMode(page, "Compose");
  await page.getByRole("tab", { name: /Messages/ }).click();
  const composer = await settingsLayout(await openInferenceSettings(page));

  // The composer is the reference only because it is the mount no page rules
  // reach; both are asserted absolutely so a regression there cannot make this
  // pass by matching two broken layouts.
  expect(composer).toEqual({
    temperature: "beside/compact",
    streaming: "beside/compact",
    readout: "1px/right",
    hint: "11px/14.3px",
  });
  expect(suite).toEqual(composer);
});

test("preflight input and execution settings fit at desktop and phone widths", async ({ page }) => {
  await openMappedEvaluations(page, fixtureProject());
  await page.getByRole("button", { name: "Create evaluation suite" }).click();
  await useSavedPrompt(page, "Question");
  await authorSingleCase(page, "database migrations");
  await page.getByLabel("New check kind").selectOption({ label: "Contains text" });
  await page.getByRole("button", { name: "+ Add check" }).click();
  const expectedText = page.locator(".evaluation-editor").getByLabel("Expected text");
  await expectedText.fill("Buffered fixture");
  await expectedText.blur();
  await expect(page.locator(".evaluation-editor")).toContainText("Ready to run");
  // Expanded on purpose: collapsed, the panel has nothing that could overflow,
  // so measuring it shut would pass without testing the controls at all.
  await openInferenceSettings(page, "Evaluation execution settings");

  // Both regions hold long text — a revision label and an endpoint-shaped model
  // — so overflow is the failure to watch. The settings summary is measured too,
  // because its value chips are the widest single line in the collapsed state.
  const measure = () => page.locator(".evaluation-preflight").evaluate((preflight) => {
    const fits = (selector: string) => {
      const element = preflight.querySelector<HTMLElement>(selector);
      return Boolean(element && element.scrollWidth <= element.clientWidth);
    };
    return {
      preflightFits: preflight.scrollWidth <= preflight.clientWidth,
      summaryFits: fits(".evaluation-input-summary"),
      executionFits: fits(".inference-settings"),
      settingsSummaryFits: fits(".inference-settings-summary"),
      bodyFits: document.body.scrollWidth <= document.documentElement.clientWidth,
    };
  });
  const expected = {
    preflightFits: true,
    summaryFits: true,
    executionFits: true,
    settingsSummaryFits: true,
    bodyFits: true,
  };
  expect(await measure()).toEqual(expected);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".evaluation-editor")).toContainText("Ready to run");
  expect(await measure()).toEqual(expected);
});
