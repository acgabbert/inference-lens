import { expect, test } from "./support/test";
import type { Page } from "./support/test";

import {
  createProjectFile,
  createPromptTemplate,
  insertPromptTemplateUse,
  parseProjectFile,
} from "../../packages/core/src/project";
import type { ProjectEnvironment } from "../../packages/core/src/environment";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  importProject,
  PROJECT_PROFILE_MAP_STORAGE_KEY,
  seedProfile,
  waitForHydration,
} from "./support";

const PROJECT_NAME = "Prompt environments fixture";

const staging: ProjectEnvironment = {
  id: "environment_staging",
  name: "Staging",
  entries: [
    { name: "customer", value: "Acme" },
    // Derived: a switch must change it through the entry it is built from.
    { name: "greeting", value: "Hello {{customer}}" },
  ],
};
const production: ProjectEnvironment = {
  id: "environment_production",
  name: "Production",
  entries: [
    { name: "customer", value: "Globex" },
    { name: "greeting", value: "Hello {{customer}}" },
  ],
};
const unfinished: ProjectEnvironment = {
  id: "environment_unfinished",
  name: "Unfinished",
  entries: [{ name: "greeting", value: "Hello {{nobody}}" }],
};

function environmentsProject() {
  let project = createProjectFile({
    name: PROJECT_NAME,
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "system", content: "Fixture system" }],
    },
    idSuffix: "prompt-environments",
    createdAt: "2026-10-29T12:00:00.000Z",
  });
  project = createPromptTemplate(project, {
    name: "Greeting prompt",
    messages: [{ role: "user", content: "{{greeting}} about {{topic}}" }],
    variableDefaults: { topic: "billing" },
    idSuffix: "greeting",
    createdAt: "2026-10-29T12:00:01.000Z",
  });
  project = createPromptTemplate(project, {
    name: "Account prompt",
    messages: [{ role: "user", content: "Account: {{customer}}" }],
    variableDefaults: {},
    idSuffix: "account",
    createdAt: "2026-10-29T12:00:02.000Z",
  });
  project = insertPromptTemplateUse(project, {
    conversationRevisionId: project.conversationRevisions[0]!.id,
    templateId: "template_greeting",
    values: {},
    idSuffix: "greeting",
    outputMessageIdSuffixes: ["greeting"],
  });
  // A value saved on the use outranks the environment, whichever is chosen.
  project = insertPromptTemplateUse(project, {
    conversationRevisionId: project.conversationRevisions[0]!.id,
    templateId: "template_account",
    values: { customer: "Initech" },
    idSuffix: "account",
    outputMessageIdSuffixes: ["account"],
  });
  return parseProjectFile({
    ...project,
    environments: [staging, production, unfinished],
    defaults: { ...project.defaults, environmentId: staging.id },
  });
}

/** The user messages of the next run, exactly as the browser sends them. */
async function runAndCaptureUserText(page: Page): Promise<string[]> {
  const outgoing = page.waitForRequest((request) =>
    new URL(request.url()).pathname === "/api/inference",
  );
  await page.getByRole("button", { name: /run current conversation/i }).first().click();
  const body = (await outgoing).postDataJSON() as {
    execution: { input: { messages: Array<{ role: string; content: Array<{ text?: string }> }> } };
  };
  await expect(page.locator(".response-pane")).toContainText("Buffered fixture response");
  return body.execution.input.messages
    .filter(({ role }) => role === "user")
    .map(({ content }) => content.map(({ text }) => text ?? "").join(""));
}

