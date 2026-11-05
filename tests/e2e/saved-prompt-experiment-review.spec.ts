import { readFile } from "node:fs/promises";
import { expect, test } from "./support/test";
import {
  appendPromptTemplateRevision,
  createProjectFile,
  createPromptTemplate,
  insertPromptTemplateUse,
  parseProjectJson,
} from "../../packages/core/src/project";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  closeProjectMenu,
  importProject,
  openMode,
  seedProfile,
  waitForHydration,
} from "./support";

const PROJECT_NAME = "Saved prompt experiment review";

function fixture() {
  let project = createProjectFile({
    name: PROJECT_NAME,
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [],
    },
    idSuffix: "prompt-experiment-review",
  });
  project = createPromptTemplate(project, {
    name: "Policy",
    messages: [{ role: "system", content: "Use a {{tone}} tone." }],
    variableDefaults: { tone: "neutral" },
    idSuffix: "review-policy",
    revisionIdSuffix: "review-policy-1",
  });
  project = createPromptTemplate(project, {
    name: "Question",
    messages: [{ role: "user", content: "Explain {{topic}}." }],
    idSuffix: "review-question",
    revisionIdSuffix: "review-question-1",
  });
  project = appendPromptTemplateRevision(project, {
    templateId: project.promptTemplates[1]!.id,
    messages: [{ role: "user", content: "Explain {{topic}} with examples." }],
    idSuffix: "review-question-2",
  });
  project = insertPromptTemplateUse(project, {
    conversationRevisionId: project.defaults.conversationRevisionId,
    templateId: project.promptTemplates[0]!.id,
    idSuffix: "review-policy-use",
  });
  return insertPromptTemplateUse(project, {
    conversationRevisionId: project.defaults.conversationRevisionId,
    templateId: project.promptTemplates[1]!.id,
    templateRevisionId: "template-revision_review-question-1",
    idSuffix: "review-question-use",
  });
}

// A characterization of the requested workflow, not a regression test for a
// proposed fix: multiple pinned prompts, multiple named value combinations,
// serialization, and retargeting the same suite without losing its dataset.
test("review: a composite prompt suite retains named value combinations across export and retarget", async ({ page }, testInfo) => {
  await seedProfile(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, fixture(), PROJECT_NAME);
  await openMode(page, "Evaluations");
  await page.getByRole("button", { name: "Create evaluation suite" }).click();

  for (const label of ["Policy · tone", "Question · topic"]) {
    await page.getByLabel("Prompt variable to map").selectOption({ label });
    await page.locator(".evaluation-input-bindings").getByRole("button", { name: "+ Add case input", exact: true }).click();
  }
  for (const [name, tone, topic] of [
    ["Friendly databases", "friendly", "databases"],
    ["Formal networks", "formal", "networks"],
  ]) {
    await page.getByRole("button", { name: "+ Add case", exact: true }).click();
    await page.getByRole("button", { name: "Edit case name", exact: true }).click();
    await page.getByRole("textbox", { name: "Case name", exact: true }).fill(name!);
    await page.getByRole("textbox", { name: "Case name", exact: true }).press("Enter");
    await page.getByLabel(`${name} tone`, { exact: true }).fill(tone!);
    await page.getByLabel(`${name} topic`, { exact: true }).fill(topic!);
    await page.getByLabel("New check kind").selectOption({ label: "Contains text" });
    await page.getByRole("button", { name: "+ Add check", exact: true }).click();
    await page.getByLabel("Expected text", { exact: true }).fill("Buffered fixture");
    await page.getByLabel("Expected text", { exact: true }).blur();
    const resolved = page.getByRole("region", { name: /^Resolved conversation for / });
    await expect(resolved).toContainText(`Use a ${tone} tone.`);
    await expect(resolved).toContainText(`Explain ${topic}.`);
    await expect(resolved.locator(".request-preview-message")).toHaveCount(2);
  }
  await page.screenshot({ path: testInfo.outputPath("composite-suite.png"), fullPage: true });

  await page.getByLabel("Project menu").click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON copy…", exact: true }).click();
  const path = testInfo.outputPath("project.json");
  await (await download).saveAs(path);
  const saved = parseProjectJson(await readFile(path, "utf8"));
  const suite = saved.evaluationSuites[0]!;
  expect(suite.input.kind).toBe("conversation-revision");
  if (suite.input.kind !== "conversation-revision") throw new Error("Expected a chat suite");
  const revisionId = suite.input.conversationRevisionId;
  const revision = saved.conversationRevisions.find(({ id }) => id === revisionId)!;
  expect(revision.items.filter((item) => item.kind === "template-use").map((item) => item.use.templateRevisionId))
    .toEqual(["template-revision_review-policy-1", "template-revision_review-question-1"]);
  expect(suite.cases.map(({ name, values }) => ({
    name,
    values: Object.fromEntries(suite.inputBindings.map((binding) => [binding.target.variableName, values[binding.id]])),
  }))).toEqual([
    { name: "Friendly databases", values: { tone: "friendly", topic: "databases" } },
    { name: "Formal networks", values: { tone: "formal", topic: "networks" } },
  ]);
  await closeProjectMenu(page);
  await importProject(page, saved, PROJECT_NAME, { replaceDirty: "discard" });
  await openMode(page, "Evaluations");
  await expect(page.getByRole("complementary", { name: "Evaluation cases", exact: true })).toContainText("Formal networks");

  await openMode(page, "Prompts");
  await page.locator(".template-list").getByRole("button", { name: /Question/ }).click();
  await page.getByRole("button", { name: "Evaluate in a suite…", exact: true }).click();
  await page.getByRole("dialog", { name: "Evaluate in a suite", exact: true })
    .getByRole("button", { name: "Use Untitled evaluation", exact: true }).click();
  await page.getByRole("complementary", { name: "Evaluation cases", exact: true })
    .getByRole("button", { name: /Formal networks/ }).click();
  await expect(page.getByLabel("Formal networks tone", { exact: true })).toHaveValue("formal");
  await expect(page.getByLabel("Formal networks topic", { exact: true })).toHaveValue("networks");
  const resolved = page.getByRole("region", { name: /^Resolved conversation for / });
  await expect(resolved).toContainText("Use a formal tone.");
  await expect(resolved).toContainText("Explain networks with examples.");
  await expect(resolved.locator(".request-preview-message")).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath("retargeted-suite.png"), fullPage: true });
});
