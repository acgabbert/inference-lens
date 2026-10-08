import { expect, test } from "@playwright/test";

import {
  createProjectFile,
  createPromptTemplate,
  insertPromptTemplateUse,
  setPromptTemplateRecommendedTarget,
} from "../../packages/core/src/project";
import type { PromptTemplateId } from "../../packages/core/src/run-kernel";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  importProject,
  PROJECT_PROFILE_MAP_STORAGE_KEY,
  seedProfile,
  waitForHydration,
} from "./support";

/**
 * Derivations the page assembles from several owners at once: the composer's
 * first prompt, the resolved request preview, and the template run targets
 * handed to run readiness. PR 5 moves each into its feature module, so these
 * pin what reaches the screen while that happens.
 */

const PROJECT_NAME = "Workbench composition fixture";

function projectWithTwoTargets() {
  let project = createProjectFile({
    name: PROJECT_NAME,
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "project-model",
      messages: [],
    },
    idSuffix: "workbench-composition",
    createdAt: "2026-10-08T12:00:00.000Z",
  });
  const requirementId = project.connectionRequirements[0]!.id;
  for (const [suffix, name, content, model] of [
    ["triage", "Triage prompt", "Triage {{topic}}.", "triage-model"],
    ["summary", "Summary prompt", "Summarize {{topic}}.", "summary-model"],
  ] as const) {
    project = createPromptTemplate(project, {
      name,
      messages: [{ role: "user", content }],
      variableDefaults: {},
      idSuffix: suffix,
      revisionIdSuffix: `${suffix}-1`,
      createdAt: "2026-10-08T12:00:01.000Z",
    });
    project = setPromptTemplateRecommendedTarget(
      project,
      `template_${suffix}` as PromptTemplateId,
      { connectionRequirementId: requirementId, model },
    );
    project = insertPromptTemplateUse(project, {
      conversationRevisionId: project.conversationRevisions[0]!.id,
      templateId: `template_${suffix}` as PromptTemplateId,
      values: { topic: "the rollback" },
      idSuffix: suffix,
      outputMessageIdSuffixes: [suffix],
    });
  }
  return project;
}

test("a fresh workbench opens on the system prompt and one of the default user prompts", async ({
  page,
}) => {
  await seedProfile(page);
  // The server render always shows the first prompt; the browser then picks
  // one at random. Pinning the pick to the last prompt makes that swap visible.
  await page.addInitScript(() => {
    Math.random = () => 0.99;
  });
  await page.goto("/");
  await waitForHydration(page);

  const messages = page.locator(".message-list .message-card");
  await expect(messages).toHaveCount(2);
  await expect(messages.nth(0).locator("textarea")).toHaveValue(
    "You are a concise, thoughtful assistant.",
  );
  await expect(messages.nth(1).locator("textarea")).toHaveValue(
    "Explain how a password manager improves security without using technical jargon in two sentences.",
  );
});

test("pinned prompts resolve into the request preview, and differing targets are called out", async ({
  page,
}) => {
  const project = projectWithTwoTargets();
  const instanceId = "profile-instance-workbench-composition";
  await seedProfile(page, { model: "profile-model", instanceId });
  await page.addInitScript(
    ({ mapKey, projectId, instanceId }) => {
      localStorage.setItem(mapKey, JSON.stringify({
        [projectId]: { profileId: "buffered", profileInstanceId: instanceId },
      }));
    },
    { mapKey: PROJECT_PROFILE_MAP_STORAGE_KEY, projectId: project.projectId, instanceId },
  );
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, project, PROJECT_NAME);

  const readiness = page.locator(".run-readiness-slot");
  await expect(readiness).toContainText("Prompts recommend different run targets");
  await readiness.getByRole("button", { name: "Details" }).click();
  await expect(readiness).toContainText("Triage prompt");
  await expect(readiness).toContainText("triage-model");
  await expect(readiness).toContainText("Summary prompt");
  await expect(readiness).toContainText("summary-model");

  const preview = page.locator("details.request-preview");
  await preview.locator("summary").click();
  const resolved = preview.locator("#request-preview-resolved-panel");
  await expect(resolved.locator(".request-preview-message pre")).toHaveText([
    "Triage the rollback.",
    "Summarize the rollback.",
  ]);
  await preview.getByRole("tab", { name: "Raw" }).click();
  const raw = preview.locator("#request-preview-raw-panel");
  await expect(raw).toContainText('"model": "project-model"');
  await expect(raw).toContainText('"content": "Summarize the rollback."');
  await expect(preview).not.toContainText(/undefined|NaN|Infinity/);

  // Branch at the first generated message, leaving only Triage in the draft.
  await page.getByRole("button", { name: "Run current conversation ⌘↵" }).click();
  const transcript = page.getByLabel("Run transcript");
  await expect(transcript).toContainText("Buffered fixture response: 2 + 2 = 4.");
  await transcript.getByRole("button", { name: "Edit from here" }).first().click();
  const branch = page.getByRole("status").filter({ hasText: "Pending branch" });
  await expect(branch).toBeVisible();
  await expect(raw).toContainText('"content": "Triage the rollback."');
  await expect(raw).not.toContainText("Summarize the rollback.");

  // Discarding provenance leaves the truncated draft, but restores the full
  // pinned revision's resolution. The raw body must use that resolution too.
  await branch.getByRole("button", { name: "Discard branch" }).click();
  await expect(branch).toHaveCount(0);
  await expect(raw).toContainText('"content": "Summarize the rollback."');
  await preview.getByRole("tab", { name: "Resolved" }).click();
  await expect(resolved.locator(".request-preview-message pre")).toHaveText([
    "Triage the rollback.",
    "Summarize the rollback.",
  ]);
});
