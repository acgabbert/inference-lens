/**
 * Shared assets 2b step 4, behind the gate (D2): a decision edit is a request
 * draft and a new decision request is a scratch, both in the folder's
 * `.workbench/`; runs write nothing to `project.json`, and only Save appends a
 * revision or names a request (docs/SHARED_ASSETS_LEVEL_TWO_DESIGN.md,
 * "Step 4 decisions").
 */
import { readFileSync } from "node:fs";

import type { Page } from "./support/test";
import { expect, test } from "./support/test";
import { createProjectFile, parseProjectFile } from "../../packages/core/src/project";
import { createDecisionPromptTemplate } from "../../packages/core/src/decision-template";
import type { ProjectFile } from "../../packages/core/src/project";
import type { DecisionInput } from "../../packages/core/src/decision";
import { createEntityId } from "../../packages/core/src/run-kernel/types";
import { resolveProviderCapabilities } from "../../packages/core/src/types";
import { serializeProjectManifest } from "../../app/workbench/project-manifest";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  SYSTEM_ONE_FIXTURE_ORIGIN,
  openMode,
  seedProfiles,
  stubProjectDirectory,
  waitForHydration,
} from "./support";

test.use({ personalWorkbench: true });

const captured = JSON.parse(
  readFileSync(new URL("../fixtures/system-one/llamacpp-all-types.json", import.meta.url), "utf8"),
).request as { state: { ticket: string; plan: string }; questions: Record<string, { instructions: unknown }> };

/** The captured request with its state as variables, so the replay still answers. */
const templated = { state: { ticket: "{{ticket}}", plan: "{{plan}}" }, questions: captured.questions };
const capturedValues = { ticket: captured.state.ticket, plan: captured.state.plan };

function fixtureProject(withRequest: boolean): ProjectFile {
  const project = createProjectFile({
    name: "Personal decisions fixture",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "fixture-model",
      messages: [{ role: "user", content: "Hello" }],
      capabilities: resolveProviderCapabilities("openai-compatible"),
    },
    idSuffix: "personal-decisions",
    createdAt: "2026-11-04T12:00:00.000Z",
  });
  if (!withRequest) return project;
  const decisionRequestId = createEntityId("decision-request", "saved");
  const revisionId = createEntityId("decision-revision", "saved");
  return parseProjectFile({
    ...project,
    decisionRequests: [{ id: decisionRequestId, name: "Ticket routing" }],
    decisionRequestRevisions: [{
      id: revisionId, decisionRequestId, kind: "inline", decision: templated, values: capturedValues, createdAt: "2026-11-04T12:00:00.000Z",
    }],
    defaults: { ...project.defaults, decisionRequestRevisionId: revisionId },
  });
}

