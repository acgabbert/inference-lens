/**
 * Shared assets slice 2c-1: edits to a saved evaluation suite are a personal
 * draft in the folder's `.workbench/`, and only Save writes `project.json`
 * (docs/SHARED_ASSETS_LEVEL_TWO_DESIGN.md, "Slice 2c decisions").
 */
import type { Page } from "./support/test";

import { expect, test } from "./support/test";
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
} from "../../packages/core/src/project";
import type { ProjectFile } from "../../packages/core/src/project";
import { serializeProjectManifest } from "../../app/workbench/project-manifest";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  PROJECT_PROFILE_MAP_STORAGE_KEY,
  openMode,
  primaryAction,
  seedProfile,
  stubProjectDirectory,
  waitForHydration,
} from "./support";

function fixtureProject(): ProjectFile {
  let project = createProjectFile({
    name: "Suite drafts fixture",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Hello" }],
    },
    idSuffix: "suite-drafts",
    createdAt: "2026-11-05T12:00:00.000Z",
  });
  project = createPromptTemplate(project, {
    name: "Question",
    messages: [{ role: "user", content: "Explain {{topic}}." }],
    variableDefaults: {},
    idSuffix: "question",
    revisionIdSuffix: "question-1",
    createdAt: "2026-11-05T12:00:01.000Z",
  });
  project = insertPromptTemplateUse(project, {
    conversationRevisionId: project.defaults.conversationRevisionId,
    templateId: "template_question",
    itemIndex: 1,
    idSuffix: "question-use",
  });
  const candidates = evaluationBindingCandidates(project, project.defaults.conversationRevisionId);
  const created = createEvaluationSuite(project, "Topics", () => "topics");
  const input = addEvaluationInput(created.project, created.suiteId, candidates[0]!, () => "topic");
  project = input.project;
  for (const [index, value] of ["migrations", "indexes"].entries()) {
    const added = addEvaluationCase(project, created.suiteId, () => `case-${index}`);
    project = updateEvaluationCase(added.project, created.suiteId, added.caseId, {
      name: value,
      values: { [input.inputId]: `database ${value}` },
    });
    project = addEvaluationCheck(project, created.suiteId, added.caseId, { kind: "contains" }, () => `check-${index}`);
    const check = project.evaluationSuites[0]!.cases[index]!.checks[0]!;
    project = updateEvaluationCheck(project, created.suiteId, added.caseId, {
      checkId: check.checkId, kind: "contains", label: "Mentions buffered", value: "Buffered",
    });
  }
  return project;
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

const draftFiles = (files: Record<string, string>) =>
  Object.entries(files).filter(([path]) => path.startsWith(".workbench/drafts/"));

async function openFolder(page: Page, project: ProjectFile, { mapped = false } = {}): Promise<string> {
  const manifest = serializeProjectManifest(project);
  await seedProfile(page, { instanceId: "profile-instance-buffered" });
  if (mapped) {
    await page.addInitScript(({ mapKey, projectId }) => {
      localStorage.setItem(mapKey, JSON.stringify({
        [projectId]: { profileId: "buffered", profileInstanceId: "profile-instance-buffered" },
      }));
    }, { mapKey: PROJECT_PROFILE_MAP_STORAGE_KEY, projectId: project.projectId });
  }
  await stubProjectDirectory(page, { name: "suite-drafts", files: { "project.json": manifest } });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project folder…" }).click();
  await expect(page.locator(".brand")).toContainText("Suite drafts fixture");
  await page.locator(".project-menu").evaluate((element) => element.removeAttribute("open"));
  await openMode(page, "Evaluations");
  return manifest;
}

test("a suite edit is a personal draft until Save writes it to project.json", async ({ page }) => {
  const manifest = await openFolder(page, fixtureProject());
  const editor = page.locator(".evaluation-editor");
  await editor.getByRole("button", { name: "+ Add case", exact: true }).click();
  await page.getByLabel("Untitled case topic").fill("database replication");

  // The draft reaches .workbench/ after the debounce; project.json is untouched.
  await expect.poll(async () => draftFiles(await folderFiles(page)).length).toBe(1);
  let files = await folderFiles(page);
  const draft = JSON.parse(draftFiles(files)[0]![1]);
  expect(draft.asset).toEqual({ kind: "suite", id: "evaluation-suite_topics" });
  expect(draft.base.snapshot.cases).toHaveLength(2);
  expect(draft.edited.cases).toHaveLength(3);
  expect(draft.edited.cases[2].values).toEqual({ "evaluation-input_topic": "database replication" });
  expect(files["project.json"]).toBe(manifest);
  await expect(page.getByRole("navigation", { name: "Evaluation suites" })).toContainText("Unsaved changes");
  await expect(editor.locator("header")).toContainText("Unsaved changes");

  await editor.getByRole("button", { name: "Save suite" }).click();
  await expect.poll(async () => draftFiles(await folderFiles(page)).length).toBe(0);
  files = await folderFiles(page);
  const saved = JSON.parse(files["project.json"]!);
  expect(saved.evaluationSuites[0].cases).toHaveLength(3);
  expect(saved.evaluationSuites[0].cases[2].values).toEqual({ "evaluation-input_topic": "database replication" });
  await expect(editor.locator("header")).not.toContainText("Unsaved changes");
  await expect(page.getByRole("navigation", { name: "Evaluation suites" })).not.toContainText("Unsaved changes");
});

test("Discard returns the suite to its saved content and leaves project.json as it was", async ({ page }) => {
  const manifest = await openFolder(page, fixtureProject());
  const editor = page.locator(".evaluation-editor");
  await editor.getByRole("button", { name: "Edit suite name" }).click();
  await page.getByLabel("Suite name", { exact: true }).fill("Topics, renamed");
  await page.getByRole("button", { name: "Save suite name" }).click();
  await expect(editor.locator("h2")).toHaveText("Topics, renamed");
  await expect.poll(async () => draftFiles(await folderFiles(page)).length).toBe(1);

  await editor.getByRole("button", { name: "Discard changes" }).click();
  const dialog = page.getByRole("dialog", { name: "Discard changes to this suite?" });
  await expect(dialog).toContainText("Topics, renamed");
  await dialog.getByRole("button", { name: "Discard changes" }).click();
  await expect(editor.locator("h2")).toHaveText("Topics");
  await expect.poll(async () => draftFiles(await folderFiles(page)).length).toBe(0);
  expect((await folderFiles(page))["project.json"]).toBe(manifest);
});

test("an evaluation start plans the suite's draft, not the saved suite (C3)", async ({ page }) => {
  const manifest = await openFolder(page, fixtureProject(), { mapped: true });
  const editor = page.locator(".evaluation-editor");
  await editor.getByRole("button", { name: /^indexes/ }).click();
  await editor.getByRole("button", { name: "Edit case name" }).click();
  const caseName = page.getByLabel("Case name", { exact: true });
  await caseName.fill("indexes, drafted");
  await caseName.blur();
  await expect(editor.locator("header")).toContainText("Unsaved changes");
  await expect(editor).toContainText("Ready to run");

  await primaryAction(page, "evaluations").click();
  const dialog = page.getByRole("dialog", { name: /Start “Topics”/ });
  await expect(dialog).toContainText("2 · migrations, indexes, drafted");
  await expect(dialog).toContainText("2 planned");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect((await folderFiles(page))["project.json"]).toBe(manifest);
});
