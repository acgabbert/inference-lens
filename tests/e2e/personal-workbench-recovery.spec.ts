/**
 * Shared assets 2b step 6b-2, behind the gate (D2): the Recovery chip opens one
 * drawer that lists what needs a decision, the Templates and Request panes
 * mark the affected assets, and every action reaches the folder
 * (docs/SHARED_ASSETS_LEVEL_TWO_DESIGN.md, "Step 6b-2 decisions").
 */
import { readFileSync } from "node:fs";
import type { Page } from "./support/test";

import { expect, test } from "./support/test";
import {
  createProjectFile,
  createPromptTemplate,
  serializeProjectFile,
} from "../../packages/core/src/project";
import type { ProjectFile } from "../../packages/core/src/project";
import { createDecisionPromptTemplate } from "../../packages/core/src/decision-template";
import type { DecisionInput } from "../../packages/core/src/decision";
import { parseWorkbenchRecord, serializeWorkbenchRecord } from "../../packages/core/src/personal-workbench";
import type { WorkbenchRecordV1 } from "../../packages/core/src/personal-workbench";
import { planSharedProjectMigration } from "../../packages/core/src/shared-project-migration";
import { serializeProjectManifest } from "../../app/workbench/project-manifest";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  openMode,
  seedProfile,
  stubProjectDirectory,
  waitForHydration,
} from "./support";

test.use({ personalWorkbench: true });

function fixtureProject(): ProjectFile {
  return createPromptTemplate(createProjectFile({
    name: "Recovery fixture",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Hello" }],
    },
    idSuffix: "recovery",
    createdAt: "2026-11-05T12:00:00.000Z",
  }), {
    name: "Incident triage",
    messages: [{ role: "user", content: "Triage {{incident}}." }],
    variableDefaults: { incident: "timeout" },
    idSuffix: "triage",
    revisionIdSuffix: "triage-1",
    createdAt: "2026-11-05T12:00:01.000Z",
  });
}

function promptDraft(project: ProjectFile, draftId: string, content: string): WorkbenchRecordV1 {
  const template = project.promptTemplates[0]!;
  const revision = template.revisions[0]!;
  return parseWorkbenchRecord({
    schemaVersion: 1,
    kind: "draft",
    projectId: project.projectId,
    draftId,
    asset: { kind: "chat-prompt", id: template.id },
    base: { revisionId: revision.id, snapshot: revision },
    edited: { messages: [{ role: "user", content }], variableDefaults: { incident: "timeout" } },
  }, project.projectId);
}

const captured = JSON.parse(
  readFileSync(new URL("../fixtures/system-one/llamacpp-all-types.json", import.meta.url), "utf8"),
).request as { questions: DecisionInput["questions"] };

function decisionFixtureProject(): ProjectFile {
  return createDecisionPromptTemplate(fixtureProject(), {
    name: "Ticket decision",
    decision: { state: "{{ticket}}", questions: captured.questions } as DecisionInput,
    variableDefaults: { ticket: "Default ticket" },
    idSuffix: "ticket-decision",
  });
}

function decisionPromptDraft(project: ProjectFile, draftId: string, state: string): WorkbenchRecordV1 {
  const template = project.promptTemplates.find(({ kind }) => kind === "decision")!;
  const revision = template.revisions[0]!;
  return parseWorkbenchRecord({
    schemaVersion: 1,
    kind: "draft",
    projectId: project.projectId,
    draftId,
    asset: { kind: "decision-prompt", id: template.id },
    base: { revisionId: revision.id, snapshot: revision },
    edited: { decision: { state, questions: captured.questions }, variableDefaults: { ticket: "Default ticket" } },
  }, project.projectId);
}

/** A request draft whose base revision is not in the project (V4: orphaned). */
function orphanedRequestDraft(project: ProjectFile): WorkbenchRecordV1 {
  const revision = project.conversationRevisions[0]!;
  return parseWorkbenchRecord({
    schemaVersion: 1,
    kind: "draft",
    projectId: project.projectId,
    draftId: "draft_orphan",
    asset: { kind: "chat-request", id: revision.conversationId },
    base: { revisionId: "revision_gone", snapshot: { ...structuredClone(revision), id: "revision_gone" } },
    edited: { items: structuredClone(revision.items) },
  }, project.projectId);
}

