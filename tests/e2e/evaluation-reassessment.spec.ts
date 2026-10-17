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
  await page.getByRole("button", { name: "Open project folder…" }).click();
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
  await page.getByRole("button", { name: "Run history", exact: true }).click();
  await page.locator(".runs-evidence-item.experiment")
    .filter({ hasText: "Evaluation · Topics" })
    .first()
    .click();
  await expect(results).toContainText("0 / 1 passed");
  await results.getByLabel("Reading").selectOption({ label: "Corrected regex" });
  await expect(results).toContainText("1 / 1 passed");
  await expect(results).not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);

  expect(providerRequests).toBe(afterRun);
});

test("structured checks correct saved criteria with validated drafts and preserve As run", async ({ page }) => {
  let providerRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === INFERENCE_API_PATH) providerRequests += 1;
  });
  let project = wrongRegexProject();
  project = {
    ...project,
    evaluationSuites: project.evaluationSuites.map((suite) => ({
      ...suite,
      execution: {
        ...suite.execution,
        target: { ...suite.execution.target, model: "structured-output-model" },
      },
    })),
  };
  const suite = project.evaluationSuites[0]!;
  const caseId = suite.cases[0]!.id;
  project = updateEvaluationCheck(project, suite.id, caseId, {
    checkId: "check_answered", kind: "json-schema", dialect: "draft-07",
    label: "Answer shape", schema: { type: "object", required: ["wrong"] },
  });
  project = addEvaluationCheck(project, suite.id, caseId, { kind: "valid-json" }, () => "json");
  project = addEvaluationCheck(project, suite.id, caseId, { kind: "max-output-characters" }, () => "length");
  await openDurableProject(page, project);
  await primaryAction(page, "evaluations").click();
  await page.getByRole("dialog", { name: /Start “Topics”/ }).getByRole("button", { name: /^Start 1 call/ }).click();
  const results = page.locator(".evaluation-results-workspace");
  await expect(results).toContainText("0 / 1 passed");
  const afterRun = providerRequests;
  expect(afterRun).toBeGreaterThan(0);
  const strictDiagnostics = results.getByRole("group", { name: "Structured check diagnostics" }).first();
  await strictDiagnostics.getByText("Structured check diagnostics", { exact: true }).click();
  await expect(strictDiagnostics).toContainText("Input policy: strict");
  await expect(strictDiagnostics).toContainText("Diagnostic code: invalid-json");
  await expect(strictDiagnostics).not.toContainText("Extraction:");
  await strictDiagnostics.getByText("Structured check diagnostics", { exact: true }).click();
  await results.getByRole("button", { name: "Re-evaluate saved outputs…" }).click();
  const drawer = page.getByRole("dialog", { name: "Re-evaluate saved outputs" });
  await expect(drawer.getByLabel("Schema draft", { exact: true })).toHaveCount(1);
  await expect(drawer.getByRole("region", { name: "Checks carried through unchanged" })).toContainText("max-output-characters");
  await expect(drawer.getByRole("region", { name: "Checks carried through unchanged" })).not.toContainText("json-schema");
  const schema = drawer.getByRole("region", { name: "migrations · Answer shape", exact: true });
  const preview = drawer.getByRole("region", { name: "What would change" });
  await schema.getByLabel("Schema draft", { exact: true }).fill('{"pattern":"unsupported"}');
  await schema.getByRole("button", { name: "Save structured check" }).click();
  await expect(schema.getByRole("alert")).toContainText("Pattern constraints are unsupported");
  await expect(preview).toContainText("Nothing.");
  await schema.getByRole("button", { name: "Cancel draft" }).click();
  await schema.getByText("Generate from a JSON example", { exact: true }).click();
  await schema.getByLabel("JSON example", { exact: true }).fill('{"answer":2}');
  await schema.getByRole("button", { name: "Generate schema" }).click();
  await schema.getByLabel("JSON input policy").selectOption("surrounding-fence");
  await expect(preview).toContainText("Nothing.");
  await schema.getByRole("button", { name: "Save structured check" }).click();
  await expect(preview).toContainText("1 check outcome,");
  const json = drawer.getByRole("region", { name: "Structured check editor" }).last();
  await json.getByLabel("JSON input policy").selectOption("surrounding-fence");
  await json.getByRole("button", { name: "Save structured check" }).click();
  await expect(preview).toContainText("2 check outcomes,");
  await expect(preview).toContainText("did not pass → passed");
  await drawer.getByLabel("Name", { exact: true }).fill("Structured correction");
  await drawer.getByRole("button", { name: "Save reassessment" }).click();
  await expect(results).toContainText("1 / 1 passed");
  const diagnostics = results.getByRole("group", { name: "Structured check diagnostics" });
  await expect(diagnostics).toHaveCount(2);
  await diagnostics.first().getByText("Structured check diagnostics", { exact: true }).click();
  await expect(diagnostics.first()).toContainText("Input policy: surrounding-fence");
  await expect(diagnostics.first()).toContainText("Extraction: surrounding-fence");
  await results.getByLabel("Reading").selectOption({ label: "As run" });
  await expect(results).toContainText("0 / 1 passed");
  await page.getByLabel("Run data menu").click();
  await page.getByRole("button", { name: "Run history", exact: true }).click();
  await page.locator(".runs-evidence-item.experiment").filter({ hasText: "Evaluation · Topics" }).first().click();
  await results.getByLabel("Reading").selectOption({ label: "Structured correction" });
  await expect(results).toContainText("1 / 1 passed");
  await results.getByRole("button", { name: "Re-evaluate saved outputs…" }).click();
  await drawer.getByRole("button", { name: /^Update 1 authored case$/ }).click();
  await expect(results).toContainText("Updated 1 case in the authored suite");
  await drawer.getByLabel("Schema draft", { exact: true }).fill("false");
  await drawer.getByRole("button", { name: /^Close/ }).click();
  await results.getByRole("button", { name: "Re-evaluate saved outputs…" }).click();
  expect(JSON.parse(await drawer.getByLabel("Schema draft", { exact: true }).inputValue()).required).toEqual(["answer"]);
  await drawer.getByRole("button", { name: /^Close/ }).click();
  await openMode(page, "Evaluations");
  const card = page.locator(".evaluation-check-card").first();
  const committed = JSON.parse(await card.getByLabel("Schema draft", { exact: true }).inputValue());
  expect(committed.required).toEqual(["answer"]);
  await expect(card.getByLabel("JSON input policy")).toHaveValue("surrounding-fence");
  expect(providerRequests).toBe(afterRun);
});

