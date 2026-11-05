/**
 * Shared assets 2b step 3, behind the gate (D2): a composer edit is a request
 * draft and a branch is a scratch, both in the folder's `.workbench/`; runs
 * write nothing to `project.json`, and only Save appends a revision
 * (docs/SHARED_ASSETS_LEVEL_TWO_DESIGN.md, "Step 3 decisions").
 */
import type { Page } from "./support/test";

import { expect, test } from "./support/test";
import { createEntityId } from "../../packages/core/src/run-kernel/types";
import { createProjectFile } from "../../packages/core/src/project";
import type { ProjectFile } from "../../packages/core/src/project";
import { publishScratch } from "../../packages/core/src/workbench-publication";
import { serializeWorkbenchRecord } from "../../packages/core/src/personal-workbench";
import type { WorkbenchScratchV1 } from "../../packages/core/src/personal-workbench";
import { serializeProjectManifest } from "../../app/workbench/project-manifest";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  PROJECT_PROFILE_MAP_STORAGE_KEY,
  primaryAction,
  seedProfile,
  stubProjectDirectory,
  waitForHydration,
} from "./support";

test.use({ personalWorkbench: true });

function fixtureProject(): ProjectFile {
  return createProjectFile({
    name: "Personal requests fixture",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "What is 2 + 2?" }],
    },
    idSuffix: "personal-requests",
    createdAt: "2026-11-04T12:00:00.000Z",
  });
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

async function openFolder(page: Page, project: ProjectFile, manifest: string, extraFiles: Record<string, string> = {}): Promise<void> {
  const instanceId = "profile-instance-buffered";
  await seedProfile(page, { endpoint: BUFFERED_FIXTURE_ENDPOINT, instanceId });
  // This device already maps the project's connection, so runs are ready.
  await page.addInitScript(({ mapKey, projectId, instanceId }) => {
    localStorage.setItem(mapKey, JSON.stringify({ [projectId]: { profileId: "buffered", profileInstanceId: instanceId } }));
  }, { mapKey: PROJECT_PROFILE_MAP_STORAGE_KEY, projectId: project.projectId, instanceId });
  await stubProjectDirectory(page, { name: "personal-requests", files: { "project.json": manifest, ...extraFiles }, directories: ["traces"] });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project folder…" }).click();
  await expect(page.locator(".brand")).toContainText("Personal requests fixture");
}

const recordFiles = (files: Record<string, string>, folder: "drafts" | "scratch") =>
  Object.entries(files).filter(([path]) => path.startsWith(`.workbench/${folder}/`));

function selectedInput(files: Record<string, string>): unknown {
  const selections = files[".workbench/selections.json"];
  return selections ? JSON.parse(selections).chat?.selectedInput : undefined;
}

function localRequestChip(page: Page, label: "Unsaved changes" | "Local request") {
  return page.getByRole("status").filter({ hasText: label });
}

test("a composer edit is a request draft until Save appends a child revision", async ({ page }) => {
  const project = fixtureProject();
  const launchRevisionId = project.defaults.conversationRevisionId;
  const manifest = serializeProjectManifest(project, "personal");
  await openFolder(page, project, manifest);
  await page.getByLabel("Message 1 content").fill("What is 3 + 3?");

  await expect.poll(async () => recordFiles(await folderFiles(page), "drafts").length).toBe(1);
  let files = await folderFiles(page);
  const draft = JSON.parse(recordFiles(files, "drafts")[0]![1]);
  expect(draft.asset).toEqual({ kind: "chat-request", id: project.conversations[0]!.id });
  expect(draft.base.revisionId).toBe(launchRevisionId);
  expect(draft.edited.items[0].message.content[0].text).toBe("What is 3 + 3?");
  expect(selectedInput(files)).toEqual({ kind: "draft", draftId: draft.draftId });
  expect(files["project.json"]).toBe(manifest);
  const chip = localRequestChip(page, "Unsaved changes");
  await expect(chip).toContainText("stay on this device until you save them");

  await chip.getByRole("button", { name: "Save request" }).click();
  await expect.poll(async () => recordFiles(await folderFiles(page), "drafts").length).toBe(0);
  files = await folderFiles(page);
  const saved = JSON.parse(files["project.json"]!);
  expect(saved.schemaVersion).toBe(19);
  expect(saved.conversationRevisions).toHaveLength(2);
  const child = saved.conversationRevisions[1];
  expect(child.parentRevisionId).toBe(launchRevisionId);
  expect(child.items[0].message.content[0].text).toBe("What is 3 + 3?");
  // Save moves the personal selection, never the launch default (D10).
  expect(saved.defaults.conversationRevisionId).toBe(launchRevisionId);
  await expect.poll(async () => selectedInput(await folderFiles(page)))
    .toEqual({ kind: "saved-conversation-revision", revisionId: child.id });
  await expect(chip).toHaveCount(0);
  await expect(page.getByLabel("Message 1 content")).toHaveValue("What is 3 + 3?");
});

