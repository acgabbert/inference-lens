import { readFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import { PROJECT_SCHEMA_VERSION, createProjectFile, serializeProjectFile } from "../../packages/core/src/project";
import type { ProjectFile } from "../../packages/core/src/project";
import { resolveProviderCapabilities } from "../../packages/core/src/types";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  SYSTEM_ONE_FIXTURE_ORIGIN,
  seedProfiles,
  stubProjectDirectory,
  waitForHydration,
} from "./support";

/**
 * Project-owned decision requests (System One D38–D43) against the capture
 * replay. The replay refuses any questions but the captured ones, so a
 * variable in an instruction answers only when its resolved text reaches the
 * wire exactly.
 */

const captured = JSON.parse(
  readFileSync(new URL("../fixtures/system-one/llamacpp-all-types.json", import.meta.url), "utf8"),
).request as { state: { ticket: string; plan: string }; questions: Record<string, { instructions: unknown }> };

const INTENT_INSTRUCTIONS = captured.questions.intent!.instructions as string;

/** The captured request with variables in the state and one instruction. */
const templated = {
  state: { ticket: "{{ticket}}", plan: "{{plan}}" },
  questions: {
    ...captured.questions,
    intent: { ...captured.questions.intent, instructions: "{{intent_question}}" },
  },
};

function emptyProject(): string {
  return serializeProjectFile(createProjectFile({
    name: "Decision requests",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "fixture-model",
      messages: [{ role: "user", content: "Hello" }],
      capabilities: resolveProviderCapabilities("openai-compatible"),
    },
    idSuffix: "decision-requests",
    createdAt: "2026-10-24T12:00:00.000Z",
  }));
}

async function openFolder(page: Page, projectJson: string): Promise<void> {
  await seedProfiles(page, [
    { id: "buffered", instanceId: "buffered-instance", name: "Buffered fixture", endpoint: BUFFERED_FIXTURE_ENDPOINT },
    {
      id: "decisions",
      instanceId: "decisions-instance",
      name: "Decision fixture",
      endpoint: `${SYSTEM_ONE_FIXTURE_ORIGIN}/llamacpp/v1`,
      model: "unused-chat-model",
      systemOne: true,
    },
  ], "buffered");
  await stubProjectDirectory(page, { name: "decision-requests.inference-lens", files: { "project.json": projectJson } });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project folder…" }).click();
  await expect(page.locator(".brand")).toContainText("Decision requests");
  await page.getByRole("radio", { name: "Decision" }).click();
}

function decisionPane(page: Page) {
  return page.getByRole("region", { name: "Decision request" });
}