async function openFolder(page: Page, manifest: string, extraFiles: Record<string, string> = {}): Promise<void> {
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
  await stubProjectDirectory(page, { name: "personal-decisions", files: { "project.json": manifest, ...extraFiles }, directories: ["traces"] });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project folder…" }).click();
  await expect(page.locator(".brand")).toContainText("Personal decisions fixture");
  await page.getByRole("radio", { name: "Decision" }).click();
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

const recordFiles = (files: Record<string, string>, folder: "drafts" | "scratch") =>
  Object.entries(files).filter(([path]) => path.startsWith(`.workbench/${folder}/`)).map(([, text]) => JSON.parse(text));

function selectedDecision(files: Record<string, string>): unknown {
  const selections = files[".workbench/selections.json"];
  return selections ? JSON.parse(selections).decision?.selectedInput : undefined;
}

function decisionPane(page: Page) {
  return page.getByRole("region", { name: "Decision request" });
}

function localRequestChip(page: Page, label: "Unsaved changes" | "Local request") {
  return decisionPane(page).getByRole("status").filter({ hasText: label });
}

async function chooseModel(page: Page): Promise<void> {
  const model = decisionPane(page).getByRole("combobox", { name: "Model" });
  await model.fill("all-types");
  await model.press("Escape");
}

test("a new decision request is a local scratch until Save names it", async ({ page }) => {
  const manifest = serializeProjectManifest(fixtureProject(false), "personal");
  await openFolder(page, manifest);
  const pane = decisionPane(page);
  await pane.getByRole("tab", { name: "JSON" }).first().click();
  await page.getByLabel("Decision input (state and questions)").fill(JSON.stringify(templated, null, 2));
  const variables = pane.getByRole("region", { name: "Variables" });
  await variables.getByLabel("{{ticket}}").fill(capturedValues.ticket);
  await variables.getByLabel("{{plan}}").fill(capturedValues.plan);
  await chooseModel(page);

  // Q2: the request is a scratch with no parent; project.json is untouched.
  await expect.poll(async () => recordFiles(await folderFiles(page), "scratch")[0]?.request.content.values)
    .toEqual(capturedValues);
  let files = await folderFiles(page);
  const scratch = recordFiles(files, "scratch")[0];
  expect(scratch.request).toEqual({ kind: "decision", content: { kind: "inline", decision: templated, values: capturedValues } });
  expect(selectedDecision(files)).toEqual({ kind: "scratch", scratchId: scratch.scratchId });
  expect(files["project.json"]).toBe(manifest);
  const chip = localRequestChip(page, "Local request");
  await expect(chip).toContainText("This request stays on this device until you save it.");

  // A run of the local request answers and writes nothing shared.
  await page.getByRole("button", { name: /^Run decision/ }).click();
  await expect(page.getByRole("article", { name: "Answer intent" })).toContainText("Choice billing");
  expect((await folderFiles(page))["project.json"]).toBe(manifest);

  // Q3: a suite pins a saved revision.
  await expect(pane.getByRole("button", { name: "New suite from this request" })).toBeDisabled();
  await expect(pane).toContainText("Save this request to start a suite from it.");

  // Q1: an invalid edit stays in the editor; the record keeps its last valid version.
  await page.getByLabel("Decision input (state and questions)").fill("{ not json");
  await expect(pane.getByRole("status").filter({ hasText: "Your workbench keeps its last valid version." })).toBeVisible();
  await page.waitForTimeout(800);
  expect(recordFiles(await folderFiles(page), "scratch")[0].request.content.decision).toEqual(templated);
  await page.getByLabel("Decision input (state and questions)").fill(JSON.stringify(templated, null, 2));

  await chip.getByRole("button", { name: "Save as request…" }).click();
  const name = pane.getByLabel("Request name");
  await expect(name).toHaveValue("Decision request");
  await name.fill("Ticket triage");
  await pane.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(async () => recordFiles(await folderFiles(page), "scratch").length).toBe(0);
  files = await folderFiles(page);
  const saved = JSON.parse(files["project.json"]!);
  expect(saved.schemaVersion).toBe(19);
  expect(saved.decisionRequests).toEqual([{ id: saved.decisionRequestRevisions[0].decisionRequestId, name: "Ticket triage" }]);
  expect(saved.decisionRequestRevisions[0]).toMatchObject({ kind: "inline", decision: templated, values: capturedValues });
  // Save moves the personal selection, never the launch default (D11).
  expect(saved.defaults.decisionRequestRevisionId).toBeUndefined();
  expect(selectedDecision(files)).toEqual({ kind: "saved-decision-request-revision", revisionId: saved.decisionRequestRevisions[0].id });
  await expect(chip).toHaveCount(0);
  await expect(pane.getByRole("button", { name: "New suite from this request" })).toBeEnabled();
});

test("editing a saved decision request is a draft until Save appends a child", async ({ page, browser, baseURL }) => {
  const project = fixtureProject(true);
  const baseId = project.defaults.decisionRequestRevisionId!;
  const manifest = serializeProjectManifest(project, "personal");
  await openFolder(page, manifest);
  const variables = decisionPane(page).getByRole("region", { name: "Variables" });
  await expect(variables.getByLabel("{{plan}}")).toHaveValue(capturedValues.plan);
  await variables.getByLabel("{{plan}}").fill("enterprise");

  await expect.poll(async () => recordFiles(await folderFiles(page), "drafts").length).toBe(1);
  let files = await folderFiles(page);
  const draft = recordFiles(files, "drafts")[0];
  expect(draft.asset).toEqual({ kind: "decision-request", id: project.decisionRequests[0]!.id });
  expect(draft.base.revisionId).toBe(baseId);
  expect(draft.edited.values).toEqual({ ...capturedValues, plan: "enterprise" });
  expect(selectedDecision(files)).toEqual({ kind: "draft", draftId: draft.draftId });
  expect(files["project.json"]).toBe(manifest);

  const chip = localRequestChip(page, "Unsaved changes");
  // An edit back to the saved values is no draft.
  await variables.getByLabel("{{plan}}").fill(capturedValues.plan);
  await expect.poll(async () => recordFiles(await folderFiles(page), "drafts").length).toBe(0);
  await expect(chip).toHaveCount(0);
  await variables.getByLabel("{{plan}}").fill("enterprise");
  await chip.getByRole("button", { name: "Save request" }).click();
  await expect.poll(async () => recordFiles(await folderFiles(page), "drafts").length).toBe(0);
  files = await folderFiles(page);
  const saved = JSON.parse(files["project.json"]!);
  expect(saved.decisionRequestRevisions).toHaveLength(2);
  const child = saved.decisionRequestRevisions[1];
  expect(child).toMatchObject({ parentRevisionId: baseId, values: { ...capturedValues, plan: "enterprise" } });
  expect(saved.defaults.decisionRequestRevisionId).toBe(baseId);
  expect(selectedDecision(files)).toEqual({ kind: "saved-decision-request-revision", revisionId: child.id });
  await expect(chip).toHaveCount(0);
  await expect(variables.getByLabel("{{plan}}")).toHaveValue("enterprise");

  // Reopened, the personal selection still shows the saved child, not the launch default.
  const { "project.json": reopenedManifest, ...workbench } = files;
  const context = await browser.newContext({ baseURL });
  const reopened = await context.newPage();
  await openFolder(reopened, reopenedManifest!, workbench);
  await expect(decisionPane(reopened).getByRole("region", { name: "Variables" }).getByLabel("{{plan}}")).toHaveValue("enterprise");
  await context.close();
});

test("using a decision prompt starts a local request that Save offers the prompt's name", async ({ page }) => {
  const project = createDecisionPromptTemplate(fixtureProject(false), {
    name: "Ticket decision", decision: { state: "{{ticket}}", questions: captured.questions } as unknown as DecisionInput,
    variableDefaults: { ticket: "Default ticket" }, idSuffix: "ticket-decision",
  });
  const template = project.promptTemplates[0]!;
  const manifest = serializeProjectManifest(project, "personal");
  await openFolder(page, manifest);
  await openMode(page, "Prompts");
  await page.locator(".template-list").getByRole("button", { name: /Ticket decision/ }).click();
  await page.getByRole("button", { name: "Use Revision 1 (current)", exact: true }).click();
  const pane = decisionPane(page);
  await expect(pane.getByLabel("State text")).toHaveValue("{{ticket}}");

  // Q2: a scratch pinned to the prompt, with no parent; nothing shared.
  await expect.poll(async () => recordFiles(await folderFiles(page), "scratch").length).toBe(1);
  const scratch = recordFiles(await folderFiles(page), "scratch")[0];
  expect(scratch.request).toEqual({
    kind: "decision",
    content: { kind: "template-use", templateId: template.id, templateRevisionId: template.revisions[0]!.id, overrides: {} },
  });
  // A value edit stays a sparse override (D11).
  await pane.getByRole("region", { name: "Variables", exact: true }).getByLabel("{{ticket}}").fill("Override ticket");
  await expect.poll(async () => recordFiles(await folderFiles(page), "scratch")[0]?.request.content.overrides)
    .toEqual({ ticket: "Override ticket" });
  // Detach is a local edit too: the scratch becomes inline content.
  await pane.getByRole("button", { name: "Detach", exact: true }).click();
  await expect(pane.getByLabel("State text")).toBeEnabled();
  await expect.poll(async () => recordFiles(await folderFiles(page), "scratch")[0]?.request.content)
    .toEqual({ kind: "inline", decision: { state: "{{ticket}}", questions: captured.questions }, values: { ticket: "Override ticket" } });
  expect((await folderFiles(page))["project.json"]).toBe(manifest);

  await localRequestChip(page, "Local request").getByRole("button", { name: "Save as request…" }).click();
  await expect(pane.getByLabel("Request name")).toHaveValue("Ticket decision");
  await pane.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(async () => recordFiles(await folderFiles(page), "scratch").length).toBe(0);
  const saved = JSON.parse((await folderFiles(page))["project.json"]!);
  expect(saved.decisionRequests.map(({ name }: { name: string }) => name)).toEqual(["Ticket decision"]);
  expect(saved.decisionRequestRevisions[0]).toMatchObject({ kind: "inline", values: { ticket: "Override ticket" } });
});

test("Replace with example loads the example over an invalid edit", async ({ page }) => {
  await openFolder(page, serializeProjectManifest(fixtureProject(false), "personal"));
  const pane = decisionPane(page);
  await pane.getByRole("button", { name: "Load example" }).click();
  await expect.poll(async () => recordFiles(await folderFiles(page), "scratch").length).toBe(1);

  // Q1: the invalid edit stays in the editor; the scratch keeps the example.
  await pane.getByRole("tab", { name: "JSON" }).first().click();
  const editor = page.getByLabel("Decision input (state and questions)");
  await editor.fill("{ not json");
  await expect(pane.getByRole("status").filter({ hasText: "Your workbench keeps its last valid version." })).toBeVisible();

  // Q2: confirming starts a new scratch with the same content, and the editor shows it.
  await pane.getByRole("button", { name: "Load example" }).click();
  await pane.getByRole("button", { name: "Replace with example" }).click();
  await expect.poll(async () => recordFiles(await folderFiles(page), "scratch").length).toBe(2);
  await expect(editor).not.toHaveValue("{ not json");
  expect(Object.keys(JSON.parse(await editor.inputValue()).questions)).toEqual(["intent", "severity", "is_spam"]);
});
