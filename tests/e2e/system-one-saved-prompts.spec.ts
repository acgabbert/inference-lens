import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { createProjectFile, createPromptTemplate, serializeProjectFile, setPromptTemplateRecommendedTarget, type ProjectFile } from "../../packages/core/src/project";
import { createDecisionPromptTemplate, appendDecisionPromptTemplateRevision } from "../../packages/core/src/decision-template";
import { BUFFERED_FIXTURE_ENDPOINT, SYSTEM_ONE_FIXTURE_ORIGIN, importProject, openMode, seedProfile, seedProfiles, stubProjectDirectory, waitForHydration } from "./support";

const capture = JSON.parse(readFileSync(new URL("../fixtures/system-one/llamacpp-all-types.json", import.meta.url), "utf8")).request;
const decision = { state: "{{ticket}}", questions: capture.questions };
function fixture() {
  let project = createProjectFile({ name: "Saved decisions", idSuffix: "saved-decisions", request: {
    provider: "openai-compatible", endpoint: BUFFERED_FIXTURE_ENDPOINT, model: "buffered-test-model",
    messages: [{ role: "user", content: "Keep the chat" }],
  } });
  project = createPromptTemplate(project, { name: "Chat helper", messages: [{ role: "user", content: "Hello" }], idSuffix: "chat-helper" });
  return createDecisionPromptTemplate(project, { name: "Ticket decision", decision, variableDefaults: { ticket: "Default ticket" }, idSuffix: "ticket-decision" });
}

test("the mixed library shows both kinds and searches and filters decision prompts", async ({ page }) => {
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, fixture(), "Saved decisions");
  await openMode(page, "Prompts");
  // Read the existing list so preimplementation failure reports the actual
  // missing entry, rather than timing out on an unimplemented control.
  await expect(page.locator(".template-list strong")).toHaveText(["Chat helper", "Ticket decision"]);
  await page.getByRole("button", { name: "Decision", exact: true }).click();
  await expect(page.locator(".template-list strong")).toHaveText(["Ticket decision"]);
  await page.getByLabel("Search prompts").fill("missing");
  await expect(page.locator(".template-list strong")).toHaveCount(0);
  await page.getByLabel("Search prompts").fill("ticket");
  await page.locator(".template-list").getByRole("button").click();
  await expect(page.getByLabel("Prompt name")).toHaveValue("Ticket decision");
  await expect(page.getByLabel("State text")).toHaveValue("{{ticket}}");
  await expect(page.getByLabel("Default for ticket")).toHaveValue("Default ticket");
});

test("prompt names warn about duplicates across the mixed library", async ({ page }) => {
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, fixture(), "Saved decisions");
  await openMode(page, "Prompts");
  const warning = page.getByRole("status").filter({ hasText: "Another prompt has this name" });
  await page.locator(".template-list").getByRole("button", { name: /Chat helper/ }).click();
  await page.getByLabel("Prompt name").fill("Ticket decision");
  await expect(warning).toHaveCount(1);
  await page.getByLabel("Prompt name").fill("Chat helper");
  await page.locator(".template-list").getByRole("button", { name: /Ticket decision/ }).click();
  await page.getByLabel("Prompt name").fill("chat helper");
  await expect(warning).toHaveCount(1);
});

test("kind, search and status filters keep the editor on a visible prompt", async ({ page }) => {
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, fixture(), "Saved decisions");
  await openMode(page, "Prompts");
  const emptyHeading = page.locator(".template-empty-state h3");
  await page.locator(".template-list").getByRole("button", { name: /Ticket decision/ }).click();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(emptyHeading).toHaveCount(0);
  await expect(page.getByLabel("Prompt name")).toHaveValue("Chat helper");
  await expect(page.locator(".template-list [aria-current=true] strong")).toHaveText("Chat helper");
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.locator(".template-list").getByRole("button", { name: /Ticket decision/ }).click();
  await page.getByLabel("Search prompts").fill("chat");
  await expect(page.getByLabel("Prompt name")).toHaveValue("Chat helper");
  await page.getByLabel("Search prompts").fill("nothing matches");
  await expect(emptyHeading).toHaveText("No matching prompts");
  await expect(page.locator(".template-list .template-empty")).toHaveText("No prompts match these filters.");
  await page.getByLabel("Search prompts").fill("");
  await page.getByRole("button", { name: "Decision", exact: true }).click();
  await page.getByRole("button", { name: /^Archived/ }).click();
  await expect(emptyHeading).toHaveText("No archived prompts");
  await page.getByRole("button", { name: /^Active/ }).click();
  await expect(page.getByLabel("Prompt name")).toHaveValue("Ticket decision");
});

