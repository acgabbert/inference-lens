import { expect, test } from "@playwright/test";

import {
  appendPromptTemplateRevision,
  createProjectFile,
  createPromptTemplate,
} from "../../packages/core/src/project";
import { BUFFERED_FIXTURE_ENDPOINT, importProject, seedProfile, waitForHydration, openMode } from "./support";

test("a historical prompt revision forks into a candidate and retains an exact revision diff", async ({ page }) => {
  let project = createProjectFile({
    name: "Saved prompt revision fixture",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Hello" }],
    },
    idSuffix: "saved-prompt-revision",
    createdAt: "2026-08-06T12:00:00.000Z",
  });
  project = createPromptTemplate(project, {
    name: "Incident triage",
    messages: [{ role: "user", content: "Triage {{incident}}." }],
    variableDefaults: { incident: "timeout" },
    idSuffix: "triage",
    createdAt: "2026-08-06T12:00:01.000Z",
  });
  const firstRevisionId = project.promptTemplates[0]!.currentRevisionId;
  project = appendPromptTemplateRevision(project, {
    templateId: project.promptTemplates[0]!.id,
    messages: [{ role: "user", content: "Triage {{incident}} carefully." }],
    variableDefaults: { incident: "latency" },
    createdAt: "2026-08-06T12:00:02.000Z",
    idSuffix: "triage-2",
  });

  await seedProfile(page, { instanceId: "profile-instance-buffered" });
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, project, "Saved prompt revision fixture");
  await openMode(page, "Compose");
  await page.getByRole("tab", { name: /Prompts/ }).click();

  const editor = page.locator(".template-editor");
  await editor.locator(".template-revision-field select").selectOption(firstRevisionId);
  await expect(editor).toContainText("Read-only revision");
  await editor.getByRole("button", { name: "Create candidate from this revision" }).click();
  await editor.getByLabel("Prompt content").fill("Triage {{incident}} for the on-call engineer.");
  await editor.getByLabel("{{incident}}").fill("database outage");
  await editor.getByRole("button", { name: "Save prompt" }).click();

  const diff = editor.getByRole("region", { name: "Revision diff" });
  await expect(diff).toContainText("Revision diff");
  await expect(diff).toContainText("Triage {{incident}}.");
  await expect(diff).toContainText("Triage {{incident}} for the on-call engineer.");
  await expect(diff).toContainText("timeout → database outage");

  await editor.locator(".template-revision-field select").selectOption(firstRevisionId);
  await expect(editor.getByLabel("Prompt content")).toHaveValue("Triage {{incident}}.");
  await expect(editor.getByLabel("{{incident}}")).toHaveValue("timeout");
});
