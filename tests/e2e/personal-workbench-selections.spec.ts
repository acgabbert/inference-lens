/**
 * Shared assets 2b step 5, behind the gate (D2): the request switcher moves
 * only the personal selection, model and environment choices are sparse
 * overrides in `.workbench/selections.json`, and only "Use as launch default"
 * writes `defaults` (docs/SHARED_ASSETS_LEVEL_TWO_DESIGN.md, "Step 5
 * decisions").
 */
import type { Page } from "./support/test";

import { expect, test } from "./support/test";
import { createEntityId } from "../../packages/core/src/run-kernel/types";
import type { EnvironmentId } from "../../packages/core/src/run-kernel/types";
import { createProjectFile, parseProjectFile } from "../../packages/core/src/project";
import type { ProjectFile } from "../../packages/core/src/project";
import { resolveProviderCapabilities } from "../../packages/core/src/types";
import { serializeWorkbenchRecord } from "../../packages/core/src/personal-workbench";
import { serializeProjectManifest } from "../../app/workbench/project-manifest";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  PROJECT_PROFILE_MAP_STORAGE_KEY,
  seedProfile,
  stubProjectDirectory,
  waitForHydration,
} from "./support";

test.use({ personalWorkbench: true });

const SECOND_TEXT = "What is 5 + 5?";
const staging = createEntityId("environment", "staging") as EnvironmentId;
const live = createEntityId("environment", "live") as EnvironmentId;

/** A chat request with two saved revisions, the first of them the launch default, and two decision revisions. */
function fixtureProject(): ProjectFile {
  const project = createProjectFile({
    name: "Personal selections fixture",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "What is 2 + 2?" }],
      capabilities: resolveProviderCapabilities("openai-compatible"),
    },
    idSuffix: "personal-selections",
    createdAt: "2026-11-04T12:00:00.000Z",
  });
  const launch = project.conversationRevisions[0]!;
  const decisionRequestId = createEntityId("decision-request", "routing");
  const decision = (question: string) => ({
    state: "Subject: Printer jam",
    questions: { spam: { type: "noul", instructions: question, criteria: { true: "Spam", false: "Genuine" } } },
  });
  return parseProjectFile({
    ...project,
    conversationRevisions: [...project.conversationRevisions, {
      id: createEntityId("revision", "second"),
      conversationId: launch.conversationId,
      parentRevisionId: launch.id,
      createdAt: "2026-11-04T13:00:00.000Z",
      items: [{ kind: "message", message: { id: createEntityId("message", "second"), role: "user", content: [{ type: "text", text: SECOND_TEXT }] } }],
    }],
    environments: [{ id: staging, name: "Staging", entries: [] }, { id: live, name: "Live", entries: [] }],
    decisionRequests: [{ id: decisionRequestId, name: "Ticket routing" }],
    decisionRequestRevisions: [
      { id: createEntityId("decision-revision", "first"), decisionRequestId, kind: "inline", decision: decision("First question"), values: {}, createdAt: "2026-11-04T12:00:00.000Z" },
      { id: createEntityId("decision-revision", "second"), decisionRequestId, kind: "inline", decision: decision("Second question"), values: {}, createdAt: "2026-11-04T13:00:00.000Z" },
    ],
    defaults: { ...project.defaults, environmentId: staging, decisionRequestRevisionId: createEntityId("decision-revision", "second") },
  });
}

