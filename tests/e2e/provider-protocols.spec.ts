import { expect, test } from "@playwright/test";

import { createProjectFile } from "../../packages/core/src/project";
import type { ProjectFile } from "../../packages/core/src/project";
import { createEntityId } from "../../packages/core/src/run-kernel";
import type { Page } from "@playwright/test";

import {
  ANTHROPIC_FIXTURE_ENDPOINT,
  BUFFERED_FIXTURE_ENDPOINT,
  PROFILE_STORAGE_KEY,
  PROJECT_PROFILE_MAP_STORAGE_KEY,
  PROJECT_REQUIREMENT_PROFILE_MAP_STORAGE_KEY,
  RESPONSES_FIXTURE_ENDPOINT,
  importProject,
  openInferenceSettings,
  seedProfile,
  seedProfiles,
  waitForHydration,
} from "./support";

/** A profile that speaks only Responses, so nothing can fall back to chat. */
const RESPONSES_ONLY = { chatCompletions: false, responsesApi: true };

/**
 * A project states the protocol its runs use; a profile states which ones its
 * endpoint speaks. These specs drive the join between the two through the UI.
 */
test("a project's protocol blocks a profile that lacks it until the profile enables it", async ({ page }) => {
  const project = createProjectFile({
    name: "Responses project",
    request: {
      provider: "openai-compatible",
      protocol: "openai-responses",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Hello" }],
    },
    idSuffix: "responses-protocol",
    createdAt: "2026-10-08T12:00:00.000Z",
  });
  const requirementId = project.defaults.target.connectionRequirementId;
  await seedProfiles(page, [{
    id: "buffered",
    instanceId: "profile-instance-buffered",
    name: "Chat only fixture",
    endpoint: BUFFERED_FIXTURE_ENDPOINT,
  }], "buffered");
  await page.addInitScript(({ mapKey, projectId, requirementId }) => {
    localStorage.setItem(mapKey, JSON.stringify({
      [projectId]: {
        [requirementId]: {
          profileId: "buffered",
          profileInstanceId: "profile-instance-buffered",
        },
      },
    }));
  }, {
    mapKey: PROJECT_REQUIREMENT_PROFILE_MAP_STORAGE_KEY,
    projectId: project.projectId,
    requirementId,
  });

  await page.goto("/");
  await expect(page.locator(".topbar")).toContainText("Chat only fixture");
  await importProject(page, project, "Responses project");

  const run = page.getByRole("button", { name: /run current conversation/i });
  await expect(run).toBeDisabled();
  await expect(page.getByText('"Chat only fixture" does not have Responses enabled').first()).toBeVisible();

  // The settings say the same thing in their own place: the project's choice
  // stays selected and marked rather than being silently replaced.
  const settings = await openInferenceSettings(page);
  const protocol = settings.getByLabel("Protocol");
  await expect(protocol).toHaveValue("openai-responses");
  await expect(protocol.locator("option:checked")).toHaveText("Responses (not enabled)");

  await page.getByRole("button", { name: "Enable Responses" }).first().click();
  const drawer = page.getByRole("dialog", { name: "Connections" });
  const responsesSwitch = drawer.getByRole("checkbox", { name: /^Responses/ });
  await expect(responsesSwitch).toBeFocused();
  await responsesSwitch.check();
  await drawer.getByRole("button", { name: /close/i }).first().click();

  await expect(page.getByText('"Chat only fixture" does not have Responses enabled')).toHaveCount(0);
  await expect(protocol.locator("option:checked")).toHaveText("Responses");
  await expect(run).toBeEnabled();
});

test("without a project, the protocol picked in Run settings is the profile's own", async ({ page }) => {
  await seedProfiles(page, [{
    id: "buffered",
    instanceId: "profile-instance-buffered",
    name: "Two protocol fixture",
    endpoint: BUFFERED_FIXTURE_ENDPOINT,
    capabilityOverrides: { responsesApi: true },
  }], "buffered");
  await page.goto("/");
  await expect(page.locator(".topbar")).toContainText("Two protocol fixture");

  const settings = await openInferenceSettings(page);
  const protocol = settings.getByLabel("Protocol");
  await expect(protocol.locator("option")).toHaveText(["Chat Completions", "Responses"]);
  await protocol.selectOption("openai-responses");
  await expect(settings.locator(".inference-settings-fact").first()).toHaveText("Responses");

  // Stored on the profile, not in session state. A reload cannot show this
  // here: `seedProfiles` is an init script and would re-seed the profile.
  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), PROFILE_STORAGE_KEY);
  expect(stored.profiles[0].protocol).toBe("openai-responses");
});

