import { expect, test, type Page } from "./support/test";
import { createProjectFile, parseProjectJson, serializeProjectFile, type ProjectFile } from "../../packages/core/src/project";
import { createFilePromptCandidate, importFilePromptCandidates } from "../../packages/core/src/file-prompt-import";
import { linkFilePrompt } from "../../packages/core/src/source-roots";
import { BUFFERED_FIXTURE_ENDPOINT, importProject, openMode, seedProfile, stubSharedProjectDirectory, waitForHydration } from "./support";
import { expectModalContract } from "./support/modal";
import { expectLayoutFits } from "./support/layout";
import { sourceRootFixture } from "./support/source-roots";

const request = {
  provider: "openai-compatible" as const,
  endpoint: BUFFERED_FIXTURE_ENDPOINT,
  model: "buffered-test-model",
  messages: [{ role: "user" as const, content: "Keep my request" }],
};

async function importAgent(page: Page, text: string): Promise<void> {
  await page.getByRole("button", { name: "Import prompts from files…" }).click();
  const dialog = page.getByRole("dialog", { name: "Import prompts from files" });
  await dialog.getByLabel("Prompt files").setInputFiles([{ name: "agent.md", mimeType: "text/markdown", buffer: Buffer.from(text) }]);
  await dialog.getByRole("group", { name: "agent.md" }).getByLabel("Message role").selectOption("system");
  await dialog.getByRole("button", { name: "Import 1 prompt", exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function openFolder(page: Page, name: string): Promise<void> {
  await page.getByLabel("Project menu", { exact: true }).click();
  await page.getByRole("button", { name: "Open project folder…", exact: true }).click();
  await expect(page.locator(".brand")).toContainText(`Saved to ${name}`);
}

const sourceStatus = (page: Page) => page.getByRole("list", { name: "Source file status" }).getByRole("listitem");
const libraryEntry = (page: Page, name: string) => page.locator(".template-list-item").filter({ hasText: name });

test("links a tracked prompt to a server folder file, shows drift, and pulls it without a picker", async ({ page, context }, testInfo) => {
  const roots = sourceRootFixture(testInfo);
  const path = roots.write("e2e-prompts", "flows/agent.md", "Hello {{ $json.name }}");
  const original = createProjectFile({ name: "Linked sources", idSuffix: "linked-sources", request });
  const directory = await stubSharedProjectDirectory(context, { name: "linked.inference-lens", files: { "project.json": serializeProjectFile(original) } });
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  await openFolder(page, "linked.inference-lens");
  await openMode(page, "Prompts");
  await importAgent(page, "Hello {{ $json.name }}");
  expect(await page.locator(".template-editor-scroll .file-prompt-actions button").allTextContents())
    .toEqual(["Copy as n8n text…", "Update from file…", "Link to source file…"]);
  await expect(page.locator(".linked-prompt-source")).toContainText("Not linked to a source folder.");

  const opener = page.getByRole("button", { name: "Link to source file…" });
  const dialog = page.getByRole("dialog", { name: "Link “agent” to a source file" });
  await expectModalContract(page, { open: opener, dialog });
  await opener.click();
  await expect(dialog.getByLabel("Source folder")).toHaveValue("e2e-prompts");
  await expect(dialog.getByLabel("Source folder").locator("option")).toHaveText(["E2E prompts (e2e-prompts)", "e2e-alternate"]);
  await dialog.getByLabel("Find a file").fill(roots.prefix);
  // Only this test's file matches, and its basename matches the import, so it is preselected.
  await expect(dialog.getByRole("list", { name: "Files" }).getByRole("listitem")).toHaveText([path]);
  await expect(dialog.getByRole("radio", { name: path })).toBeChecked();
  await expect(dialog.getByRole("status")).toHaveText("This file matches the last pull.");
  for (const viewport of [{ width: 1280, height: 560 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await expectLayoutFits(page);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await dialog.getByRole("button", { name: "Link", exact: true }).click();
  await expect(dialog).toBeHidden();

  const bar = page.getByRole("region", { name: "Linked source file" });
  await expect(bar).toContainText(`Linked to e2e-prompts/${path}`);
  await expect(sourceStatus(page)).toHaveText(["File matches the last pull"]);
  await expect(libraryEntry(page, "agent").locator(".template-list-source")).toHaveCount(0);
  await expect.poll(() => parseProjectJson(directory.read("project.json")!).sourceRoots.map(({ name }) => name)).toEqual(["e2e-prompts"]);
  const linked = parseProjectJson(directory.read("project.json")!);
  const linkedTemplate = linked.promptTemplates[0]!;
  expect(linkedTemplate.kind === "chat" && linkedTemplate.fileSource).toEqual({ sourceRootId: linked.sourceRoots[0]!.id, path });
  expect(linkedTemplate.kind === "chat" && linkedTemplate.revisions.length).toBe(1);

  // The file changes outside IL; nothing watches it, so Refresh reads it again.
  roots.write("e2e-prompts", "flows/agent.md", "Hi {{ $json.name }}\nfrom {{ $json.place }}");
  await expect(sourceStatus(page)).toHaveText(["File matches the last pull"]);
  await bar.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(sourceStatus(page)).toHaveText(["File changed since last pull"]);
  await expect(libraryEntry(page, "agent").locator(".template-list-source")).toHaveText("File changed since last pull");

  // A local revision is reported separately, and both can hold at once.
  await page.getByLabel("Prompt message 1 content", { exact: true }).fill("Local {{name}}");
  await page.getByRole("button", { name: "Create revision", exact: true }).click();
  await expect(sourceStatus(page)).toHaveText(["File changed since last pull", "Local revisions not from the file"]);
  await expect(libraryEntry(page, "agent").locator(".template-list-source"))
    .toHaveText("File changed since last pull · Local revisions not from the file");

  await bar.getByRole("button", { name: "Pull from file…" }).click();
  const pull = page.getByRole("dialog", { name: "Update “agent” from file" });
  await expect(pull).toContainText(`Pull e2e-prompts/${path}, last pulled from agent.md.`);
  await expect(pull.getByLabel("Prompt file")).toHaveCount(0);
  await expect(pull.getByRole("list", { name: "Changes from file" })).toContainText("File text changed since the last pull.");
  // The path is not a different file from the bare-filename import.
  await expect(pull.locator(".file-prompt-warning")).not.toContainText("this file is");
  await expect(pull.getByRole("list", { name: "Variables" }).getByRole("listitem")).toHaveText([
    "{{ $json.name }} → {{name}} · kept",
    "{{ $json.place }} → {{place}} · new",
  ]);
  await pull.getByRole("button", { name: "Replace current with file" }).click();
  await expect(pull).toBeHidden();
  await expect(page.getByLabel("Prompt message 1 content", { exact: true })).toHaveValue("Hi {{name}}\nfrom {{place}}");
  await expect(sourceStatus(page)).toHaveText(["File matches the last pull"]);
  await expect(libraryEntry(page, "agent").locator(".template-list-source")).toHaveCount(0);

  await expect.poll(() => parseProjectJson(directory.read("project.json")!).externalImports.length).toBe(2);
  const saved = parseProjectJson(directory.read("project.json")!);
  expect(saved.externalImports.map(({ source }) => source.resource.id)).toEqual(["agent.md", path]);
  expect(saved.conversationRevisions).toEqual(original.conversationRevisions);

  // Reopening reads the file again on entering the Prompts mode.
  await page.reload();
  await waitForHydration(page);
  await openFolder(page, "linked.inference-lens");
  await openMode(page, "Prompts");
  await expect(sourceStatus(page)).toHaveText(["File matches the last pull"]);
});

/** Two prompts linked under a root this server does not declare, one to a missing file. */
async function undeclaredRootProject(prefix: string): Promise<ProjectFile> {
  const candidates = await Promise.all(["Alpha {{ $json.a }}", "Beta"].map((text, index) =>
    createFilePromptCandidate({ filename: index === 0 ? "alpha.md" : "beta.md", text, role: "system", plainText: false })));
  const { project, templateIds } = await importFilePromptCandidates(
    createProjectFile({ name: "Undeclared roots", idSuffix: "undeclared-roots", request }),
    candidates,
  );
  const alpha = linkFilePrompt(project, templateIds[0]!, { rootName: "team-prompts", path: `${prefix}/alpha.md` });
  return linkFilePrompt(alpha, templateIds[1]!, { rootName: "team-prompts", path: `${prefix}/beta.md` });
}

test("a root this server does not declare is named, can be read from another folder for the session, and unlinks", async ({ page, context }, testInfo) => {
  const roots = sourceRootFixture(testInfo);
  roots.write("e2e-alternate", "alpha.md", "Alpha {{ $json.a }} changed");
  const original = await undeclaredRootProject(roots.prefix);
  const directory = await stubSharedProjectDirectory(context, { name: "undeclared.inference-lens", files: { "project.json": serializeProjectFile(original) } });
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  await openFolder(page, "undeclared.inference-lens");
  await openMode(page, "Prompts");

  await libraryEntry(page, "alpha").click();
  await expect(sourceStatus(page)).toHaveText(["This server does not declare a source folder named “team-prompts”."]);
  await expect(libraryEntry(page, "alpha").locator(".template-list-source")).toHaveText("Source file unavailable");
  await expect(page.getByRole("button", { name: "Pull from file…" })).toBeDisabled();

  await page.getByLabel("Read “team-prompts” from this server folder for this session").selectOption("e2e-alternate");
  await expect(sourceStatus(page)).toHaveText(["File changed since last pull"]);
  await libraryEntry(page, "beta").click();
  await expect(sourceStatus(page)).toHaveText([`e2e-alternate/${roots.prefix}/beta.md does not exist.`]);

  await page.getByRole("region", { name: "Linked source file" }).getByRole("button", { name: "Unlink", exact: true }).click();
  await expect(page.locator(".linked-prompt-source")).toContainText("Not linked to a source folder.");
  await expect(libraryEntry(page, "beta").locator(".template-list-source")).toHaveCount(0);
  await expect.poll(() => {
    const saved = parseProjectJson(directory.read("project.json")!);
    return saved.promptTemplates.map((template) => template.kind === "chat" && template.fileSource?.path);
  }).toEqual([`${roots.prefix}/alpha.md`, undefined]);
  const saved = parseProjectJson(directory.read("project.json")!);
  // The mapping is for this session only and never reaches the project.
  expect(saved.sourceRoots.map(({ name }) => name)).toEqual(["team-prompts"]);
  expect(saved.promptTemplates.map((template) => template.kind === "chat" && template.revisions.length)).toEqual([1, 1]);
});

test("a server without source folders says which variable declares them", async ({ page }) => {
  await page.route("**/api/source-roots", (route) => route.fulfill({
    json: { available: false, configurationVariable: "INFERENCE_LENS_SOURCE_ROOTS", roots: [] },
  }));
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, createProjectFile({ name: "No folders", request }), "No folders");
  await openMode(page, "Prompts");
  await importAgent(page, "Hello");
  await page.getByRole("button", { name: "Link to source file…" }).click();
  const dialog = page.getByRole("dialog", { name: "Link “agent” to a source file" });
  await expect(dialog.getByRole("alert")).toHaveText(
    "No source folders are configured on this server. The operator declares them with INFERENCE_LENS_SOURCE_ROOTS.",
  );
  await expect(dialog.getByRole("button", { name: "Link", exact: true })).toBeDisabled();
});
