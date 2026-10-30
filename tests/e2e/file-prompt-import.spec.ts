import { expect, test } from "./support/test";
import { createProjectFile, parseProjectJson, serializeProjectFile } from "../../packages/core/src/project";
import { parseRunTraceJson } from "../../packages/core/src/run-trace";
import { BUFFERED_FIXTURE_ENDPOINT, PROJECT_REQUIREMENT_PROFILE_MAP_STORAGE_KEY, importProject, openMode, seedProfile, stubSharedProjectDirectory, waitForHydration } from "./support";
import { expectModalContract } from "./support/modal";
import { expectLayoutFits } from "./support/layout";

test("imports a reviewed file batch into the library and preserves the request", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, createProjectFile({
    name: "File prompt fixture",
    request: { provider: "openai-compatible", endpoint: BUFFERED_FIXTURE_ENDPOINT, model: "buffered-test-model", messages: [{ role: "user", content: "Keep my request" }] },
  }), "File prompt fixture");
  await openMode(page, "Prompts");
  // Assert the actual available actions before using any new selector.
  expect(await page.locator(".template-create-actions button").allTextContents()).toContain("Import prompts from files…");
  await page.getByRole("button", { name: "Import prompts from files…" }).click();
  const dialog = page.getByRole("dialog", { name: "Import prompts from files" });
  await dialog.getByLabel("Prompt files").setInputFiles([
    { name: "agent.md", mimeType: "text/markdown", buffer: Buffer.from("Hello {{ $json.chatInput }}") },
    { name: "literal.txt", mimeType: "text/plain", buffer: Buffer.from(String.raw`Keep {{topic}} and \{{other}}`) },
  ]);
  const agent = dialog.getByRole("group", { name: "agent.md" });
  const literal = dialog.getByRole("group", { name: "literal.txt" });
  await agent.getByLabel("Message role").selectOption("system");
  await literal.getByLabel("Treat as plain text").check();
  await expect(agent).toContainText("{{ $json.chatInput }} → {{chatInput}}");
  await expect(literal.getByLabel("Template preview")).toHaveValue(String.raw`Keep \{{topic}} and \\{{other}}`);
  await dialog.getByRole("button", { name: "Import 2 prompts" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".template-list-item")).toHaveCount(2);
  await expect(page.getByLabel("Prompt name")).toHaveValue("agent");
  await expect(page.getByLabel("Prompt message 1 content")).toHaveValue("Hello {{chatInput}}");
  await page.getByRole("button", { name: "Copy as n8n text…" }).click();
  const copy = page.getByRole("dialog", { name: "Copy as n8n text" });
  await expect(copy.getByLabel("n8n text")).toHaveValue("Hello {{ $json.chatInput }}");
  await copy.getByRole("button", { name: "Copy text", exact: true }).click();
  await expect(copy.getByRole("status")).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Hello {{ $json.chatInput }}");
  await copy.getByRole("button", { name: "Close", exact: true }).click();
  await openMode(page, "Compose");
  await expect(page.getByLabel("Message 1 content", { exact: true })).toHaveValue("Keep my request");
});

test("drop, validation, cancellation and modal keyboard behavior keep staging separate", async ({ page }) => {
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  await openMode(page, "Prompts");
  const opener = page.getByRole("button", { name: "Import prompts from files…" });
  const dialog = page.getByRole("dialog", { name: "Import prompts from files" });
  await expectModalContract(page, { open: opener, dialog });
  await page.getByRole("region", { name: "Prompt authoring" }).evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["{{ broken"], "dropped.md", { type: "text/markdown" }));
    element.querySelector(".templates-workspace")!.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await expect(dialog.getByRole("alert")).toContainText("missing its closing");
  await expect(dialog.getByRole("button", { name: "Import 1 prompt", exact: true })).toBeDisabled();
  await dialog.getByLabel("Treat as plain text").check();
  await expect(dialog.getByRole("button", { name: "Import 1 prompt", exact: true })).toBeEnabled();
  for (const viewport of [{ width: 1280, height: 560 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await expectLayoutFits(page);
  }
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".template-list-item")).toHaveCount(0);
  await opener.click();
  await dialog.getByLabel("Prompt files").setInputFiles([
    { name: "valid.md", mimeType: "text/markdown", buffer: Buffer.from("Valid text") },
    { name: "invalid.txt", mimeType: "text/plain", buffer: Buffer.from([0xff]) },
  ]);
  await expect(dialog.getByRole("alert")).toContainText("encoded data");
  await expect(dialog.getByRole("button", { name: "Import 2 prompts" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.locator(".template-list-item")).toHaveCount(0);
});

