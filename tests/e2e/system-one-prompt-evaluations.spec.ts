import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { createDecisionPromptTemplate } from "../../packages/core/src/decision-template";
import { updateDecisionRequestDraft } from "../../packages/core/src/decision-request";
import { createProjectFile, serializeProjectFile, type ProjectFile } from "../../packages/core/src/project";
import { SYSTEM_ONE_FIXTURE_ORIGIN, openMode, primaryAction, seedProfiles, stubProjectDirectory, waitForHydration } from "./support";
import { expectModalContract } from "./support/modal";

const capture = JSON.parse(readFileSync(new URL("../fixtures/system-one/llamacpp-all-types.json", import.meta.url), "utf8")).request;
const endpoint = `${SYSTEM_ONE_FIXTURE_ORIGIN}/llamacpp/v1`;
function fixture() {
  let project = createProjectFile({ name: "Prompt evaluations", idSuffix: "prompt-eval", request: {
    provider: "openai-compatible", endpoint, model: "all-types", messages: [{ role: "user", content: "Keep chat" }],
  } });
  project = updateDecisionRequestDraft(project, { decision: { state: "Keep Compose {{draft}}", questions: capture.questions }, values: { draft: "personal" }, branch: false, idSuffix: "compose" });
  project = createDecisionPromptTemplate(project, { name: "Ticket decision", decision: { state: "{{ticket}}", questions: capture.questions }, variableDefaults: { ticket: "Template default" }, idSuffix: "ticket", revisionIdSuffix: "one" });
  return project;
}
async function open(page: Page, project = fixture()) {
  await seedProfiles(page, [{ id: "decisions", instanceId: "decisions", name: "Decision fixture", endpoint, model: "all-types", systemOne: true }], "decisions");
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubProjectDirectory(page, { name: "prompt-eval.inference-lens", files: { "project.json": serializeProjectFile(project) } });
  await page.goto("/");
  await waitForHydration(page, "Decision fixture");
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project folder…" }).click();
  await expect(page.locator(".brand")).toContainText("Prompt evaluations");
  await page.locator(".target-menu summary").click();
  await page.getByRole("button", { name: /manage connections/i }).click();
  await page.getByRole("combobox", { name: "Profile for Default connection" }).selectOption("decisions");
  await page.keyboard.press("Escape");
  await openMode(page, "Prompts");
  await page.locator(".template-list").getByRole("button", { name: /Ticket decision/ }).click();
}
async function file(page: Page, path = "project.json"): Promise<string> {
  return page.evaluate(async (path) => {
    let dir = await (window as unknown as { showDirectoryPicker(): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker();
    const parts = path.split("/");
    for (const segment of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(segment);
    return (await (await dir.getFileHandle(parts.at(-1)!)).getFile()).text();
  }, path);
}
async function saved(page: Page): Promise<ProjectFile> { return JSON.parse(await file(page)); }
async function names(page: Page, directory: string): Promise<string[]> {
  return page.evaluate(async (directory) => {
    const root = await (window as unknown as { showDirectoryPicker(): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker();
    const dir = await root.getDirectoryHandle(directory);
    const names: string[] = [];
    for await (const entry of (dir as unknown as { values(): AsyncIterable<{ name: string }> }).values()) names.push(entry.name);
    return names;
  }, directory);
}

test("library evaluation preserves Compose and historical results through reviewed retargets", async ({ page }) => {
  const original = fixture();
  await open(page, original);
  await openMode(page, "Compose");
  await page.getByRole("radio", { name: "Decision", exact: true }).click();
  const compose = page.getByRole("region", { name: "Decision request", exact: true });
  await compose.getByRole("tablist", { name: "Decision editor", exact: true }).getByRole("tab", { name: "JSON", exact: true }).click();
  await compose.getByLabel("Decision input (state and questions)").fill('{"state":"Unfinished Compose",');
  await openMode(page, "Prompts");
  // Assert the existing surface's actual value before looking for a new control.
  await expect(page.locator(".template-insert-bar")).toContainText("Evaluate in a suite…");
  await page.getByRole("button", { name: "Evaluate in a suite…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Evaluate decision revision" });
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Evaluate in a suite…", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Evaluate in a suite…", exact: true }).click();
  await dialog.getByRole("button", { name: "Create new suite", exact: true }).click();
  const editor = page.locator(".evaluation-editor");
  await expect(editor).toContainText("Decision suite");
  await expect(editor).toContainText("Ticket decision");
  await editor.getByRole("button", { name: "+ Add case input", exact: true }).click();
  await editor.getByRole("button", { name: "+ Add case", exact: true }).first().click();
  await editor.getByLabel("Untitled case ticket").fill("Case ticket");
  await editor.getByLabel("New check kind").selectOption("decision-choice");
  await editor.getByRole("button", { name: "+ Add check", exact: true }).click();
  await editor.getByLabel("Decision question").selectOption("intent");
  await editor.getByLabel("Decision option").selectOption("billing");
  await expect(page.locator("#evaluation-preflight-summary")).toHaveText("Ready to run");
  await primaryAction(page, "evaluations").click();
  await page.getByRole("dialog", { name: /Start “Ticket decision evaluation”/ }).getByRole("button", { name: "Start 1 calls" }).click();
  const results = page.getByRole("region", { name: "Evaluation results" });
  await expect(results).toContainText("1 / 1 passed");
  await expect(results).toContainText("intent: billing");
  await expect.poll(async () => (await saved(page)).evaluationSuites[0]?.cases.length).toBe(1);
  const project = await saved(page);
  expect(project.defaults).toEqual(original.defaults);
  expect(project.decisionRequestRevisions[0]).toEqual(original.decisionRequestRevisions[0]);
  expect(project.conversationRevisions).toEqual(original.conversationRevisions);
  const trace = JSON.parse(await file(page, `traces/${(await names(page, "traces"))[0]}`));
  expect(JSON.stringify(trace)).toContain("Case ticket");
  const planName = (await names(page, "experiments")).find((name) => name.endsWith(".plan.json"))!;
  const planBefore = await file(page, `experiments/${planName}`);
  const resultName = (await names(page, "experiments")).find((name) => name.endsWith(".result.json"))!;
  const resultBefore = await file(page, `experiments/${resultName}`);
  await openMode(page, "Prompts");
  await page.getByRole("button", { name: "Evaluate in a suite…", exact: true }).click();
  await expect(dialog).toContainText("Ticket decision evaluation");
  await expect(dialog).toContainText("already pinned to this revision");
  await dialog.getByRole("button", { name: "Open", exact: true }).click();
  await expect(editor).toContainText("Ticket decision evaluation");
  expect((await saved(page)).decisionRequestRevisions).toHaveLength(2);

  // Source edits alone never move a suite. Review incompatible changes before retargeting.
  await openMode(page, "Prompts");
  await page.getByRole("tablist", { name: "Decision editor", exact: true }).getByRole("tab", { name: "JSON", exact: true }).click();
  await page.getByLabel("Decision input (state and questions)").fill(JSON.stringify({ state: "{{replacement}}", questions: { intent: { type: "noul", instructions: "Relevant?" } } }));
  await expect(page.getByRole("button", { name: "Evaluate in a suite…", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Create revision", exact: true }).click();
  await page.getByRole("button", { name: "Evaluate in a suite…", exact: true }).click();
  await dialog.getByRole("button", { name: "Review Ticket decision evaluation…", exact: true }).click();
  await expect(dialog).toContainText('Removed variable "ticket"');
  await expect(dialog).toContainText('"intent" changed from choice to noul');
  await expect(dialog).toContainText('needs a choice question');
  await expect(dialog).toContainText('cannot resolve template variable "replacement"');
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect((await saved(page)).evaluationSuites[0]!.input).toEqual(project.evaluationSuites[0]!.input);
  await page.getByRole("button", { name: "Evaluate in a suite…", exact: true }).click();
  await dialog.getByRole("button", { name: "Review Ticket decision evaluation…", exact: true }).click();
  await dialog.getByRole("button", { name: "Retarget suite", exact: true }).focus();
  await page.keyboard.press("Tab");
  const revisionChanges = dialog.locator("summary", { hasText: "Revision changes" });
  await expect(revisionChanges).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toContainText("Type: choice → noul");
  await page.keyboard.press("Enter");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog.getByRole("button", { name: "Retarget suite", exact: true })).toBeInViewport();
  await page.screenshot({ path: "test-results/decision-retarget-mobile.png", fullPage: true });
  await dialog.getByRole("button", { name: "Retarget suite", exact: true }).click();
  await expect(editor).toContainText("needs a choice question");
  await expect(primaryAction(page, "evaluations")).toBeDisabled();
  await expect.poll(async () => (await saved(page)).decisionRequestRevisions.length).toBe(3);
  const retargeted = await saved(page);
  expect(retargeted.evaluationSuites[0]!.cases).toEqual(project.evaluationSuites[0]!.cases);
  expect(retargeted.evaluationSuites[0]!.inputBindings).toEqual(project.evaluationSuites[0]!.inputBindings);
  expect(retargeted.decisionRequestRevisions.at(-1)!.parentRevisionId).toBe(project.decisionRequestRevisions.at(-1)!.id);
  expect(retargeted.defaults).toEqual(original.defaults);
  expect(await file(page, `experiments/${planName}`)).toBe(planBefore);
  expect(await file(page, `experiments/${resultName}`)).toBe(resultBefore);

  // Repairs the suite already owes on its current pin are not attributed to the next retarget.
  await page.setViewportSize({ width: 1440, height: 900 });
  await openMode(page, "Prompts");
  await page.getByRole("tablist", { name: "Decision editor", exact: true }).getByRole("tab", { name: "JSON", exact: true }).click();
  await page.getByLabel("Decision input (state and questions)").fill(JSON.stringify({ state: "Reworded {{replacement}}", questions: { intent: { type: "noul", instructions: "Relevant?" } } }));
  await page.getByRole("button", { name: "Create revision", exact: true }).click();
  await page.getByRole("button", { name: "Evaluate in a suite…", exact: true }).click();
  await dialog.getByRole("button", { name: "Review Ticket decision evaluation…", exact: true }).click();
  await expect(dialog).toContainText("This retarget introduces no incompatible inputs or checks.");
  const existing = dialog.locator("details", { hasText: "Already needs repair" });
  await expect(existing.locator("summary")).toHaveText("Already needs repair (3), unchanged by this retarget");
  await existing.locator("summary").click();
  await expect(existing).toContainText("needs a choice question");
  await expect(existing).toContainText('fills variable "ticket", which the pinned decision request does not use');
  await expect(existing).toContainText('cannot resolve template variable "replacement"');
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  // A historical revision can deliberately restore compatibility; the same-pin action simply opens.
  await openMode(page, "Prompts");
  await page.getByLabel("Revision", { exact: true }).selectOption("template-revision_one");
  await page.getByRole("button", { name: "Evaluate in a suite…", exact: true }).click();
  await dialog.getByRole("button", { name: "Review Ticket decision evaluation…", exact: true }).click();
  await expect(dialog).toContainText("This retarget introduces no incompatible inputs or checks.");
  await dialog.getByRole("button", { name: "Retarget suite", exact: true }).click();
  await expect(page.locator("#evaluation-preflight-summary")).toHaveText("Ready to run");
  await openMode(page, "Prompts");
  await page.getByRole("button", { name: "Evaluate in a suite…", exact: true }).click();
  await dialog.getByRole("button", { name: "Create new suite", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Evaluation suites" })).toContainText("Ticket decision evaluation 2");
  await expect(editor.getByLabel("Decision request revision").locator('optgroup[label="Ticket decision"]')).toHaveCount(2);
  await openMode(page, "Prompts");
  await page.getByRole("button", { name: "Evaluate in a suite…", exact: true }).click();
  await expect(dialog).toContainText("Ticket decision evaluation 2");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await openMode(page, "Compose");
  await expect(compose.getByLabel("Decision input (state and questions)")).toHaveValue('{"state":"Unfinished Compose",');
});

test("the decision evaluate dialog follows the modal contract", async ({ page }) => {
  await open(page);
  await openMode(page, "Prompts");
  await expectModalContract(page, {
    open: page.getByRole("button", { name: "Evaluate in a suite…", exact: true }),
    dialog: page.getByRole("dialog", { name: "Evaluate decision revision" }),
  });
});
