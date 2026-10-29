import { expect, test, type Page } from "@playwright/test";
import { createProjectFile } from "../../packages/core/src/project";
import { addEvaluationCase, addEvaluationCheck, createEvaluationSuite } from "../../packages/core/src/evaluation-suite-authoring";
import { expandedPreflight, importProject, openMode, seedProfile, waitForHydration } from "./support";

async function exportedProject(page: Page) {
  await page.getByLabel("Project menu").click();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON copy…" }).click();
  const stream = await (await downloaded).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function fixture() {
  let project = createProjectFile({ name: "Structured authoring", request: {
    provider: "openai-compatible", endpoint: "http://127.0.0.1:44014/v1", model: "buffered-test-model",
    messages: [{ role: "user", content: "Hello" }], temperature: 0.4,
  }, idSuffix: "structured", createdAt: "2026-10-16T12:00:00.000Z" });
  const suite = createEvaluationSuite(project, "Structured suite", () => "structured");
  const added = addEvaluationCase(suite.project, suite.suiteId, () => "structured");
  project = addEvaluationCheck(added.project, suite.suiteId, added.caseId, { kind: "json-schema" }, () => "shape");
  return project;
}

test("schema drafts generate, validate, cancel, and survive export and reopen", async ({ page }) => {
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, fixture(), "Structured authoring");
  await openMode(page, "Evaluations");
  const card = page.locator(".evaluation-check-card").filter({ hasText: "JSON Schema" });
  // Existing schema checks currently have no schema controls at all.
  await expect(card.getByRole("textbox", { name: "Schema draft", exact: true })).toHaveCount(1);
  const draft = card.getByLabel("Schema draft", { exact: true });
  await expect(draft).toHaveValue(JSON.stringify({ type: "object" }, null, 2));
  await draft.fill('{"pattern":"unsafe"}');
  await card.getByRole("button", { name: "Save structured check" }).click();
  await expect(card.getByRole("alert")).toContainText("Pattern constraints are unsupported");
  await expect(draft).toHaveValue('{"pattern":"unsafe"}');
  await card.getByRole("button", { name: "Cancel draft" }).click();
  await expect(draft).toHaveValue(JSON.stringify({ type: "object" }, null, 2));
  await card.getByText("Generate from a JSON example", { exact: true }).click();
  await card.getByLabel("JSON example", { exact: true }).fill('{"answer":2,"rows":[{"name":"A"}],"empty":[]}');
  await card.getByLabel("Disallow extra properties at every object level").check();
  await card.getByRole("button", { name: "Generate schema" }).click();
  await expect(card).toContainText("Empty arrays do not establish item types");
  const generated = JSON.parse(await draft.inputValue());
  expect(generated.required).toEqual(["answer", "empty", "rows"]);
  expect(generated.additionalProperties).toBe(false);
  expect(generated.properties.rows.items.additionalProperties).toBe(false);
  generated.properties.answer.type = "number";
  await draft.fill(JSON.stringify(generated, null, 2));
  await card.getByLabel("JSON input policy").selectOption("surrounding-fence");
  await card.getByRole("button", { name: "Save structured check" }).click();
  await expect(card.getByRole("status")).toContainText("Structured check saved");
  await draft.fill("false");
  await card.getByRole("button", { name: "Cancel draft" }).click();
  await expect(draft).toHaveValue(JSON.stringify(generated, null, 2));
  const exported = await exportedProject(page);
  const saved = exported.evaluationSuites[0].cases[0].checks[0];
  expect(saved.schema).toEqual(generated);
  expect(saved.inputPolicy).toBe("surrounding-fence");
  expect(saved).not.toHaveProperty("example");
  exported.name = "Reopened structured authoring";
  await importProject(page, exported, "Reopened structured authoring", { replaceDirty: "discard" });
  await expect(draft).toHaveValue(JSON.stringify(generated, null, 2));
  await page.getByLabel("New check kind").selectOption("json-schema");
  await page.getByRole("button", { name: "+ Add check" }).click();
  await expect(page.getByLabel("Schema draft", { exact: true })).toHaveCount(2);
});