test("the same prompts render each environment's values, and an edit reaches the next run", async ({ page }) => {
  const project = environmentsProject();
  await seedProfile(page, { instanceId: "profile-instance-environments" });
  await page.addInitScript(({ mapKey, projectId }) => {
    localStorage.setItem(mapKey, JSON.stringify({
      [projectId]: { profileId: "buffered", profileInstanceId: "profile-instance-environments" },
    }));
  }, { mapKey: PROJECT_PROFILE_MAP_STORAGE_KEY, projectId: project.projectId });
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, project, PROJECT_NAME);

  const selector = page.getByRole("combobox", { name: "Environment", exact: true });
  // The project's default is the session's starting choice.
  await expect(selector).toHaveValue(staging.id);
  expect(await runAndCaptureUserText(page)).toEqual([
    "Hello Acme about billing",
    "Account: Initech",
  ]);

  await selector.selectOption({ label: "Production" });
  const greetingCard = page.locator('[data-template-use-id="template-use_greeting"]');
  const accountCard = page.locator('[data-template-use-id="template-use_account"]');
  await expect(greetingCard).toContainText("From environment “Production”");
  await expect(accountCard).toContainText("Saved in project · overrides “Production”");
  expect(await runAndCaptureUserText(page)).toEqual([
    "Hello Globex about billing",
    "Account: Initech",
  ]);

  // Edit Production in the drawer; the derived greeting follows the entry.
  await page.getByRole("button", { name: "Edit environments…" }).click();
  const drawer = page.getByRole("dialog", { name: "Environments" });
  await expect(drawer.getByRole("button", { name: /^Production/ })).toHaveAttribute("aria-pressed", "true");
  await drawer.getByLabel("Entry 1 value").fill("Umbrella");
  await expect(drawer.getByLabel("Resolved values")).toContainText("Hello Umbrella");
  await drawer.getByRole("button", { name: "Save", exact: true }).click();
  await drawer.getByRole("button", { name: "Close Environments" }).click();
  expect(await runAndCaptureUserText(page)).toEqual([
    "Hello Umbrella about billing",
    "Account: Initech",
  ]);
});

test("an unfinished entry a prompt uses refuses the run and opens on that entry", async ({ page }) => {
  const project = environmentsProject();
  await seedProfile(page, { instanceId: "profile-instance-environments" });
  await page.addInitScript(({ mapKey, projectId }) => {
    localStorage.setItem(mapKey, JSON.stringify({
      [projectId]: { profileId: "buffered", profileInstanceId: "profile-instance-environments" },
    }));
  }, { mapKey: PROJECT_PROFILE_MAP_STORAGE_KEY, projectId: project.projectId });
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, project, PROJECT_NAME);

  await page.getByRole("combobox", { name: "Environment", exact: true }).selectOption({ label: "Unfinished" });
  await expect(page.getByRole("button", { name: /run current conversation/i }).first()).toBeDisabled();
  await expect(page.getByText("Environment “Unfinished” has an unfinished entry this run uses")).toBeVisible();

  await page.getByRole("alert", { name: "Run readiness" }).getByRole("button", { name: "Edit the environment" }).click();
  const drawer = page.getByRole("dialog", { name: "Environments" });
  await expect(drawer.getByRole("button", { name: /^Unfinished/ })).toHaveAttribute("aria-pressed", "true");
  await expect(drawer.getByLabel("Entry 1 value")).toBeFocused();
});

test("the first environment is created from the Project menu and fills the prompt", async ({ page }) => {
  const base = environmentsProject();
  const project = parseProjectFile({
    ...base,
    environments: [],
    defaults: { ...base.defaults, environmentId: undefined },
  });
  await seedProfile(page, { instanceId: "profile-instance-environments" });
  await page.addInitScript(({ mapKey, projectId }) => {
    localStorage.setItem(mapKey, JSON.stringify({
      [projectId]: { profileId: "buffered", profileInstanceId: "profile-instance-environments" },
    }));
  }, { mapKey: PROJECT_PROFILE_MAP_STORAGE_KEY, projectId: project.projectId });
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, project, PROJECT_NAME);

  // No environments, no selector: it would only cost the composer a row.
  await expect(page.getByRole("combobox", { name: "Environment", exact: true })).toHaveCount(0);
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Environments…" }).click();
  const drawer = page.getByRole("dialog", { name: "Environments" });
  await drawer.getByRole("button", { name: "+ New environment" }).click();
  await drawer.getByLabel("Entry 1 name").fill("greeting");
  await drawer.getByLabel("Entry 1 value").fill("Hi there");
  await drawer.getByRole("button", { name: "Save", exact: true }).click();
  await drawer.getByRole("button", { name: "Use in composer" }).click();
  await drawer.getByRole("button", { name: "Close Environments" }).click();

  await expect(page.getByRole("combobox", { name: "Environment", exact: true })).toHaveValue(/^environment_/);
  expect(await runAndCaptureUserText(page)).toEqual([
    "Hi there about billing",
    "Account: Initech",
  ]);
});