test("file receipts survive folder reopen and literal text reaches a real provider request", async ({ page, context }) => {
  const original = createProjectFile({ name: "Persistent file prompts", idSuffix: "persistent-file-prompts", request: {
    provider: "openai-compatible", endpoint: BUFFERED_FIXTURE_ENDPOINT, model: "buffered-test-model", messages: [{ role: "user", content: "Existing instruction" }],
  } });
  const directory = await stubSharedProjectDirectory(context, { name: "file-prompts.inference-lens", files: { "project.json": serializeProjectFile(original) } });
  await seedProfile(page, { instanceId: "file-profile" });
  await page.addInitScript(({ key, projectId, requirementId }) => {
    localStorage.setItem(key, JSON.stringify({ [projectId]: { [requirementId]: { profileId: "buffered", profileInstanceId: "file-profile" } } }));
  }, { key: PROJECT_REQUIREMENT_PROFILE_MAP_STORAGE_KEY, projectId: original.projectId, requirementId: original.defaults.target.connectionRequirementId });
  await page.goto("/");
  await waitForHydration(page);
  const openFolder = async () => {
    await page.getByLabel("Project menu", { exact: true }).click();
    await page.getByRole("button", { name: "Open project folder…", exact: true }).click();
    await expect(page.locator(".brand")).toContainText("Saved to file-prompts.inference-lens");
  };
  await openFolder();
  await openMode(page, "Prompts");
  await page.getByRole("button", { name: "Import prompts from files…" }).click();
  const dialog = page.getByRole("dialog", { name: "Import prompts from files" });
  const literalText = String.raw`Literal {{topic}} and \{{other}}`;
  await dialog.getByLabel("Prompt files").setInputFiles([
    { name: "literal.md", mimeType: "text/markdown", buffer: Buffer.from(literalText) },
    { name: "expression.txt", mimeType: "text/plain", buffer: Buffer.from("Explain {{ $json.topic }}") },
  ]);
  await dialog.getByRole("group", { name: "literal.md" }).getByLabel("Treat as plain text").check();
  await dialog.getByRole("button", { name: "Import 2 prompts" }).click();
  await expect.poll(() => parseProjectJson(directory.read("project.json")!).externalImports.length).toBe(2);
  const saved = parseProjectJson(directory.read("project.json")!);
  expect(saved.conversationRevisions).toEqual(original.conversationRevisions);
  expect(saved.defaults).toEqual(original.defaults);
  expect(saved.externalImports[0].authored[0].text).toBe(literalText);
  expect(saved.externalImports.map(({ source }) => source.resource.id)).toEqual(["literal.md", "expression.txt"]);
  await page.reload();
  await waitForHydration(page);
  await openFolder();
  await openMode(page, "Prompts");
  await page.locator(".template-list-item").filter({ hasText: "literal" }).click();
  await page.getByRole("button", { name: "Copy as n8n text…" }).click();
  const copy = page.getByRole("dialog", { name: "Copy as n8n text" });
  await expect(copy.getByLabel("n8n text")).toHaveValue(literalText);
  await copy.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Add to conversation", exact: true }).click();
  await openMode(page, "Prompts");
  await page.locator(".template-list-item").filter({ hasText: "expression" }).click();
  await page.getByLabel("{{topic}}", { exact: true }).fill("file imports");
  await page.getByRole("button", { name: "Create revision and add", exact: true }).click();
  const outgoing = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/inference");
  await page.getByRole("button", { name: /run current conversation/i }).click();
  const body = (await outgoing).postDataJSON() as { execution: { input: { messages: Array<{ role: string; content: Array<{ text?: string }> }> } } };
  await expect(page.locator(".response-pane")).toContainText("Buffered fixture response");
  expect(body.execution.input.messages.map(({ content }) => content.map(({ text }) => text ?? "").join(""))).toEqual(["Existing instruction", literalText, "Explain file imports"]);
  await expect.poll(() => directory.writes.filter(({ path }) => path.startsWith("traces/")).length).toBe(1);
  const trace = parseRunTraceJson(directory.writes.find(({ path }) => path.startsWith("traces/"))!.contents);
  const exchange = Object.values(trace.exchanges)[0];
  expect(JSON.parse(exchange.request!.body!).messages.map(({ content }: { content: string }) => content)).toEqual(["Existing instruction", literalText, "Explain file imports"]);
  expect(directory.writes.every(({ path }) => path === "project.json" || path.startsWith("traces/"))).toBe(true);
  await openMode(page, "Prompts");
  await page.locator(".template-list-item").filter({ hasText: "expression" }).click();
  await page.getByLabel("Prompt content", { exact: true }).fill("Edited {{local}} and {{topic}}");
  await page.getByRole("button", { name: "Copy as n8n text…" }).click();
  await expect(copy.getByRole("alert")).toHaveText("No unambiguous n8n expression is recorded for: local.");
  await expect(copy.getByRole("button", { name: "Copy text", exact: true })).toHaveCount(0);
});

test("re-importing a filename warns, names the existing prompts, and still imports", async ({ page }) => {
  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  await openMode(page, "Prompts");
  const opener = page.getByRole("button", { name: "Import prompts from files…" });
  const dialog = page.getByRole("dialog", { name: "Import prompts from files" });
  await opener.click();
  await dialog.getByLabel("Prompt files").setInputFiles([{ name: "agent.md", mimeType: "text/markdown", buffer: Buffer.from("First") }]);
  await expect(dialog.getByRole("group", { name: "agent.md" }).locator(".file-prompt-warning")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Import 1 prompt", exact: true }).click();
  await expect(dialog).toBeHidden();

  await opener.click();
  await dialog.getByLabel("Prompt files").setInputFiles([
    { name: "agent.md", mimeType: "text/markdown", buffer: Buffer.from("Second") },
    { name: "agent.md", mimeType: "text/markdown", buffer: Buffer.from("Third") },
  ]);
  const groups = dialog.getByRole("group", { name: "agent.md" });
  await expect(groups).toHaveCount(2);
  for (const index of [0, 1]) {
    await expect(groups.nth(index).locator(".file-prompt-warning")).toHaveText([
      "Already imported as “agent”. Importing again creates a separate saved prompt.",
      "Another file in this batch is also named agent.md. Each becomes a separate saved prompt.",
    ]);
  }
  await dialog.getByRole("button", { name: "Import 2 prompts" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".template-list-item")).toHaveCount(3);
});
