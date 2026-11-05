import { inlineRevision } from "../project-kind-helpers";
import { readFileSync } from "node:fs";

import { expect, test, type Page } from "./support/test";

import { createProjectFile } from "../../packages/core/src/project";
import type { ProjectFile } from "../../packages/core/src/project";
import { resolveProviderCapabilities } from "../../packages/core/src/types";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  SYSTEM_ONE_FIXTURE_ORIGIN,
  seedProfiles,
  serializeFolderProject,
  stubProjectDirectory,
  waitForHydration,
} from "./support";

/**
 * Project-owned decision requests (System One D38–D43) against the capture
 * replay. The replay refuses any questions but the captured ones, so a
 * variable in an instruction answers only when its resolved text reaches the
 * wire exactly.
 *
 * A new decision request is a local scratch until Save names it (2b step 4,
 * Q2); `personal-workbench-decision-drafts.spec.ts` covers its records.
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
  return serializeFolderProject(createProjectFile({
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

/** Saves the local decision request into project.json under its suggested name. */
async function saveAsRequest(page: Page): Promise<void> {
  const pane = decisionPane(page);
  await pane.getByRole("status").filter({ hasText: "Local request" }).getByRole("button", { name: "Save as request…" }).click();
  await expect(pane.getByLabel("Request name")).toHaveValue("Decision request");
  await pane.getByRole("button", { name: "Save", exact: true }).click();
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

  // Saved, the project keeps the authored request, in authored order, and its values.
  await saveAsRequest(page);
  const saved = await waitForSavedRevisions(page, 1);
  expect(saved.schemaVersion).toBe(19);
  const revision = inlineRevision(saved.decisionRequestRevisions[0]!);
  // Save moves the personal selection, never the launch default (D11).
  expect(saved.defaults.decisionRequestRevisionId).toBeUndefined();
  expect(saved.decisionRequests).toEqual([{ id: revision.decisionRequestId, name: "Decision request" }]);
  expect(revision.decision).toEqual(templated);
  expect(Object.keys(revision.decision.questions)).toEqual(["intent", "severity", "is_spam"]);
  expect(revision.values).toEqual({ ticket: captured.state.ticket, plan: captured.state.plan, intent_question: INTENT_INSTRUCTIONS });

  // Reopened elsewhere, the saved request and its values come back from the
  // project once selected.
  const reopened = await browser.newPage();
  await openFolder(reopened, `${JSON.stringify(saved, null, 2)}\n`);
  await decisionPane(reopened).getByRole("combobox", { name: "Decision request", exact: true }).selectOption({ label: "Decision request" });
  const reopenedVariables = decisionPane(reopened).getByRole("region", { name: "Variables" });
  await expect(reopenedVariables.getByLabel("{{plan}}")).toHaveValue(captured.state.plan);
  await reopened.close();
});

test("a variable value keeps its line breaks, as a chat run value does", async ({ page }) => {
  await openFolder(page, emptyProject());
  const pane = decisionPane(page);
  await pane.getByRole("tab", { name: "JSON" }).first().click();
  await page.getByLabel("Decision input (state and questions)").fill(JSON.stringify(templated, null, 2));

  const ticket = pane.getByRole("region", { name: "Variables" }).getByLabel("{{ticket}}");
  const multiline = "Subject: Double charge\n\nI was charged twice for October.\nPlease refund one.";
  await ticket.fill(multiline);
  await expect(ticket).toHaveValue(multiline);
  await saveAsRequest(page);
  const saved = await waitForSavedRevisions(page, 1);
  expect(inlineRevision(saved.decisionRequestRevisions[0]!).values.ticket).toBe(multiline);
});

test("an invalid edit is never saved; the workbench keeps the last valid version", async ({ page }) => {
  await openFolder(page, emptyProject());
  const pane = decisionPane(page);
  await pane.getByRole("tab", { name: "JSON" }).first().click();
  const editor = page.getByLabel("Decision input (state and questions)");
  await editor.fill(JSON.stringify(templated, null, 2));
  await saveAsRequest(page);
  const saved = await waitForSavedRevisions(page, 1);

  const unfinished = '{"state": "An important unfinished edit",';
  await editor.fill(unfinished);
  await expect(pane.getByRole("status").filter({ hasText: "Your workbench keeps its last valid version." })).toBeVisible();
  // The unfinished text stays in the editor; the project keeps its last valid request.
  await page.waitForTimeout(1500);
  await expect(editor).toHaveValue(unfinished);
  expect((await savedProject(page)).decisionRequestRevisions).toEqual(saved.decisionRequestRevisions);
  await expect(page.locator(".brand")).not.toContainText("Unsaved");
});

test("fixing an incomplete decision request lets Save write it", async ({ page }) => {
  await openFolder(page, emptyProject());
  const pane = decisionPane(page);
  await pane.getByRole("tab", { name: "JSON" }).first().click();
  const editor = page.getByLabel("Decision input (state and questions)");
  await editor.fill('{"state":');
  await expect(pane.getByRole("status").filter({ hasText: "Your workbench keeps its last valid version." })).toBeVisible();
  await page.waitForTimeout(1600);
  expect((await savedProject(page)).decisionRequests).toEqual([]);

  const repaired = { ...templated, state: "Repaired before saving" };
  await editor.fill(JSON.stringify(repaired));
  await expect(pane.getByRole("status").filter({ hasText: "Your workbench keeps its last valid version." })).toHaveCount(0);
  await saveAsRequest(page);
  const saved = await waitForSavedRevisions(page, 1);
  expect(inlineRevision(saved.decisionRequestRevisions[0]!).decision.state).toBe(repaired.state);
  await expect(page.locator(".brand")).toContainText("Saved to");
});

test("an untouched starting draft never creates a request", async ({ page }) => {
  await openFolder(page, emptyProject());
  await page.getByRole("radio", { name: "Chat" }).click();
  await page.getByLabel("Message 1 content").fill("A chat edit that saves the project.");
  await page.getByRole("status").filter({ hasText: "Unsaved changes" }).getByRole("button", { name: "Save request" }).click();
  await expect.poll(async () => JSON.stringify((await savedProject(page)).conversationRevisions)).toContain("A chat edit that saves the project.");
  expect((await savedProject(page)).decisionRequests).toEqual([]);
});