async function openFolder(page: Page, project: ProjectFile, manifest: string, extraFiles: Record<string, string> = {}): Promise<void> {
  const instanceId = "profile-instance-buffered";
  await seedProfile(page, { endpoint: BUFFERED_FIXTURE_ENDPOINT, instanceId });
  await page.addInitScript(({ mapKey, projectId, instanceId }) => {
    localStorage.setItem(mapKey, JSON.stringify({ [projectId]: { profileId: "buffered", profileInstanceId: instanceId } }));
  }, { mapKey: PROJECT_PROFILE_MAP_STORAGE_KEY, projectId: project.projectId, instanceId });
  await stubProjectDirectory(page, { name: "personal-selections", files: { "project.json": manifest, ...extraFiles }, directories: ["traces"] });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project folder…" }).click();
  await expect(page.locator(".brand")).toContainText("Personal selections fixture");
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

async function selections(page: Page): Promise<{ chat?: Record<string, unknown>; decision?: Record<string, unknown> } | undefined> {
  const text = (await folderFiles(page))[".workbench/selections.json"];
  return text ? JSON.parse(text) : undefined;
}

async function shared(page: Page): Promise<ProjectFile> {
  return JSON.parse((await folderFiles(page))["project.json"]!);
}

const composer = (page: Page) => page.getByRole("region", { name: "Request composer" });
const personalChip = (scope: ReturnType<Page["getByRole"]>) => scope.getByRole("status").filter({ hasText: "Personal settings" });

test("the switcher selects a saved revision personally; only Use as launch default writes defaults", async ({ page }) => {
  const project = fixtureProject();
  const [launch, second] = project.conversationRevisions;
  const manifest = serializeProjectManifest(project, "personal");
  await openFolder(page, project, manifest);

  const pane = composer(page);
  await expect(pane.getByRole("combobox", { name: "Request", exact: true })).toHaveValue(`request:${launch!.conversationId}`);
  const revision = pane.getByRole("combobox", { name: "Revision", exact: true });
  await expect(revision).toHaveValue(launch!.id);
  await expect(personalChip(pane)).toHaveCount(0);

  await revision.selectOption({ label: "Revision 2" });
  await expect(page.getByLabel("Message 1 content")).toHaveValue(SECOND_TEXT);
  await expect.poll(async () => (await selections(page))?.chat?.selectedInput)
    .toEqual({ kind: "saved-conversation-revision", revisionId: second!.id });
  expect((await folderFiles(page))["project.json"]).toBe(manifest);
  const chip = personalChip(pane);
  await expect(chip).toContainText("Your request differs from the project's launch default");

  await chip.getByRole("button", { name: "Use as launch default…" }).click();
  const dialog = page.getByRole("dialog", { name: "Use as project launch default?" });
  await expect(dialog).toContainText("Main conversation, revision 1 → Main conversation, revision 2");
  await dialog.getByRole("button", { name: "Use as launch default" }).click();
  await expect.poll(async () => (await shared(page)).defaults.conversationRevisionId).toBe(second!.id);
  await expect(chip).toHaveCount(0);
  await expect(revision.locator("option:checked")).toHaveText("Revision 2 (launch default)");
});

test("model and environment choices are sparse personal overrides read back on open", async ({ page }) => {
  const project = fixtureProject();
  const manifest = serializeProjectManifest(project, "personal");
  await openFolder(page, project, manifest, {
    ".workbench/selections.json": serializeWorkbenchRecord({
      schemaVersion: 1, kind: "selections", projectId: project.projectId,
      chat: { execution: { target: { model: "seeded-model" } } },
    }),
  });
  const pane = composer(page);
  const model = pane.getByRole("combobox", { name: /^Model/ });
  await expect(model).toHaveValue("seeded-model");
  const chip = personalChip(pane);
  await expect(chip).toContainText("Your model differs");

  await pane.getByLabel("Environment").selectOption({ label: "Live" });
  await expect.poll(async () => (await selections(page))?.chat?.execution)
    .toEqual({ target: { model: "seeded-model" }, environmentId: live });
  // Environment keeps its own default (D13), so the chip still names only the model.
  await expect(chip).toContainText("Your model differs");

  // T2: back to the launch default clears the override.
  await model.fill("buffered-test-model");
  await model.press("Escape");
  await expect.poll(async () => (await selections(page))?.chat?.execution).toEqual({ environmentId: live });
  await expect(chip).toHaveCount(0);
  expect((await folderFiles(page))["project.json"]).toBe(manifest);
});

test("the decision switcher moves the decision selection, and its launch action writes only the pin", async ({ page }) => {
  const project = fixtureProject();
  const [first] = project.decisionRequestRevisions;
  await openFolder(page, project, serializeProjectManifest(project, "personal"));
  await page.getByRole("radio", { name: "Decision" }).click();
  const pane = page.getByRole("region", { name: "Decision request" });
  const revision = pane.getByRole("combobox", { name: "Revision", exact: true });
  await expect(revision.locator("option:checked")).toHaveText("Revision 2 (launch default)");

  await revision.selectOption({ label: "Revision 1" });
  await expect.poll(async () => (await selections(page))?.decision?.selectedInput)
    .toEqual({ kind: "saved-decision-request-revision", revisionId: first!.id });
  await expect.poll(async () => (await selections(page))?.chat).toBeUndefined();
  // The editor loads the selected revision, and switching is no edit.
  await expect(pane.getByRole("textbox", { name: "Instructions" }).first()).toHaveValue("First question");
  expect(Object.keys(await folderFiles(page)).filter((path) => path.startsWith(".workbench/drafts/"))).toEqual([]);
  const chip = personalChip(pane);
  await expect(chip).toContainText("Your decision request differs");

  const before = await shared(page);
  await chip.getByRole("button", { name: "Use as launch default…" }).click();
  await page.getByRole("dialog", { name: "Use as decision launch default?" }).getByRole("button", { name: "Use as launch default" }).click();
  await expect.poll(async () => (await shared(page)).defaults.decisionRequestRevisionId).toBe(first!.id);
  const after = await shared(page);
  expect({ ...after.defaults, decisionRequestRevisionId: before.defaults.decisionRequestRevisionId }).toEqual(before.defaults);
  await expect(chip).toHaveCount(0);
});

test("edits made during launch-default save survive completion", async ({ page }) => {
  const project = fixtureProject();
  await openFolder(page, project, serializeProjectManifest(project, "personal"));
  const pane = composer(page);
  const model = pane.getByRole("combobox", { name: /^Model/ });
  await model.fill("model-to-publish");
  await model.press("Escape");
  await page.evaluate(async () => {
    const w = window as unknown as {
      showDirectoryPicker(): Promise<import("../../app/project-directory.client").FileSystemDirectoryHandleLike>;
      launchWriteWaiting?: boolean;
      releaseLaunchWrite?: () => void;
    };
    const dir = await w.showDirectoryPicker();
    const file = await dir.getFileHandle("project.json");
    const original = file.createWritable.bind(file);
    file.createWritable = async () => {
      const writable = await original();
      const close = writable.close.bind(writable);
      writable.close = async () => {
        w.launchWriteWaiting = true;
        await new Promise<void>((resolve) => { w.releaseLaunchWrite = resolve; });
        await close();
      };
      return writable;
    };
  });
  await personalChip(pane).getByRole("button", { name: "Use as launch default…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Use as launch default", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { launchWriteWaiting?: boolean }).launchWriteWaiting)).toBe(true);
  await model.fill("new-personal-model");
  await model.press("Escape");
  await expect(model).toHaveValue("new-personal-model");
  await page.evaluate(() => (window as unknown as { releaseLaunchWrite(): void }).releaseLaunchWrite());
  await expect.poll(async () => (await shared(page)).defaults.target.model).toBe("model-to-publish");
  await expect(personalChip(pane).getByRole("button", { name: "Saving…" })).toHaveCount(0);
  await expect(model).toHaveValue("new-personal-model");
  await expect.poll(async () => (await selections(page))?.chat?.execution)
    .toEqual({ target: { model: "new-personal-model" } });
});
