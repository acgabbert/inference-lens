import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  addEvaluationCase,
  addEvaluationCheck,
  addEvaluationInput,
  createEvaluationSuite,
  evaluationBindingCandidates,
  updateEvaluationCase,
  updateEvaluationCheck,
} from "../../packages/core/src/evaluation-suite-authoring";
import {
  createProjectFile,
  createPromptTemplate,
  insertPromptTemplateUse,
  serializeProjectFile,
} from "../../packages/core/src/project";
import type { ProjectFile } from "../../packages/core/src/project";
import { INFERENCE_API_PATH } from "../../packages/contracts/src/inference";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  PROJECT_PROFILE_MAP_STORAGE_KEY,
  openMode,
  primaryAction,
  seedProfile,
  stubProjectDirectory,
  waitForHydration,
} from "./support";

const PROJECT_NAME = "Evaluation reassessment fixture";
const PROFILE_INSTANCE_ID = "profile-instance-buffered";

/**
 * One case whose only check is the acceptance scenario's wrong regex.
 *
 * The buffered fixture answers with text containing "Buffered fixture", so an
 * uppercase pattern with no flags is a check that can never match what the
 * provider actually said — a check that is wrong about the criteria rather than
 * a run that went wrong. That distinction is the whole point of reassessing:
 * the evidence is fine, the question was not.
 */
function wrongRegexProject(): ProjectFile {
  let project = createProjectFile({
    name: PROJECT_NAME,
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Hello" }],
      temperature: 0.4,
    },
    idSuffix: "reassessment",
    createdAt: "2026-08-07T12:00:00.000Z",
  });
  project = createPromptTemplate(project, {
    name: "Question",
    messages: [{ role: "user", content: "Explain {{topic}} to engineers." }],
    idSuffix: "question",
    createdAt: "2026-08-07T12:00:01.000Z",
  });
  project = insertPromptTemplateUse(project, {
    conversationRevisionId: project.defaults.conversationRevisionId,
    templateId: "template_question",
    itemIndex: 1,
    idSuffix: "question-use",
  });

  const candidates = evaluationBindingCandidates(
    project,
    project.defaults.conversationRevisionId,
  );
  const created = createEvaluationSuite(project, "Topics", () => "topics");
  project = created.project;
  const input = addEvaluationInput(project, created.suiteId, candidates[0]!, () => "topic");
  project = input.project;
  const added = addEvaluationCase(project, created.suiteId, () => "migrations");
  project = updateEvaluationCase(added.project, created.suiteId, added.caseId, {
    name: "migrations",
    values: { [input.inputId]: "database migrations" },
  });
  project = addEvaluationCheck(
    project,
    created.suiteId,
    added.caseId,
    { kind: "regex", pattern: "placeholder" },
    () => "answered",
  );
  // Written as a whole definition rather than through the add default, because
  // the default is now case-insensitive and this fixture needs the flag absent.
  project = updateEvaluationCheck(project, created.suiteId, added.caseId, {
    checkId: "check_answered",
    kind: "regex",
    syntax: "re2",
    label: "Answered by the fixture",
    pattern: "BUFFERED FIXTURE",
  });
  return project;
}

async function openDurableProject(page: Page, project: ProjectFile): Promise<void> {
  await seedProfile(page, {
    endpoint: BUFFERED_FIXTURE_ENDPOINT,
    instanceId: PROFILE_INSTANCE_ID,
  });
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
  await page.setViewportSize({ width: 1440, height: 1000 });
  await stubProjectDirectory(page, {
    name: "evaluation-reassessment-fixture",
    files: { "project.json": serializeProjectFile(project) },
    directories: ["traces", "experiments"],
  });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project…" }).click();
  await expect(page.locator(".brand")).toContainText(PROJECT_NAME);
  await page.locator(".project-menu").evaluate((element) => element.removeAttribute("open"));
  await openMode(page, "Evaluations");
}

/**
 * Adopting is the other half of the acceptance scenario, and it is deliberately
 * a second decision: saving an interpretation of history says nothing about
 * what the next run should assert, so this asserts the authored suite changes
 * only when the author says so, and separately from the save.
 */