test("structured results disclose bounded issues and unchecked formats without copying answers", async ({ page }) => {
  let project = wrongRegexProject();
  project.evaluationSuites[0].execution.target.model = "structured-output-model";
  const suite = project.evaluationSuites[0];
  const caseId = suite.cases[0].id;
  project = updateEvaluationCheck(project, suite.id, caseId, {
    checkId: "check_answered", kind: "json-schema", dialect: "draft-07", inputPolicy: "surrounding-fence",
    label: "Answer diagnostics", schema: {
      type: "object", required: ["missing"], properties: { answer: { type: "string", format: "date-time" } },
    },
  });
  project = addEvaluationCheck(project, suite.id, caseId, { kind: "json-schema" }, () => "extras");
  project = updateEvaluationCheck(project, suite.id, caseId, {
    checkId: "check_extras", kind: "json-schema", dialect: "draft-07", inputPolicy: "surrounding-fence",
    label: "Redacted extras", schema: { type: "object", additionalProperties: false },
  });
  project = addEvaluationCheck(project, suite.id, caseId, { kind: "json-schema" }, () => "bounded");
  project = updateEvaluationCheck(project, suite.id, caseId, {
    checkId: "check_bounded", kind: "json-schema", dialect: "draft-07", inputPolicy: "surrounding-fence",
    label: "Bounded issues", schema: { allOf: Array.from({ length: 25 }, () => false) },
  });
  await openDurableProject(page, project);
  await primaryAction(page, "evaluations").click();
  await page.getByRole("dialog", { name: /Start “Topics”/ }).getByRole("button", { name: /^Start 1 call/ }).click();
  const results = page.locator(".evaluation-results-workspace");
  await expect(results).toContainText("0 / 1 passed");
  const row = results.locator(".evaluation-check-results > li").filter({ hasText: "Answer diagnostics" });
  await expect(row.getByRole("group", { name: "Structured check diagnostics" })).toHaveCount(1);
  await row.getByText("Structured check diagnostics", { exact: true }).click();
  await expect(row).toContainText("Issues listed: 2");
  await expect(row).toContainText('missing required property "missing"');
  await expect(row).toContainText("expected string");
  const firstIssue = row.getByRole("list").first().getByRole("listitem").first();
  await expect(firstIssue).toHaveText('Schema mismatch at the root: missing required property "missing".');
  await expect(row.getByRole("list").first().getByRole("listitem").nth(1))
    .toHaveText('Schema mismatch at ["answer"]: expected string.');
  await expect(row).toContainText("/properties/answer/format: date-time (not checked)");
  await expect(row).not.toContainText('{"answer":2}');
  const extras = results.locator(".evaluation-check-results > li").filter({ hasText: "Redacted extras" });
  await extras.getByText("Structured check diagnostics", { exact: true }).click();
  await expect(extras.getByRole("group")).toContainText("<additional property>");
  await expect(extras.getByRole("group")).not.toContainText("answer");
  const bounded = results.locator(".evaluation-check-results > li").filter({ hasText: "Bounded issues" });
  await bounded.getByText("Structured check diagnostics", { exact: true }).click();
  await expect(bounded).toContainText("Issues listed: 20");
  await expect(bounded.getByRole("group")).toContainText("More issues may exist than are listed.");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(row.getByRole("group")).toBeVisible();
  const width = await page.evaluate(() => ({ content: document.body.scrollWidth, viewport: document.documentElement.clientWidth }));
  expect(width.content).toBeLessThanOrEqual(width.viewport);
});