test("runs write nothing to project.json, and a branch is a local request saved as a child", async ({ page }) => {
  const project = fixtureProject();
  const launchRevisionId = project.defaults.conversationRevisionId;
  const manifest = serializeProjectManifest(project, "personal");
  await openFolder(page, project, manifest);
  await page.getByLabel("Message 1 content").fill("What is 3 + 3?");
  await primaryAction(page, "compose").click();
  await expect(page.getByLabel("Run transcript")).toContainText("Buffered fixture response");
  // The draft ran under a fresh revision; nothing was appended.
  expect((await folderFiles(page))["project.json"]).toBe(manifest);

  await page.getByLabel("Run transcript").getByRole("button", { name: "Edit from here" }).first().click();
  const chip = localRequestChip(page, "Local request");
  await expect(chip).toContainText("This branch stays on this device until you save it.");
  await expect(page.getByRole("status").filter({ hasText: "Pending branch" })).toHaveCount(0);
  await expect.poll(async () => recordFiles(await folderFiles(page), "scratch").length).toBe(1);
  let files = await folderFiles(page);
  const scratch = JSON.parse(recordFiles(files, "scratch")[0]![1]);
  // R2: a branch from a draft's live run hangs on the draft's base.
  expect(scratch.request.parent).toEqual({ kind: "saved-conversation-revision", revisionId: launchRevisionId });
  expect(scratch.branchedFrom.runId).toMatch(/^run_/);
  expect(selectedInput(files)).toEqual({ kind: "scratch", scratchId: scratch.scratchId });

  await page.getByLabel("Message 1 content").fill("What is 4 + 4?");
  await primaryAction(page, "compose").click();
  await expect(page.getByLabel("Run transcript")).toContainText("Buffered fixture response");
  // R3: a run of the unsaved branch records where it branched from.
  await expect(page.locator(".branch-provenance")).toBeVisible();
  expect((await folderFiles(page))["project.json"]).toBe(manifest);

  await chip.getByRole("button", { name: "Save request" }).click();
  await expect.poll(async () => recordFiles(await folderFiles(page), "scratch").length).toBe(0);
  files = await folderFiles(page);
  const saved = JSON.parse(files["project.json"]!);
  const child = saved.conversationRevisions.at(-1);
  expect(child.parentRevisionId).toBe(launchRevisionId);
  expect(child.items[0].message.content[0].text).toBe("What is 4 + 4?");
  expect(saved.defaults.conversationRevisionId).toBe(launchRevisionId);
  await expect(chip).toHaveCount(0);
});

/** Starts a two-repetition batch of the composer's request and waits for its result file. */
async function repeatTwice(page: Page, input: string): Promise<Record<string, string>> {
  await page.getByRole("tab", { name: /Tools/ }).click();
  const repeat = page.getByRole("button", { name: "Repeat…" });
  // Step 7 lifts R4: local input may run a repeated experiment.
  await expect(repeat).not.toHaveAttribute("title", "Save this request to run a repeated experiment.");
  await expect(repeat).toBeEnabled();
  await repeat.click();
  const dialog = page.getByRole("dialog", { name: "Run this frozen request repeatedly" });
  // Y3: the confirmation says the input is unsaved.
  await expect(dialog.locator(".repeat-experiment-details")).toContainText(`Input${input}`);
  await dialog.getByLabel("Repetitions").fill("2");
  await dialog.getByRole("button", { name: "Start 2 repetitions" }).click();
  await expect.poll(async () => Object.keys(await folderFiles(page)).filter((path) => path.endsWith(".result.json")).length).toBe(1);
  return folderFiles(page);
}

function batchPlan(files: Record<string, string>) {
  const plans = Object.entries(files).filter(([path]) => path.endsWith(".plan.json"));
  expect(plans).toHaveLength(1);
  return JSON.parse(plans[0]![1]);
}

test("step 7: a repeated experiment runs a request draft under its run identity, writing nothing to project.json", async ({ page }) => {
  const project = fixtureProject();
  const manifest = serializeProjectManifest(project, "personal");
  await openFolder(page, project, manifest);
  await page.getByLabel("Message 1 content").fill("What is 5 + 5?");
  await expect.poll(async () => recordFiles(await folderFiles(page), "drafts").length).toBe(1);

  const files = await repeatTwice(page, `Unsaved draft of ${project.conversations[0]!.name}`);
  const plan = batchPlan(files);
  // Y1: the plan stays v7 and records I3's identity, not a saved revision.
  expect(plan.schemaVersion).toBe(7);
  expect(plan.commonInput.conversationId).toBe(project.conversations[0]!.id);
  expect(project.conversationRevisions.map(({ id }) => id)).not.toContain(plan.commonInput.conversationRevisionId);
  expect(plan.commonInput.messages[0].content[0].text).toBe("What is 5 + 5?");
  expect(files["project.json"]).toBe(manifest);
  // A draft has no branch point, so its cells record none.
  const traces = Object.entries(files).filter(([path]) => path.startsWith("traces/")).map(([, text]) => JSON.parse(text));
  expect(traces).toHaveLength(2);
  expect(traces.map((trace) => trace.branchedFrom)).toEqual([undefined, undefined]);
});