test("incomplete library edits survive kind, revision and mode navigation without claiming to be saved", async ({ page }) => {
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, fixture(), "Saved decisions");
  await openMode(page, "Prompts");
  await page.locator(".template-list").getByRole("button", { name: /Ticket decision/ }).click();
  await page.getByRole("tablist", { name: "Decision editor", exact: true }).getByRole("tab", { name: "JSON", exact: true }).click();
  const input = page.getByLabel("Decision input (state and questions)");
  await input.fill('{"state":"Unfinished work",');
  await expect(page.getByRole("status").filter({ hasText: "Incomplete edits" })).toContainText("session only");
  await page.locator(".template-list").getByRole("button", { name: /Chat helper/ }).click();
  await page.locator(".template-list").getByRole("button", { name: /Ticket decision/ }).click();
  await expect(input).toHaveValue('{"state":"Unfinished work",');
  await page.getByLabel("Revision", { exact: true }).selectOption({ index: 1 });
  await expect(page.getByLabel("State text")).toHaveValue("{{ticket}}");
  await page.getByLabel("Revision", { exact: true }).selectOption("draft");
  await expect(input).toHaveValue('{"state":"Unfinished work",');
  await openMode(page, "Runs");
  await openMode(page, "Prompts");
  await expect(input).toHaveValue('{"state":"Unfinished work",');
  await input.fill(JSON.stringify(decision));
  await page.getByLabel("Default for ticket").fill("");
  await page.getByRole("button", { name: "Create revision", exact: true }).click();
  await expect(page.getByLabel("Default for ticket")).toHaveValue("");
  await page.getByRole("button", { name: "Remove default for ticket" }).click();
  await page.getByRole("button", { name: "Create revision", exact: true }).click();
  await expect(page.getByRole("button", { name: "Remove default for ticket" })).toHaveCount(0);
});