test("oversized structured output shows the original UTF-16 size and limit", async ({ page }) => {
  let project = wrongRegexProject();
  project.evaluationSuites[0].execution.target.model = "oversized-json-model";
  const suite = project.evaluationSuites[0];
  project = updateEvaluationCheck(project, suite.id, suite.cases[0].id, {
    checkId: "check_answered", kind: "json-schema", dialect: "draft-07", schema: true,
  });
  await openDurableProject(page, project);
  await primaryAction(page, "evaluations").click();
  await page.getByRole("dialog", { name: /Start “Topics”/ }).getByRole("button", { name: /^Start 1 call/ }).click();
  const results = page.locator(".evaluation-results-workspace");
  await expect(results).toContainText("0 / 1 passed");
  const diagnostics = results.getByRole("group", { name: "Structured check diagnostics" });
  await diagnostics.getByText("Structured check diagnostics", { exact: true }).click();
  await expect(diagnostics).toContainText("Diagnostic code: output-too-large");
  await expect(diagnostics).toContainText("Original output UTF-16 code units: 150002 · Limit: 150000");
  await expect(diagnostics).not.toContainText("😀");
});

test("ordinary JSON passes omit disclosures while unchecked formats stay visible", async ({ page }) => {
  let project = wrongRegexProject();
  project.evaluationSuites[0].execution.target.model = "raw-json-model";
  const suite = project.evaluationSuites[0];
  const caseId = suite.cases[0].id;
  project = updateEvaluationCheck(project, suite.id, caseId, {
    checkId: "check_answered", kind: "json-schema", dialect: "draft-07", label: "Ordinary schema", schema: true,
  });
  project = addEvaluationCheck(project, suite.id, caseId, { kind: "valid-json" }, () => "json");
  project = addEvaluationCheck(project, suite.id, caseId, { kind: "json-schema" }, () => "format");
  project = updateEvaluationCheck(project, suite.id, caseId, {
    checkId: "check_format", kind: "json-schema", dialect: "draft-07", label: "Unchecked format",
    schema: { format: "custom-format" },
  });
  await openDurableProject(page, project);
  await primaryAction(page, "evaluations").click();
  await page.getByRole("dialog", { name: /Start “Topics”/ }).getByRole("button", { name: /^Start 1 call/ }).click();
  const results = page.locator(".evaluation-results-workspace");
  await expect(results).toContainText("1 / 1 passed");
  const rows = results.locator(".evaluation-check-results > li");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0).getByRole("group")).toHaveCount(0);
  await expect(rows.nth(1).getByRole("group")).toHaveCount(0);
  const diagnostics = rows.nth(2).getByRole("group");
  await diagnostics.getByText("Structured check diagnostics", { exact: true }).click();
  await expect(diagnostics).toContainText("/format: custom-format (not checked)");
  await expect(diagnostics).toContainText("Extraction: whole-answer");
});