test("step 7: every repetition of a scratch records where the scratch branched from", async ({ page }) => {
  const project = fixtureProject();
  const manifest = serializeProjectManifest(project, "personal");
  await openFolder(page, project, manifest);
  await primaryAction(page, "compose").click();
  await expect(page.getByLabel("Run transcript")).toContainText("Buffered fixture response");
  await page.getByLabel("Run transcript").getByRole("button", { name: "Edit from here" }).first().click();
  await expect.poll(async () => recordFiles(await folderFiles(page), "scratch").length).toBe(1);
  const scratch = JSON.parse(recordFiles(await folderFiles(page), "scratch")[0]![1]);

  const files = await repeatTwice(page, "Unsaved request");
  const plan = batchPlan(files);
  expect(plan.commonInput.conversationId).toBe(scratch.localConversationId);
  const cellRunIds = new Set(plan.cells.map(({ runId }: { runId: string }) => runId));
  const cells = Object.entries(files)
    .filter(([path]) => path.startsWith("traces/"))
    .map(([, text]) => JSON.parse(text))
    .filter((trace) => cellRunIds.has(trace.runId));
  expect(cells).toHaveLength(2);
  // Y2 (R3): each cell records the scratch's branch point.
  for (const cell of cells) {
    expect(cell.branchedFrom).toEqual({
      runId: scratch.branchedFrom.runId,
      messageId: scratch.branchedFrom.messageId,
      parentConversationRevisionId: project.defaults.conversationRevisionId,
    });
  }
  expect(files["project.json"]).toBe(manifest);
});

for (const action of ["saved", "discarded"] as const) {
  test(`a scratch run can be branched again after the scratch is ${action}`, async ({ page }) => {
    const project = fixtureProject();
    await openFolder(page, project, serializeProjectManifest(project, "personal"));
    await primaryAction(page, "compose").click();
    await expect(page.getByLabel("Run transcript")).toContainText("Buffered fixture response");
    await page.getByLabel("Run transcript").getByRole("button", { name: "Edit from here" }).first().click();
    await page.getByLabel("Message 1 content").fill("Scratch run to branch again");
    await primaryAction(page, "compose").click();
    await expect(page.getByLabel("Run transcript")).toContainText("Buffered fixture response");
    const chip = localRequestChip(page, "Local request");
    await chip.getByRole("button", { name: action === "saved" ? "Save request" : "Discard" }).click();
    await expect(chip).toHaveCount(0);
    const saved = JSON.parse((await folderFiles(page))["project.json"]!);
    const parent = action === "saved" ? saved.conversationRevisions.at(-1).id : project.defaults.conversationRevisionId;
    await page.getByLabel("Run transcript").getByRole("button", { name: "Edit from here" }).first().click();
    await expect.poll(async () => recordFiles(await folderFiles(page), "scratch").length).toBe(1);
    const branch = JSON.parse(recordFiles(await folderFiles(page), "scratch")[0]![1]);
    expect(branch.request.parent).toEqual({ kind: "saved-conversation-revision", revisionId: parent });
    await chip.getByRole("button", { name: "Save request" }).click();
    await expect(chip).toHaveCount(0);
    await expect.poll(async () => JSON.parse((await folderFiles(page))["project.json"]!).conversationRevisions.at(-1).parentRevisionId).toBe(parent);
  });
}

test("opening an interrupted scratch Save displays the recovered revision", async ({ page }) => {
  const project = fixtureProject();
  const scratch: WorkbenchScratchV1 = {
    schemaVersion: 1, kind: "scratch", projectId: project.projectId,
    scratchId: "scratch_recovery", localConversationId: createEntityId("conversation", "recovery"),
    createdAt: "2026-11-04T12:00:00.000Z",
    request: {
      kind: "chat",
      parent: { kind: "saved-conversation-revision", revisionId: project.defaults.conversationRevisionId },
      items: [{ kind: "message", message: {
        id: createEntityId("message", "recovered"),
        role: "user", content: [{ type: "text", text: "Recovered scratch text" }],
      } }],
    },
  };
  const planned = publishScratch(project, scratch, { scratches: [], idSuffix: "recovered", createdAt: scratch.createdAt });
  await openFolder(page, planned.project, serializeProjectManifest(planned.project, "personal"), {
    ".workbench/scratch/scratch_recovery.json": serializeWorkbenchRecord({ ...scratch, publishing: planned.intent }),
    ".workbench/selections.json": serializeWorkbenchRecord({ schemaVersion: 1, kind: "selections", projectId: project.projectId, chat: { selectedInput: { kind: "scratch", scratchId: scratch.scratchId } } }),
  });
  await expect(page.getByLabel("Message 1 content")).toHaveValue("Recovered scratch text");
  await expect.poll(async () => selectedInput(await folderFiles(page))).toEqual({ kind: "saved-conversation-revision", revisionId: planned.intent.revisionId });
  await expect.poll(async () => recordFiles(await folderFiles(page), "scratch").length).toBe(0);
});