test("structured policies and unchecked formats stay usable on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, fixture(), "Structured authoring");
  await openMode(page, "Evaluations");
  const card = page.locator(".evaluation-check-card").first();
  await card.getByLabel("Schema draft", { exact: true }).fill('{"type":"string","format":"date-time"}');
  await card.getByRole("button", { name: "Save structured check" }).click();
  await expect(card).toContainText("Format not checked:");
  await expect(card).toContainText("date-time");
  await card.getByText("Generate from a JSON example", { exact: true }).click();
  await card.getByLabel("JSON example", { exact: true }).fill("invalid private example");
  await card.getByRole("button", { name: "Generate schema" }).click();
  await expect(card.getByRole("alert")).toHaveText("Enter a valid JSON example.");
  await expect(card.getByLabel("Schema draft", { exact: true })).toHaveValue('{"type":"string","format":"date-time"}');
  await page.getByLabel("New check kind").selectOption("valid-json");
  await page.getByRole("button", { name: "+ Add check" }).click();
  const json = page.locator(".evaluation-check-card").last();
  await json.getByLabel("JSON input policy").selectOption("first-json-fence");
  await json.getByRole("button", { name: "Save structured check" }).click();
  await expect(json.getByRole("status")).toContainText("Structured check saved");
  await json.getByLabel("JSON input policy").selectOption("strict");
  await json.getByRole("button", { name: "Cancel draft" }).click();
  await expect(json.getByLabel("JSON input policy")).toHaveValue("first-json-fence");
  const width = await page.evaluate(() => ({ content: document.body.scrollWidth, viewport: document.documentElement.clientWidth }));
  expect(width.content).toBeLessThanOrEqual(width.viewport);
});

test("saving a strict Valid JSON check leaves its definition without an input policy", async ({ page }) => {
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  const project = fixture();
  const suite = project.evaluationSuites[0];
  const withJson = addEvaluationCheck(project, suite.id, suite.cases[0].id, { kind: "valid-json" }, () => "json");
  await importProject(page, withJson, "Structured authoring");
  await openMode(page, "Evaluations");
  const json = page.locator(".evaluation-check-card").filter({ hasText: "Valid JSON" });
  await json.getByRole("button", { name: "Save structured check" }).click();
  await expect(json.getByRole("status")).toContainText("Structured check saved");
  // An unchanged save must not turn into a different check for comparisons.
  const untouched = (await exportedProject(page)).evaluationSuites[0].cases[0].checks[1];
  expect(untouched).toEqual({ checkId: "check_json", kind: "valid-json", topLevel: "any" });
  await json.getByLabel("JSON input policy").selectOption("first-json-fence");
  await json.getByRole("button", { name: "Save structured check" }).click();
  await expect(json.getByRole("status")).toContainText("Structured check saved");
  await json.getByLabel("JSON input policy").selectOption("strict");
  await json.getByRole("button", { name: "Save structured check" }).click();
  await expect(json.getByRole("status")).toContainText("Structured check saved");
  const restored = (await exportedProject(page)).evaluationSuites[0].cases[0].checks[1];
  expect(restored).toEqual({ checkId: "check_json", kind: "valid-json", topLevel: "any" });
});

test("preflight blocks an imported schema the evaluator cannot run until it is corrected", async ({ page }) => {
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  const project = fixture();
  const check = project.evaluationSuites[0].cases[0].checks[0];
  if (check.kind !== "json-schema") throw new Error("fixture must start with a schema check");
  check.schema = { type: "string", pattern: "^a" };
  await importProject(page, project, "Structured authoring");
  await openMode(page, "Evaluations");
  await expect(await expandedPreflight(page))
    .toContainText('A JSON Schema check on case "Untitled case" cannot run: Pattern constraints are unsupported.');
  const card = page.locator(".evaluation-check-card").filter({ hasText: "JSON Schema" });
  await card.getByLabel("Schema draft", { exact: true }).fill('{"type":"string"}');
  await card.getByRole("button", { name: "Save structured check" }).click();
  await expect(card.getByRole("status")).toContainText("Structured check saved");
  await expect(await expandedPreflight(page)).not.toContainText("cannot run");
});