/** Every file under the stubbed folder, by relative path. */
async function folderFiles(page: Page): Promise<Record<string, string>> {
  return page.evaluate(async () => {
    const root = await (window as unknown as {
      showDirectoryPicker(): Promise<import("../../app/project-directory.client").FileSystemDirectoryHandleLike>;
    }).showDirectoryPicker();
    const files: Record<string, string> = {};
    const read = async (dir: typeof root, prefix: string) => {
      for await (const entry of dir.values()) {
        if (entry.kind === "directory") await read(entry, `${prefix}${entry.name}/`);
        else files[`${prefix}${entry.name}`] = await (await entry.getFile()).text();
      }
    };
    await read(root, "");
    return files;
  });
}

async function openFolder(page: Page, files: Record<string, string>): Promise<void> {
  await seedProfile(page, { instanceId: "profile-instance-buffered" });
  await stubProjectDirectory(page, { name: "recovery-fixture", files });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project folder…" }).click();
  await expect(page.locator(".brand")).toContainText("Recovery fixture");
}

const chip = (page: Page) => page.locator(".header-actions").getByRole("button", { name: /^(Recovery · \d+|Migration backup)$/ });
const drawer = (page: Page) => page.getByRole("dialog", { name: "Recovery" });
const filesUnder = (files: Record<string, string>, prefix: string) =>
  Object.entries(files).filter(([path]) => path.startsWith(prefix));

test("a competing prompt draft is marked, compared, used and its replaced copy discarded", async ({ page }) => {
  const project = fixtureProject();
  const first = promptDraft(project, "draft_first", "Triage {{incident}} from the first draft.");
  const second = promptDraft(project, "draft_second", "Triage {{incident}} from the second draft.");
  await openFolder(page, {
    "project.json": serializeProjectManifest(project, "personal"),
    ".workbench/.gitignore": "*\n",
    ".workbench/drafts/draft_first.json": serializeWorkbenchRecord(first),
    ".workbench/drafts/draft_second.json": serializeWorkbenchRecord(second),
  });
  await expect(chip(page)).toHaveText("Recovery · 1");

  // X3: the list row is marked, and the editor links to the drawer.
  await openMode(page, "Prompts");
  await expect(page.locator(".template-list-item").filter({ hasText: "Incident triage" })).toContainText("Needs recovery");
  const editor = page.locator(".template-editor");
  const active = await editor.getByLabel("Prompt content").inputValue();
  const competing = [first, second].map((record) => (record as { edited: { messages: { content: string }[] } }).edited.messages[0]!.content)
    .find((content) => content !== active)!;
  await editor.getByRole("status").filter({ hasText: "Needs recovery" }).getByRole("button", { name: "Open Recovery" }).click();

  const panel = drawer(page);
  await expect(panel).toBeVisible();
  const item = panel.getByRole("article", { name: "Prompt “Incident triage”" });
  await expect(item).toContainText("Competing draft");

  // X2: Compare shows the two copies as a line diff.
  await item.getByRole("button", { name: "Compare" }).click();
  const comparison = item.getByRole("region", { name: "Comparison" });
  await expect(comparison.locator(".diff-line.removed")).toContainText([active]);
  await expect(comparison.locator(".diff-line.added")).toContainText([competing]);

  // Use this one: the competing draft becomes active and the one it replaced is kept (W1).
  await item.getByRole("button", { name: "Use this one" }).click();
  await expect(editor.getByLabel("Prompt content")).toHaveValue(competing);
  const replaced = panel.getByRole("article", { name: "Prompt “Incident triage”" });
  await expect(replaced).toContainText("Replaced draft");
  await expect.poll(async () => filesUnder(await folderFiles(page), ".workbench/replaced/").length).toBe(1);

  // X4: discarding the replaced copy deletes the only copy, so it asks first.
  await replaced.getByRole("button", { name: "Discard" }).click();
  const confirm = page.getByRole("dialog", { name: "Discard Prompt “Incident triage”?" });
  await expect(confirm).toContainText("The replaced draft is deleted");
  await confirm.getByRole("button", { name: "Discard" }).click();
  await expect(panel.getByRole("article")).toHaveCount(0);
  await expect(panel).toContainText("Nothing needs recovery.");
  await expect.poll(async () => filesUnder(await folderFiles(page), ".workbench/replaced/").length).toBe(0);
  await expect(chip(page)).toHaveCount(0);
  await expect(page.locator(".template-list-item").filter({ hasText: "Incident triage" })).not.toContainText("Needs recovery");
  const drafts = filesUnder(await folderFiles(page), ".workbench/drafts/");
  expect(drafts.map(([, contents]) => JSON.parse(contents).edited.messages[0].content)).toEqual([competing]);
});