test("updating the authored suite is a separate action from saving the interpretation", async ({ page }) => {
  await openDurableProject(page, wrongRegexProject());

  await expect(page.locator(".evaluation-editor")).toContainText("Ready to run");
  await primaryAction(page, "evaluations").click();
  await page.getByRole("dialog", { name: /Start “Topics”/ })
    .getByRole("button", { name: /^Start 1 call/ })
    .click();
  const results = page.locator(".evaluation-results-workspace");
  await expect(results).toContainText("0 / 1 passed");

  await results.getByRole("button", { name: "Re-evaluate saved outputs…" }).click();
  const drawer = page.getByRole("dialog", { name: "Re-evaluate saved outputs" });
  await drawer.getByLabel("Ignore case").check();
  await drawer.getByRole("button", { name: /^Update 1 authored case$/ }).click();
  await expect(results).toContainText("Updated 1 case in the authored suite");

  // The correction reached project.json, which is what the next run will read.
  await drawer.getByRole("button", { name: /^Close/ }).click();
  await openMode(page, "Evaluations");
  const check = page.locator(".evaluation-check-card").first();
  await expect(check.getByLabel("Pattern")).toHaveValue("BUFFERED FIXTURE");
  await expect(check.getByLabel("Flags")).toHaveValue("i");
});

test("a wrong regex is corrected over saved outputs without another provider call", async ({ page }) => {
  // `/api/inference` is the only route to a provider — the browser never talks
  // to the fixture directly — so counting it counts every provider call the app
  // could possibly make, not just the ones a fixture chose to record.
  let providerRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === INFERENCE_API_PATH) providerRequests += 1;
  });

  await openDurableProject(page, wrongRegexProject());

  await expect(page.locator(".evaluation-editor")).toContainText("Ready to run");
  await primaryAction(page, "evaluations").click();
  await page.getByRole("dialog", { name: /Start “Topics”/ })
    .getByRole("button", { name: /^Start 1 call/ })
    .click();

  const results = page.locator(".evaluation-results-workspace");
  await expect(results).toContainText("0 / 1 passed");
  await expect(results).toContainText("did not pass");
  await expect(results).not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);

  // Everything after this line must be pure re-derivation over saved outputs.
  const afterRun = providerRequests;
  expect(afterRun).toBeGreaterThan(0);

  await results.getByRole("button", { name: "Re-evaluate saved outputs…" }).click();
  const drawer = page.getByRole("dialog", { name: "Re-evaluate saved outputs" });
  await expect(drawer).toContainText("No provider call is made");
  await expect(drawer.getByRole("textbox").first()).toHaveValue("BUFFERED FIXTURE");

  await drawer.getByLabel("Ignore case").check();
  const preview = drawer.getByRole("region", { name: "What would change" });
  await expect(preview).toContainText("failed → passed");
  await expect(preview).toContainText("did not pass → passed");
  await expect(preview).not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);

  await drawer.getByLabel("Name").fill("Corrected regex");
  await drawer.getByRole("button", { name: "Save reassessment" }).click();

  // The saved interpretation is what is being read, and the surface says so.
  await expect(results).toContainText("1 / 1 passed");
  await expect(results).toContainText("Saved reinterpretation");
  await expect(results).toContainText("not the criteria this evaluation ran with");

  // The original verdict is intact, not overwritten: re-selecting As run
  // reproduces exactly what the batch reported when it finished.
  await results.getByLabel("Reading").selectOption({ label: "As run" });
  await expect(results).toContainText("0 / 1 passed");
  await expect(results).not.toContainText("Saved reinterpretation");

  // Reopened from the project folder, the saved reassessment is still there and
  // still defaults to As run.
  await page.getByLabel("Run data menu").click();
  await page.getByRole("button", { name: "Run history…" }).click();
  await page.locator(".run-history-item.experiment")
    .filter({ hasText: "Evaluation · Topics" })
    .first()
    .click();
  await expect(results).toContainText("0 / 1 passed");
  await results.getByLabel("Reading").selectOption({ label: "Corrected regex" });
  await expect(results).toContainText("1 / 1 passed");
  await expect(results).not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);

  expect(providerRequests).toBe(afterRun);
});