async function savedProject(page: import("@playwright/test").Page): Promise<ProjectFile> {
  return page.evaluate(async () => {
    const root = await (window as unknown as { showDirectoryPicker(): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker();
    return JSON.parse(await (await (await root.getFileHandle("project.json")).getFile()).text());
  });
}

test("pinned revisions run through capture replay, review updates, detach and reopen with authored values", async ({ page, browser }) => {
  await seedProfiles(page, [
    { id: "buffered", instanceId: "buffered", name: "Buffered fixture", endpoint: BUFFERED_FIXTURE_ENDPOINT },
    { id: "decisions", instanceId: "decisions", name: "Decision fixture", endpoint: `${SYSTEM_ONE_FIXTURE_ORIGIN}/llamacpp/v1`, systemOne: true },
  ], "buffered");
  await stubProjectDirectory(page, { name: "saved-decisions.inference-lens", files: { "project.json": serializeProjectFile(fixture()) } });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project folder…" }).click();
  await expect(page.locator(".brand")).toContainText("Saved decisions");
  await openMode(page, "Prompts");
  await page.locator(".template-list").getByRole("button", { name: /Ticket decision/ }).click();
  await page.getByRole("button", { name: "Use Current", exact: true }).click();
  const pane = page.getByRole("region", { name: "Decision request", exact: true });
  await expect(pane.getByLabel("State text")).toHaveValue("{{ticket}}");
  await expect(pane.getByLabel("State text")).toBeDisabled();
  await pane.getByRole("region", { name: "Variables", exact: true }).getByLabel("{{ticket}}").fill("Override ticket");
  const model = pane.getByRole("combobox", { name: "Model", exact: true });
  await model.fill("all-types");
  await model.press("Escape");
  await page.getByRole("button", { name: /^Run decision/ }).click();
  await expect(page.getByRole("article", { name: "Answer intent" })).toContainText("Choice billing");
  await expect(page.getByRole("region", { name: "Decision evidence" })).toContainText("Override ticket");
  await pane.getByRole("button", { name: "Edit source", exact: true }).click();
  await page.getByLabel("State text").fill("Changed {{ticket}} / {{plan}}");
  await page.getByLabel("Default for ticket").fill("New default");
  await page.getByRole("button", { name: "Create revision", exact: true }).click();
  await page.getByRole("button", { name: "Back to request" }).click();
  await expect(page.getByRole("article", { name: "Answer intent" })).toHaveCount(1);
  await expect(pane.getByLabel("State text")).toHaveValue("{{ticket}}");
  await expect(pane.getByRole("region", { name: "Saved decision prompt" })).toContainText("Revision 1");
  const updateAction = pane.getByRole("button", { name: "Update to latest revision…" });
  await updateAction.click();
  const review = page.getByRole("dialog", { name: "Update decision prompt" });
  await expect(review.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(review).toHaveCount(0);
  await expect(updateAction).toBeFocused();
  await updateAction.click();
  await expect(review).toContainText("New default");
  await expect(review).toContainText("Changed {{ticket}} / {{plan}}");
  await review.getByRole("button", { name: "Update revision", exact: true }).click();
  await expect(pane.getByLabel("State text")).toHaveValue("Changed {{ticket}} / {{plan}}");
  await expect(pane.getByRole("region", { name: "Variables" }).getByLabel("{{ticket}}")).toHaveValue("Override ticket");
  await expect(pane.getByRole("region", { name: "Variables" }).getByLabel("{{plan}}")).toHaveValue("");
  await expect(pane).toContainText('Template variable "plan" has no value.');
  await expect(page.getByRole("button", { name: /^Run decision/ })).toBeDisabled();
  await pane.getByRole("region", { name: "Variables" }).getByLabel("{{plan}}").fill("premium");
  await pane.getByRole("button", { name: "Detach", exact: true }).click();
  await expect(pane.getByLabel("State text")).toBeEnabled();
  await expect.poll(async () => (await savedProject(page)).decisionRequestRevisions.at(-1)?.kind).toBe("inline");
  const saved = await savedProject(page);
  const detached = saved.decisionRequestRevisions.at(-1)!;
  expect(detached.kind === "inline" && detached.decision.state).toBe("Changed {{ticket}} / {{plan}}");
  expect(detached.kind === "inline" && detached.values).toEqual({ ticket: "Override ticket", plan: "premium" });
  expect(saved.decisionRequestRevisions.some((revision) => revision.kind === "template-use" && revision.templateRevisionId === saved.promptTemplates[1]!.revisions[0]!.id)).toBe(true);
  const reopened = await browser.newPage();
  await seedProfile(reopened);
  await reopened.goto("/");
  await waitForHydration(reopened);
  await importProject(reopened, saved, "Saved decisions");
  await reopened.getByRole("radio", { name: "Decision", exact: true }).click();
  await expect(reopened.getByLabel("State text")).toHaveValue("Changed {{ticket}} / {{plan}}");
  await expect(reopened.getByLabel("{{ticket}}", { exact: true })).toHaveValue("Override ticket");
  await reopened.close();
});

test("Compose capture retains tokens and values, and invalid request replacement requires discard", async ({ page }) => {
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, fixture(), "Saved decisions");
  await page.getByRole("radio", { name: "Decision", exact: true }).click();
  await page.getByRole("tablist", { name: "Decision editor", exact: true }).getByRole("tab", { name: "JSON", exact: true }).click();
  await page.getByLabel("Decision input (state and questions)").fill(JSON.stringify(decision));
  await page.getByLabel("{{ticket}}", { exact: true }).fill("Capture this value");
  await page.getByRole("button", { name: "Save as decision prompt" }).click();
  await expect(page.getByLabel("State text")).toHaveValue("{{ticket}}");
  await expect(page.getByLabel("Default for ticket")).toHaveValue("Capture this value");
  await page.getByRole("button", { name: "Save to project", exact: true }).click();
  await openMode(page, "Compose");
  await page.getByLabel("Decision input (state and questions)").fill("{ unfinished");
  await openMode(page, "Prompts");
  await page.getByRole("button", { name: "Use Current", exact: true }).click();
  const discard = page.getByRole("dialog", { name: "Discard incomplete decision request?" });
  await discard.getByRole("button", { name: "Cancel", exact: true }).click();
  await openMode(page, "Compose");
  await expect(page.getByLabel("Decision input (state and questions)")).toHaveValue("{ unfinished");
  await openMode(page, "Prompts");
  await page.getByRole("button", { name: "Use Current", exact: true }).click();
  await discard.getByRole("button", { name: "Discard and use revision" }).click();
  await expect(page.getByLabel("State text")).toHaveValue("{{ticket}}");
  await expect(page.getByLabel("{{ticket}}", { exact: true })).toHaveValue("Capture this value");
});

test("captured defaults stay in a session draft until the author chooses to save", async ({ page }) => {
  await seedProfile(page);
  await stubProjectDirectory(page, { name: "capture-review.inference-lens", files: { "project.json": serializeProjectFile(fixture()) } });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project folder…" }).click();
  await expect(page.locator(".brand")).toContainText("Saved decisions");
  await page.getByRole("radio", { name: "Decision", exact: true }).click();
  await page.getByRole("tablist", { name: "Decision editor", exact: true }).getByRole("tab", { name: "JSON", exact: true }).click();
  await page.getByLabel("Decision input (state and questions)").fill(JSON.stringify(decision));
  await page.getByLabel("{{ticket}}", { exact: true }).fill("Trial value to review");
  await expect.poll(async () => (await savedProject(page)).decisionRequestRevisions.length).toBe(1);
  await page.getByRole("button", { name: "Save as decision prompt" }).click();
  await expect(page.getByLabel("Default for ticket")).toHaveValue("Trial value to review");
  // Wait beyond autosave so this checks the persisted boundary, not the
  // moment before a mistaken capture mutation reaches the folder.
  await page.waitForTimeout(1600);
  expect((await savedProject(page)).promptTemplates.map(({ name }) => name)).toEqual(["Chat helper", "Ticket decision"]);
  await page.getByRole("button", { name: "Remove default for ticket" }).click();
  await page.getByRole("button", { name: "Save to project", exact: true }).click();
  await expect.poll(async () => (await savedProject(page)).promptTemplates.length).toBe(3);
  const saved = await savedProject(page);
  expect(saved.promptTemplates[2]!.revisions[0]!.variableDefaults).toEqual({});
  expect(saved.decisionRequestRevisions[0]!.kind).toBe("inline");
});

test("decision authoring works before a project or decision connection exists, including a narrow layout", async ({ page }, testInfo) => {
  await seedProfile(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await waitForHydration(page);
  await openMode(page, "Prompts");
  await page.getByRole("button", { name: "New decision prompt", exact: true }).click();
  await page.getByLabel("Prompt name").fill("Offline decision prompt");
  await page.getByLabel("State text").fill("{{ticket}}");
  await page.getByLabel("Default for ticket").fill("A reusable ticket");
  await expect(page.getByRole("status").filter({ hasText: "Session draft" })).toContainText("not saved after closing");
  await openMode(page, "Runs");
  await openMode(page, "Prompts");
  await expect(page.getByLabel("State text")).toHaveValue("{{ticket}}");
  await page.getByRole("button", { name: "Save to project", exact: true }).click();
  await expect(page.locator(".brand")).toContainText("Unsaved");
  await expect(page.getByRole("button", { name: "Create revision", exact: true })).toBeVisible();
  await page.getByLabel("Default for ticket").scrollIntoViewIfNeeded();
  expect((await page.getByLabel("Default for ticket").boundingBox())!.width).toBeGreaterThan(280);
  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(horizontalOverflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("decision-template-narrow.png"), fullPage: true });
});

test("ordered criteria appear in revision diffs, and decision prompts archive and restore", async ({ page }) => {
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, fixture(), "Saved decisions");
  await openMode(page, "Prompts");
  const item = page.locator(".template-list").getByRole("button", { name: /Ticket decision/ });
  await item.focus();
  await item.press("Enter");
  const severity = page.getByRole("article", { name: "Question 2", exact: true });
  await severity.getByRole("button", { name: "Move level 1 down", exact: true }).click();
  await page.getByLabel("Revision name", { exact: true }).fill("Reorder severity");
  await page.locator(".template-list").getByRole("button", { name: /Chat helper/ }).click();
  await page.locator(".template-list").getByRole("button", { name: /Ticket decision/ }).click();
  await expect(page.getByLabel("Revision name", { exact: true })).toHaveValue("Reorder severity");
  await page.getByRole("button", { name: "Create revision", exact: true }).click();
  await expect(page.getByLabel("Revision", { exact: true }).locator("option:checked")).toHaveText("Current — Reorder severity");
  await page.locator(".template-revision-diff summary").click();
  await expect(page.locator(".template-revision-diff")).toContainText("Criteria and ordering");
  await expect(page.locator(".template-revision-diff")).toContainText("critical");
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await page.getByRole("button", { name: "Archive template", exact: true }).click();
  await expect(page.locator(".template-list strong")).toHaveText(["Chat helper"]);
  await page.getByRole("button", { name: /^Archived/ }).click();
  await expect(page.locator(".template-list strong")).toHaveText(["Ticket decision"]);
  await expect(page.getByRole("button", { name: "Use Current", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.getByLabel("Prompt name")).toHaveValue("Ticket decision");
  await expect(page.getByRole("button", { name: "Use Current", exact: true })).toBeEnabled();
});

test("secret-like variables refuse reusable defaults without breaking the editor", async ({ page }) => {
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, fixture(), "Saved decisions");
  await openMode(page, "Prompts");
  await page.locator(".template-list").getByRole("button", { name: /Ticket decision/ }).click();
  await page.getByLabel("State text").fill("{{api_key}}");
  await expect(page.getByRole("button", { name: "Create revision", exact: true })).toBeDisabled();
  await expect(page.getByLabel("Default for api_key")).toBeDisabled();
  await expect(page.getByRole("alert").filter({ hasText: "Secret-like variable" })).toContainText("api_key");
  await page.getByLabel("State text").fill("{{ticket}}");
  await expect(page.getByLabel("Default for ticket")).toHaveValue("Default ticket");
});

test("historical decision use keeps the target and explains an unavailable System One recommendation", async ({ page }) => {
  let project = fixture();
  const template = project.promptTemplates[1]!;
  project = appendDecisionPromptTemplateRevision(project, { templateId: template.id, decision: { ...decision, state: "New {{ticket}}" }, variableDefaults: { ticket: "New default" } });
  project = setPromptTemplateRecommendedTarget(project, template.id, { connectionRequirementId: project.connectionRequirements[0]!.id, model: "recommended-model" });
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, project, "Saved decisions");
  await openMode(page, "Prompts");
  await page.locator(".template-list").getByRole("button", { name: /Ticket decision/ }).click();
  await page.getByLabel("Revision", { exact: true }).selectOption(template.revisions[0]!.id);
  await page.getByRole("button", { name: "Use Revision 1", exact: true }).click();
  await expect(page.getByLabel("State text")).toHaveValue("{{ticket}}");
  await expect(page.getByLabel("{{ticket}}", { exact: true })).toHaveValue("Default ticket");
  const pin = page.getByRole("region", { name: "Saved decision prompt" });
  await expect(pin).toContainText("No System One connection on this device matches Default connection");
  await expect(pin).toContainText("recommended-model");
  await expect(page.getByRole("button", { name: /^Run decision/ })).toBeDisabled();
});