test("Use this one on a decision prompt shows the chosen draft, not the session's earlier edit", async ({ page }) => {
  const project = decisionFixtureProject();
  const first = decisionPromptDraft(project, "draft_first", "{{ticket}} from the first draft");
  const second = decisionPromptDraft(project, "draft_second", "{{ticket}} from the second draft");
  await openFolder(page, {
    "project.json": serializeProjectManifest(project, "personal"),
    ".workbench/.gitignore": "*\n",
    ".workbench/drafts/draft_first.json": serializeWorkbenchRecord(first),
    ".workbench/drafts/draft_second.json": serializeWorkbenchRecord(second),
  });
  await expect(chip(page)).toHaveText("Recovery · 1");

  await openMode(page, "Prompts");
  await page.locator(".template-list").getByRole("button", { name: /Ticket decision/ }).click();
  const editor = page.locator(".decision-template-editor");
  const state = editor.getByLabel("State text");
  const active = await state.inputValue();
  const competing = [first, second].map((record) => (record as { edited: { decision: { state: string } } }).edited.decision.state)
    .find((content) => content !== active)!;
  expect(competing).toBeDefined();

  // An edit in this session: the editor remembers it above its mount.
  await state.fill("{{ticket}} edited in this session");
  await expect.poll(async () => Object.values(await folderFiles(page))
    .some((contents) => contents.includes("edited in this session"))).toBe(true);

  await editor.getByRole("status").filter({ hasText: "Needs recovery" }).getByRole("button", { name: "Open Recovery" }).click();
  const item = drawer(page).getByRole("article", { name: "Decision prompt “Ticket decision”" });
  await expect(item).toContainText("Competing draft");
  await item.getByRole("button", { name: "Use this one" }).click();
  await expect(drawer(page).getByRole("article", { name: "Decision prompt “Ticket decision”" })).toContainText("Replaced draft");

  // The editor shows the draft Recovery activated, and a later edit builds on it.
  await expect(state).toHaveValue(competing);
  // The remounted editor does not autosave the session's edit back over it.
  await expect.poll(async () => filesUnder(await folderFiles(page), ".workbench/drafts/")
    .map(([, contents]) => (JSON.parse(contents) as { edited: { decision: { state: string } } }).edited.decision.state)).toEqual([competing]);
});

test("settling an unrelated item keeps an open prompt editor's revision rename", async ({ page }) => {
  const project = fixtureProject();
  await openFolder(page, {
    "project.json": serializeProjectManifest(project, "personal"),
    ".workbench/.gitignore": "*\n",
    ".workbench/drafts/draft_orphan.json": serializeWorkbenchRecord(orphanedRequestDraft(project)),
  });
  await expect(chip(page)).toHaveText("Recovery · 1");

  await openMode(page, "Prompts");
  const editor = page.locator(".template-editor");
  await editor.getByRole("button", { name: "Rename revision" }).click();
  await editor.getByLabel("New revision name").fill("Tightened triage");

  await chip(page).click();
  const item = drawer(page).getByRole("article");
  await expect(item).toContainText("Base no longer exists");
  await item.getByRole("button", { name: "Discard" }).click();
  await page.getByRole("dialog", { name: /^Discard / }).getByRole("button", { name: "Discard" }).click();
  await expect(drawer(page)).toContainText("Nothing needs recovery.");

  await expect(editor.getByLabel("New revision name")).toHaveValue("Tightened triage");
});