test("a streamed Responses run shows its reasoning, answer, and the request it sent", async ({ page }) => {
  await seedProfile(page, {
    endpoint: RESPONSES_FIXTURE_ENDPOINT,
    model: "responses-text-model",
    streaming: "stream",
    capabilityOverrides: RESPONSES_ONLY,
  });
  await page.goto("/");
  await waitForHydration(page);

  await page.getByRole("button", { name: /run current conversation/i }).click();
  const response = page.locator(".response-pane");
  await expect(response).toContainText("Responses fixture answer: 2 + 2 = 4.");
  // Two summary deltas, joined: proves the reasoning events were read, not
  // only the final text.
  await expect(response.locator(".reasoning-stream").first()).toContainText("Adding two and two.");
  await expect(response).not.toContainText(/NaN|undefined|Infinity/);

  await page.getByRole("button", { name: "Run details" }).click();
  await page.getByRole("tab", { name: "Events" }).click();
  const evidence = page.locator(".request-evidence").first();
  await expect(evidence).toContainText(`${RESPONSES_FIXTURE_ENDPOINT}/responses`);
  await expect(evidence).toContainText("authorization");
  await expect(evidence).toContainText('"store": false');
  await expect(evidence).not.toContainText('"messages"');
});

function responsesToolProject(): ProjectFile {
  const project = createProjectFile({
    name: "Responses tool fixture",
    idSuffix: "responses-tool",
    createdAt: "2026-10-08T12:00:00.000Z",
    request: {
      provider: "openai-compatible",
      protocol: "openai-responses",
      endpoint: RESPONSES_FIXTURE_ENDPOINT,
      model: "responses-tool-model",
      messages: [{ role: "user", content: "What is the weather in Chicago?" }],
    },
  });
  const toolId = createEntityId("tool", "responses-weather");
  return {
    ...project,
    tools: [{
      id: toolId,
      name: "get_weather",
      description: "Look up current weather.",
      inputSchema: { type: "object", properties: { city: { type: "string" } } },
    }],
    toolMocks: [{
      id: createEntityId("tool-mock", "responses-sunny"),
      toolId,
      name: "sunny default",
      enabled: true,
      match: { kind: "always" },
      result: { content: [{ type: "text", text: "72°F and clear" }] },
    }],
    defaults: { ...project.defaults, enabledToolIds: [toolId] },
  };
}

test("a Responses tool call round-trips its call and output under one call id", async ({ page }) => {
  const project = responsesToolProject();
  await seedProfile(page, {
    endpoint: RESPONSES_FIXTURE_ENDPOINT,
    model: "responses-tool-model",
    capabilityOverrides: { ...RESPONSES_ONLY, tools: true },
    instanceId: "profile-instance-responses",
  });
  await page.addInitScript(({ mapKey, projectId }) => {
    localStorage.setItem(mapKey, JSON.stringify({
      [projectId]: { profileId: "buffered", profileInstanceId: "profile-instance-responses" },
    }));
  }, { mapKey: PROJECT_PROFILE_MAP_STORAGE_KEY, projectId: project.projectId });
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, project, "Responses tool fixture");

  await page.getByRole("button", { name: /^Run current conversation/ }).first().click();
  const card = page.locator(".tool-call-card");
  await expect(card).toContainText("get_weather");
  await expect(card.locator("textarea")).toHaveValue("72°F and clear");
  await page.getByRole("button", { name: "Supply results and continue" }).click();

  // The fixture answers the second turn only when it carries the function
  // call and its output under the same call_id, so this text on screen is the
  // round trip, not merely a rendered card.
  await expect(page.locator(".transcript-list")).toContainText("Chicago report: 72°F and clear");
});

/** A profile that speaks only Anthropic Messages. */
const ANTHROPIC_ONLY = { chatCompletions: false, anthropicMessages: true };