/** project.json as the app last wrote it into the stubbed folder. */
async function savedProject(page: Page): Promise<ProjectFile> {
  const text = await page.evaluate(async () => {
    const root = await (window as unknown as { showDirectoryPicker(): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker();
    const file = await (await root.getFileHandle("project.json")).getFile();
    return file.text();
  });
  return JSON.parse(text) as ProjectFile;
}

async function waitForSavedRevisions(page: Page, count: number): Promise<ProjectFile> {
  await expect.poll(async () => (await savedProject(page)).decisionRequestRevisions?.length ?? 0).toBe(count);
  return savedProject(page);
}

test("a decision request saves into the project, resolves its variables on the wire, and reopens", async ({ page, browser }) => {
  await openFolder(page, emptyProject());
  const pane = decisionPane(page);
  await pane.getByRole("tab", { name: "JSON" }).first().click();
  await page.getByLabel("Decision input (state and questions)").fill(JSON.stringify(templated, null, 2));
  const model = pane.getByRole("combobox", { name: "Model" });
  await model.fill("all-types");
  await model.press("Escape");

  // Each variable gets a field; an unfilled one blocks Run and says which.
  const variables = pane.getByRole("region", { name: "Variables" });
  await expect(variables.getByRole("textbox")).toHaveCount(3);
  const run = page.getByRole("button", { name: /^Run decision/ });
  await expect(run).toBeDisabled();
  await expect(pane).toContainText('Template variable "ticket" has no value.');

  await variables.getByLabel("{{ticket}}").fill(captured.state.ticket);
  await variables.getByLabel("{{plan}}").fill(captured.state.plan);
  await variables.getByLabel("{{intent_question}}").fill(INTENT_INSTRUCTIONS);
  await expect(run).toBeEnabled();
  await run.click();

  // The replay answered, so the resolved questions matched the capture.
  await expect(page.getByRole("article", { name: "Answer intent" })).toContainText("Choice billing");
  const evidence = page.getByRole("region", { name: "Decision evidence" });
  await expect(evidence).toContainText("charged twice for October");
  await expect(evidence).not.toContainText("{{ticket}}");

  // The project keeps the authored request, in authored order, and its values.
  const saved = await waitForSavedRevisions(page, 1);
  expect(saved.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
  const revision = saved.decisionRequestRevisions[0]!;
  expect(saved.defaults.decisionRequestRevisionId).toBe(revision.id);
  expect(saved.decisionRequests).toEqual([{ id: revision.decisionRequestId, name: "Decision request" }]);
  expect(revision.decision).toEqual(templated);
  expect(Object.keys(revision.decision.questions)).toEqual(["intent", "severity", "is_spam"]);
  expect(revision.values).toEqual({ ticket: captured.state.ticket, plan: captured.state.plan, intent_question: INTENT_INSTRUCTIONS });

  // Reopened elsewhere, the request and its values come back, and the
  // revision loaded from disk is not edited in place: an edit appends a child.
  const reopened = await browser.newPage();
  await openFolder(reopened, `${JSON.stringify(saved, null, 2)}\n`);
  const reopenedVariables = decisionPane(reopened).getByRole("region", { name: "Variables" });
  await expect(reopenedVariables.getByLabel("{{plan}}")).toHaveValue(captured.state.plan);
  await reopenedVariables.getByLabel("{{plan}}").fill("enterprise");
  const branched = await waitForSavedRevisions(reopened, 2);
  const child = branched.decisionRequestRevisions[1]!;
  expect(child.parentRevisionId).toBe(revision.id);
  expect(branched.defaults.decisionRequestRevisionId).toBe(child.id);
  expect(child.values.plan).toBe("enterprise");
  expect(branched.decisionRequestRevisions[0]!.values.plan).toBe(captured.state.plan);
  await reopened.close();
});

test("an invalid draft is not written to the project, and says so", async ({ page }) => {
  await openFolder(page, emptyProject());
  const pane = decisionPane(page);
  await pane.getByRole("tab", { name: "JSON" }).first().click();
  await page.getByLabel("Decision input (state and questions)").fill(JSON.stringify(templated, null, 2));
  await waitForSavedRevisions(page, 1);

  await page.getByLabel("Decision input (state and questions)").fill("{ not json");
  await expect(pane.getByRole("status").filter({ hasText: "Not saved to the project" })).toBeVisible();
  // The project keeps its last valid request.
  await page.waitForTimeout(1500);
  const saved = await savedProject(page);
  expect(saved.decisionRequestRevisions).toHaveLength(1);
  expect(saved.decisionRequestRevisions[0]!.decision).toEqual(templated);
});

test("an invalid decision draft stays unsaved after autosave and protects project replacement", async ({ page }) => {
  await openFolder(page, emptyProject());
  const pane = decisionPane(page);
  await pane.getByRole("tab", { name: "JSON" }).first().click();
  const editor = page.getByLabel("Decision input (state and questions)");
  await editor.fill(JSON.stringify(templated));
  const saved = await waitForSavedRevisions(page, 1);
  await expect(page.locator(".brand")).not.toContainText("Unsaved");

  const unfinished = '{"state": "An important unfinished edit",';
  await editor.fill(unfinished);
  await expect(pane).toContainText("Not saved to the project");
  // Wait beyond the workspace's debounce: writing the last valid request
  // must not make the unfinished draft look saved or remove its guard.
  await page.waitForTimeout(1600);
  expect(await page.locator(".brand").innerText()).toContain("Unsaved");
  expect((await savedProject(page)).decisionRequestRevisions).toEqual(saved.decisionRequestRevisions);
  expect(await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  })).toBe(true);

  const replacement = { ...JSON.parse(emptyProject()), name: "Replacement project" };
  async function requestReplacement() {
    await page.getByLabel("Project menu").click();
    await page.setInputFiles('.project-popover:not(.run-data-popover) input[type="file"]', {
      name: "replacement.project.json", mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(replacement)),
    });
  }
  await requestReplacement();
  const dialog = page.getByRole("dialog", { name: "Save changes before switching projects?" });
  await dialog.getByRole("button", { name: "Save and switch", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("decision request");
  await expect(page.locator(".brand")).toContainText("Decision requests");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(editor).toHaveValue(unfinished);
  await page.locator('[data-app-banner="project-error"]').getByRole("button", { name: "Dismiss", exact: true }).click();

  // A manual save cannot clear the guard either.
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Save now" }).click();
  await expect(page.locator('[data-app-banner="project-error"]')).toContainText("Fix the decision request before saving.");
  await expect(editor).toHaveValue(unfinished);
  await expect(page.locator(".brand")).toContainText("Unsaved");

  await requestReplacement();
  await dialog.getByRole("button", { name: "Discard and switch", exact: true }).click();
  await expect(page.locator(".brand")).toContainText("Replacement project");
});

test("fixing an incomplete decision request saves it and clears replacement protection", async ({ page }) => {
  await openFolder(page, emptyProject());
  const pane = decisionPane(page);
  await pane.getByRole("tab", { name: "JSON" }).first().click();
  const editor = page.getByLabel("Decision input (state and questions)");
  await editor.fill('{"state":');
  await page.waitForTimeout(1600);
  await editor.fill(JSON.stringify(templated));
  await waitForSavedRevisions(page, 1);
  await expect(page.locator(".brand")).not.toContainText("Unsaved");
  await expect(page.locator(".brand")).toContainText("Saved to");
  await expect(pane).not.toContainText("Not saved to the project");

  // A manual save after repairing the draft must clear the retained unsaved
  // marker, even if it wins the race with the next autosave timer.
  await editor.fill('{"state":');
  await page.waitForTimeout(1600);
  const repaired = { ...templated, state: "Repaired before a manual save" };
  await editor.fill(JSON.stringify(repaired));
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Save now" }).click();
  await expect.poll(async () => (await savedProject(page)).decisionRequestRevisions[0]!.decision.state).toBe(repaired.state);
  await expect(page.locator(".brand")).not.toContainText("Unsaved");
  await expect(page.locator(".brand")).toContainText("Saved to");
});

test("an untouched starting draft never creates a request", async ({ page }) => {
  await openFolder(page, emptyProject());
  await page.getByRole("radio", { name: "Chat" }).click();
  await page.getByLabel("Message 1 content").fill("A chat edit that saves the project.");
  await expect.poll(async () => JSON.stringify((await savedProject(page)).conversationRevisions)).toContain("A chat edit that saves the project.");
  expect((await savedProject(page)).decisionRequests).toEqual([]);
});