test("an orphaned request draft is marked in the switcher and saved as a new request", async ({ page }) => {
  const project = fixtureProject();
  await openFolder(page, {
    "project.json": serializeProjectManifest(project, "personal"),
    ".workbench/.gitignore": "*\n",
    ".workbench/drafts/draft_orphan.json": serializeWorkbenchRecord(orphanedRequestDraft(project)),
  });
  await expect(chip(page)).toHaveText("Recovery · 1");

  const composer = page.getByRole("region", { name: "Request composer" });
  const request = composer.getByRole("combobox", { name: "Request", exact: true });
  await expect(request.locator("option", { hasText: "needs recovery" })).toHaveCount(1);
  await expect(composer.getByRole("status").filter({ hasText: "Needs recovery" })).toBeVisible();

  await chip(page).click();
  const item = drawer(page).getByRole("article");
  await expect(item).toContainText("Base no longer exists");
  await item.getByRole("button", { name: "Save as new…" }).click();
  await item.getByRole("textbox", { name: "Name" }).fill("Recovered request");
  await item.getByRole("button", { name: "Save", exact: true }).click();

  await expect(drawer(page)).toContainText("Nothing needs recovery.");
  await expect(chip(page)).toHaveCount(0);
  await expect.poll(async () => {
    const saved = JSON.parse((await folderFiles(page))["project.json"]!) as ProjectFile;
    return saved.conversations.map(({ name }) => name);
  }).toContain("Recovered request");
  // The orphaned draft's file goes once its debounced deletion lands.
  await expect.poll(async () => filesUnder(await folderFiles(page), ".workbench/drafts/")).toEqual([]);
});

test("a migration candidate is discarded at once and its backup removed after a confirmation", async ({ page }) => {
  // A v18 folder whose personal selections already exist: the upgrade's own
  // selections stay a pending candidate (W2: Compare and Discard only).
  const legacy = fixtureProject();
  const manifest = serializeProjectFile(legacy);
  const { selections } = planSharedProjectMigration(new TextEncoder().encode(manifest));
  selections.chat!.execution!.target!.model = "existing-personal-model";
  await openFolder(page, {
    "project.json": manifest,
    ".workbench/.gitignore": "*\n",
    ".workbench/selections.json": serializeWorkbenchRecord(selections),
  });
  await page.getByRole("button", { name: "Upgrade project…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Upgrade", exact: true }).click();
  await expect(page.locator(".brand")).toContainText("Saved to recovery-fixture");
  await expect(chip(page)).toHaveText("Recovery · 1");

  await chip(page).click();
  const panel = drawer(page);
  const item = panel.getByRole("article", { name: "Your selections" });
  await expect(item).toContainText("Kept by the upgrade");
  await expect(item.getByRole("button", { name: "Use this one" })).toHaveCount(0);
  // X4: the backup keeps the candidate, so Discard does not ask.
  await item.getByRole("button", { name: "Discard" }).click();
  await expect(page.getByRole("dialog", { name: /^Discard / })).toHaveCount(0);
  await expect(panel.getByRole("article")).toHaveCount(0);
  await expect(chip(page)).toHaveText("Migration backup");

  // W3: the confirmation lists what is deleted.
  await panel.getByRole("button", { name: "Remove migration backup…" }).click();
  const confirm = page.getByRole("dialog", { name: "Remove this migration backup?" });
  await expect(confirm).toContainText("source.project.json");
  await confirm.getByRole("button", { name: "Remove backup" }).click();
  await expect.poll(async () => filesUnder(await folderFiles(page), ".workbench/migrations/").length).toBe(0);
  await expect(chip(page)).toHaveCount(0);
  expect(JSON.parse((await folderFiles(page))[".workbench/selections.json"]!).chat.execution.target.model).toBe("existing-personal-model");
});
