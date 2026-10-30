import { expect, test, type Page } from "./support/test";
import { createProjectFile, parseProjectJson, serializeProjectFile } from "../../packages/core/src/project";
import { BUFFERED_FIXTURE_ENDPOINT, importProject, openMode, seedProfile, stubSharedProjectDirectory, waitForHydration } from "./support";
import { expectModalContract } from "./support/modal";
import { expectLayoutFits } from "./support/layout";

async function importAgent(page: Page, text: string): Promise<void> {
  await page.getByRole("button", { name: "Import prompts from files…" }).click();
  const dialog = page.getByRole("dialog", { name: "Import prompts from files" });
  await dialog.getByLabel("Prompt files").setInputFiles([{ name: "agent.md", mimeType: "text/markdown", buffer: Buffer.from(text) }]);
  await dialog.getByRole("group", { name: "agent.md" }).getByLabel("Message role").selectOption("system");
  await dialog.getByRole("button", { name: "Import 1 prompt", exact: true }).click();
  await expect(dialog).toBeHidden();
}

test("updates a tracked prompt from a file, keeping variable names and defaults and replacing a local revision", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, createProjectFile({
    name: "File update fixture",
    request: { provider: "openai-compatible", endpoint: BUFFERED_FIXTURE_ENDPOINT, model: "buffered-test-model", messages: [{ role: "user", content: "Keep my request" }] },
  }), "File update fixture");
  await openMode(page, "Prompts");
  await importAgent(page, "Hello {{ $json.chatInput }}");
  // Assert the actual available actions before using any new selector.
  expect(await page.locator(".template-editor-scroll .file-prompt-actions button").allTextContents()).toEqual(["Copy as n8n text…", "Update from file…"]);

  // A local revision that sets a default; the pull must supersede it, not lose it.
  await page.getByLabel("{{chatInput}}", { exact: true }).fill("cats");
  await page.getByRole("button", { name: "Create revision", exact: true }).click();
  await expect(page.getByLabel("Revision", { exact: true })).toHaveValue(/.+/);

  const opener = page.getByRole("button", { name: "Update from file…" });
  const dialog = page.getByRole("dialog", { name: "Update “agent” from file" });
  await expectModalContract(page, { open: opener, dialog });
  await opener.click();
  await expect(dialog.getByLabel("Message role")).toHaveValue("system");
  const fileText = "Hi {{ $json.chatInput }}\nin {{ $json.style }}";
  await dialog.getByLabel("Prompt file").setInputFiles([{ name: "agent.md", mimeType: "text/markdown", buffer: Buffer.from(fileText) }]);
  await expect(dialog.getByRole("list", { name: "Changes from file" })).toContainText("File text changed since the last pull.");
  await expect(dialog.getByRole("list", { name: "Changes from file" })).toContainText("Compared with Revision 1, the last pull.");
  await expect(dialog.locator(".file-prompt-warning")).toHaveText(
    "Replaces Revision 2 (current) as current. Saved since the last pull: Revision 2 (current). They stay in history and can be made current again.",
  );
  await expect(dialog.getByRole("list", { name: "Variables" }).getByRole("listitem")).toHaveText([
    "{{ $json.chatInput }} → {{chatInput}} · kept",
    "{{ $json.style }} → {{style}} · new",
  ]);
  await expect(dialog).toContainText("Keeps defaults for {{chatInput}}.");
  await expect(dialog.getByRole("region", { name: "File changes since last pull" })).toContainText("Message 1 · changed");
  await expect(dialog.getByRole("region", { name: "Replaces current" })).toContainText("Message 1 · changed");
  for (const viewport of [{ width: 1280, height: 560 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await expectLayoutFits(page);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await dialog.getByRole("button", { name: "Replace current with file" }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByLabel("Prompt message 1 content", { exact: true })).toHaveValue("Hi {{chatInput}}\nin {{style}}");
  await expect(page.getByLabel("Revision", { exact: true }).locator("option:checked")).toContainText("Revision 3 (current)");
  await expect(page.getByLabel("{{chatInput}}", { exact: true })).toHaveValue("cats");
  await expect(page.getByLabel("Revision", { exact: true }).locator("option")).toHaveCount(3);
  await page.getByRole("button", { name: "Copy as n8n text…" }).click();
  const copy = page.getByRole("dialog", { name: "Copy as n8n text" });
  await expect(copy.getByLabel("n8n text")).toHaveValue(fileText);
  await copy.getByRole("button", { name: "Close", exact: true }).click();
  await openMode(page, "Compose");
  await expect(page.getByLabel("Message 1 content", { exact: true })).toHaveValue("Keep my request");
});

test("a pull keeps an open draft, persists through reopen, and refuses a file that changes nothing", async ({ page, context }) => {
  const original = createProjectFile({ name: "Persistent file updates", idSuffix: "persistent-file-updates", request: {
    provider: "openai-compatible", endpoint: BUFFERED_FIXTURE_ENDPOINT, model: "buffered-test-model", messages: [{ role: "user", content: "Existing instruction" }],
  } });
  const directory = await stubSharedProjectDirectory(context, { name: "file-updates.inference-lens", files: { "project.json": serializeProjectFile(original) } });
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  const openFolder = async () => {
    await page.getByLabel("Project menu", { exact: true }).click();
    await page.getByRole("button", { name: "Open project folder…", exact: true }).click();
    await expect(page.locator(".brand")).toContainText("Saved to file-updates.inference-lens");
  };
  await openFolder();
  await openMode(page, "Prompts");
  await importAgent(page, "Answer {{ $json.topic }}");
  await page.getByLabel("Prompt message 1 content", { exact: true }).fill("My draft about {{topic}}");
  await expect.poll(() => {
    const draft = parseProjectJson(directory.read("project.json")!).promptTemplates[0]?.draft;
    return draft && "messages" in draft ? draft.messages[0]?.content : undefined;
  }).toBe("My draft about {{topic}}");

  await page.getByRole("button", { name: "Update from file…" }).click();
  const dialog = page.getByRole("dialog", { name: "Update “agent” from file" });
  await dialog.getByLabel("Prompt file").setInputFiles([{ name: "agent.md", mimeType: "text/markdown", buffer: Buffer.from("Answer {{ $json.topic }}\nbriefly") }]);
  await expect(dialog.locator(".file-prompt-warning")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Update from file", exact: true }).click();
  await expect(dialog).toBeHidden();

  // The draft keeps its edits and source; the editor says the current revision moved.
  await expect(page.getByLabel("Prompt message 1 content", { exact: true })).toHaveValue("My draft about {{topic}}");
  const notice = page.locator(".template-draft-source-notice");
  await expect(notice).toContainText("This draft started from Revision 1; the current revision is Revision 2 (current).");
  await notice.getByRole("button", { name: "Compare with current" }).click();
  await expect(page.getByRole("region", { name: "Revision diff" })).toContainText("vs Revision 2 (current)");
  await expect(page.getByRole("region", { name: "Revision diff" })).toContainText("My draft about");

  await expect.poll(() => parseProjectJson(directory.read("project.json")!).externalImports.length).toBe(2);
  const saved = parseProjectJson(directory.read("project.json")!);
  const template = saved.promptTemplates[0]!;
  if (template.kind !== "chat") throw new Error("Expected a chat prompt");
  expect(template.currentRevisionId).toBe(template.revisions[1]!.id);
  expect(template.revisions[1]!.messages).toEqual([{ role: "system", content: "Answer {{topic}}\nbriefly" }]);
  expect(template.draft).toMatchObject({ sourceRevisionId: template.revisions[0]!.id, messages: [{ role: "system", content: "My draft about {{topic}}" }] });
  expect(saved.conversationRevisions).toEqual(original.conversationRevisions);

  await page.reload();
  await waitForHydration(page);
  await openFolder();
  await openMode(page, "Prompts");
  await expect(page.getByLabel("Prompt message 1 content", { exact: true })).toHaveValue("My draft about {{topic}}");
  await expect(page.locator(".template-draft-source-notice")).toContainText("the current revision is Revision 2 (current)");

  // Same text with CRLF line endings changes nothing; another filename only warns.
  await page.getByRole("button", { name: "Update from file…" }).click();
  await dialog.getByLabel("Prompt file").setInputFiles([{ name: "renamed.md", mimeType: "text/markdown", buffer: Buffer.from("Answer {{ $json.topic }}\r\nbriefly") }]);
  await expect(dialog.getByRole("status")).toHaveText("The current revision already matches this file.");
  await expect(dialog.locator(".file-prompt-warning")).toContainText("last pulled from agent.md; this file is renamed.md");
  await expect(dialog.getByRole("button", { name: "Update from file", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(parseProjectJson(directory.read("project.json")!).externalImports.length).toBe(2);
});


test("dropping an update stays in the update dialog and updates the existing prompt", async ({ page }) => {
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, createProjectFile({ name: "Drop update", request: {
    provider: "openai-compatible", endpoint: BUFFERED_FIXTURE_ENDPOINT, model: "buffered-test-model", messages: [{ role: "user", content: "Existing" }],
  } }), "Drop update");
  await openMode(page, "Prompts");
  await importAgent(page, "Original");
  await page.getByRole("button", { name: "Update from file…" }).click();
  const dialog = page.getByRole("dialog", { name: "Update “agent” from file" });
  const transfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["Changed"], "agent.md", { type: "text/markdown" }));
    return transfer;
  });
  await dialog.locator(".file-prompt-body").dispatchEvent("drop", { dataTransfer: transfer });
  await transfer.dispose();
  await expect(dialog.getByRole("list", { name: "Changes from file" })).toContainText("File text changed");
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await dialog.getByRole("button", { name: "Update from file", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel("Prompt message 1 content", { exact: true })).toHaveValue("Changed");
  await expect(page.getByLabel("Revision", { exact: true }).locator("option")).toHaveCount(2);
});