/** Types the fixture's key into Connections, the way a user supplies a session key. */
async function enterSessionKey(page: Page): Promise<void> {
  await page.getByLabel(/^Run target:/).click();
  await page.getByRole("button", { name: /manage connections/i }).click();
  const connections = page.getByRole("dialog", { name: "Connections" });
  await connections.getByLabel(/^API key/).fill("fixture-anthropic-key");
  await connections.getByLabel(/^API key/).blur();
  await connections.getByRole("button", { name: /close/i }).first().click();
}

test("a streamed Anthropic run sends its key as x-api-key and shows thinking and answer", async ({ page }) => {
  await seedProfile(page, {
    endpoint: ANTHROPIC_FIXTURE_ENDPOINT,
    model: "claude-fixture-text",
    streaming: "stream",
    capabilityOverrides: ANTHROPIC_ONLY,
  });
  await page.goto("/");
  await waitForHydration(page);
  await enterSessionKey(page);

  // A profile that speaks only Anthropic runs it without being told.
  const settings = await openInferenceSettings(page);
  await expect(settings.locator(".inference-settings-fact").first()).toHaveText("Anthropic Messages");

  await page.getByRole("button", { name: /run current conversation/i }).click();
  const response = page.locator(".response-pane");
  // The fixture refuses any request without x-api-key and anthropic-version,
  // and any with Authorization, so this answer is the credential arriving.
  await expect(response).toContainText("Anthropic fixture answer: 2 + 2 = 4.");
  await expect(response.locator(".reasoning-stream").first()).toContainText("Adding two and two.");
  await expect(response).not.toContainText(/NaN|undefined|Infinity/);

  await page.getByRole("button", { name: "Run details" }).click();
  await page.getByRole("tab", { name: "Events" }).click();
  const evidence = page.locator(".request-evidence").first();
  await expect(evidence).toContainText(`${ANTHROPIC_FIXTURE_ENDPOINT}/messages`);
  await expect(evidence).toContainText("x-api-key");
  await expect(evidence).toContainText("anthropic-version");
  await expect(evidence).not.toContainText("fixture-anthropic-key");
  await expect(evidence).toContainText('"max_tokens": 4096');
});

test("model discovery lists an Anthropic catalogue with the Anthropic credential", async ({ page }) => {
  await seedProfile(page, {
    endpoint: ANTHROPIC_FIXTURE_ENDPOINT,
    model: "",
    capabilityOverrides: ANTHROPIC_ONLY,
  });
  await page.goto("/");
  await waitForHydration(page);
  await enterSessionKey(page);
  const settings = await openInferenceSettings(page);
  await settings.locator('[data-readiness-control="model"]').click();
  await expect(page.getByRole("option", { name: "claude-fixture-tool" })).toBeVisible();
});

function anthropicToolProject(): ProjectFile {
  const project = responsesToolProject();
  return {
    ...project,
    name: "Anthropic tool fixture",
    connectionRequirements: project.connectionRequirements.map((requirement) => ({
      ...requirement,
      protocol: "anthropic-messages" as const,
      endpoint: ANTHROPIC_FIXTURE_ENDPOINT,
    })),
    defaults: { ...project.defaults, target: { ...project.defaults.target, model: "claude-fixture-tool" } },
  };
}

test("an Anthropic tool call round-trips its tool_use and tool_result under one id", async ({ page }) => {
  const project = anthropicToolProject();
  await seedProfile(page, {
    endpoint: ANTHROPIC_FIXTURE_ENDPOINT,
    model: "claude-fixture-tool",
    capabilityOverrides: { ...ANTHROPIC_ONLY, tools: true },
    instanceId: "profile-instance-anthropic",
  });
  await page.addInitScript(({ mapKey, projectId }) => {
    localStorage.setItem(mapKey, JSON.stringify({
      [projectId]: { profileId: "buffered", profileInstanceId: "profile-instance-anthropic" },
    }));
  }, { mapKey: PROJECT_PROFILE_MAP_STORAGE_KEY, projectId: project.projectId });
  await page.goto("/");
  await waitForHydration(page);
  await enterSessionKey(page);
  await importProject(page, project, "Anthropic tool fixture");

  await page.getByRole("button", { name: /^Run current conversation/ }).first().click();
  const card = page.locator(".tool-call-card");
  await expect(card).toContainText("get_weather");
  await page.getByRole("button", { name: "Supply results and continue" }).click();
  await expect(page.locator(".transcript-list")).toContainText("Chicago report: 72°F and clear");
});
