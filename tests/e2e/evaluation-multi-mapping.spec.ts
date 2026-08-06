import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { INFERENCE_API_PATH } from "../../packages/contracts/src/inference";
import {
  createProjectFile,
  parseProjectFile,
  type ProjectFile,
} from "../../packages/core/src/project";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  importProject,
  openMode,
  primaryAction,
  seedProfiles,
  waitForHydration,
} from "./support";

const FIRST_PROFILE = {
  id: "bakeoff-first",
  instanceId: "profile-instance-bakeoff-first",
  name: "Bakeoff first profile",
  endpoint: BUFFERED_FIXTURE_ENDPOINT,
  model: "provider-default-temperature-model",
};
const SECOND_PROFILE = {
  id: "bakeoff-second",
  instanceId: "profile-instance-bakeoff-second",
  name: "Bakeoff second profile",
  endpoint: BUFFERED_FIXTURE_ENDPOINT,
  model: "echo-temperature-model",
};

function multiMappingProject(): ProjectFile {
  const initial = createProjectFile({
    name: "Multi-mapping bakeoff",
    idSuffix: "multi-mapping-bakeoff",
    createdAt: "2026-08-05T18:00:00.000Z",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "provider-default-temperature-model",
      messages: [{ role: "user", content: "Describe a safe migration." }],
    },
  });
  const firstRequirement = {
    ...initial.connectionRequirements[0]!,
    name: "Primary provider",
  };
  const secondRequirement = {
    ...firstRequirement,
    id: "connection_secondary" as const,
    name: "Secondary provider",
  };
  return parseProjectFile({
    ...initial,
    connectionRequirements: [firstRequirement, secondRequirement],
    evaluationSuites: [{
      id: "evaluation-suite_bakeoff",
      name: "Mapped provider bakeoff",
      input: {
        kind: "conversation-revision",
        conversationRevisionId: initial.defaults.conversationRevisionId,
      },
      execution: {
        target: {
          connectionRequirementId: firstRequirement.id,
          model: "provider-default-temperature-model",
        },
        responseMode: "buffered",
        options: {},
        repetitions: 2,
        toolIds: [],
      },
      variants: [
        { id: "evaluation-variant_primary", name: "Primary", overrides: {} },
        {
          id: "evaluation-variant_secondary",
          name: "Secondary",
          overrides: {
            target: {
              connectionRequirementId: secondRequirement.id,
              model: "echo-temperature-model",
            },
            options: { temperature: 0.7 },
          },
        },
      ],
      inputBindings: [],
      cases: [
        { id: "evaluation-case_migrations", name: "Migrations", values: {}, checks: [{ checkId: "check_provider_1", kind: "contains", value: "Provider", caseSensitive: false }] },
        { id: "evaluation-case_indexes", name: "Indexes", values: {}, checks: [{ checkId: "check_provider_2", kind: "contains", value: "Provider", caseSensitive: false }] },
      ],
    }],
  });
}

async function openProject(page: Page): Promise<void> {
  await seedProfiles(page, [FIRST_PROFILE, SECOND_PROFILE], FIRST_PROFILE.id);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await waitForHydration(page, FIRST_PROFILE.name);
  await importProject(page, multiMappingProject(), "Multi-mapping bakeoff");
  await openMode(page, "Evaluations");
}

async function openMappings(page: Page) {
  await page.getByLabel(/^Run target:/).click();
  await page.getByRole("button", { name: /manage connections/i }).click();
  return page.getByRole("dialog", { name: "Connections" });
}

test("two connection mappings drive the complete case × configuration × repetition grid", async ({ page }) => {
  await openProject(page);
  const connections = await openMappings(page);
  await connections.getByLabel("Profile for Primary provider").selectOption(FIRST_PROFILE.id);
  await connections.getByLabel("Profile for Secondary provider").selectOption(SECOND_PROFILE.id);
  await connections.getByRole("button", { name: /close connections/i }).click();

  const editor = page.locator(".evaluation-editor");
  await expect(editor).toContainText("2 cases × 2 configurations × 2 reps → 8 runs");
  await expect(editor.getByLabel("Resolved local configuration targets")).toContainText(
    "Primary: Bakeoff first profile",
  );
  await expect(editor.getByLabel("Resolved local configuration targets")).toContainText(
    "Secondary: Bakeoff second profile",
  );
  await expect(editor).toContainText("Ready to run");

  const requests: Array<{ model: string; temperature?: number; responseMode: string }> = [];
  await page.route(`**${INFERENCE_API_PATH}`, async (route) => {
    const payload = route.request().postDataJSON() as {
      execution: {
        input: {
          target: { model: string };
          options: { temperature?: number };
          responseMode: string;
        };
      };
    };
    requests.push({
      model: payload.execution.input.target.model,
      ...(payload.execution.input.options.temperature === undefined
        ? {}
        : { temperature: payload.execution.input.options.temperature }),
      responseMode: payload.execution.input.responseMode,
    });
    await route.continue();
  });

  await primaryAction(page, "evaluations").click();
  const confirmation = page.getByRole("dialog", { name: /Start “Mapped provider bakeoff”/ });
  await expect(confirmation).toContainText("Primary: Bakeoff first profile");
  await expect(confirmation).toContainText("Secondary: Bakeoff second profile");
  await expect(confirmation).toContainText("2 per case and configuration");
  await expect(confirmation).toContainText("8 planned");
  await confirmation.getByRole("button", { name: "Start 8 calls" }).click();

  await expect.poll(() => requests.length).toBe(8);
  expect(requests).toEqual([
    { model: "provider-default-temperature-model", responseMode: "buffered" },
    { model: "provider-default-temperature-model", responseMode: "buffered" },
    { model: "echo-temperature-model", temperature: 0.7, responseMode: "buffered" },
    { model: "echo-temperature-model", temperature: 0.7, responseMode: "buffered" },
    { model: "provider-default-temperature-model", responseMode: "buffered" },
    { model: "provider-default-temperature-model", responseMode: "buffered" },
    { model: "echo-temperature-model", temperature: 0.7, responseMode: "buffered" },
    { model: "echo-temperature-model", temperature: 0.7, responseMode: "buffered" },
  ]);
  const results = page.locator(".evaluation-results-workspace");
  await expect(results).not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);
});

test("one unmapped selected configuration refuses the whole bakeoff with zero requests", async ({ page }) => {
  await openProject(page);
  const connections = await openMappings(page);
  await connections.getByLabel("Profile for Primary provider").selectOption(FIRST_PROFILE.id);
  await connections.getByRole("button", { name: /close connections/i }).click();

  let requests = 0;
  await page.route(`**${INFERENCE_API_PATH}`, async (route) => {
    requests += 1;
    await route.abort();
  });
  const editor = page.locator(".evaluation-editor");
  await expect(editor).toContainText(
    "Map “Secondary provider” to a local profile for configuration “Secondary”.",
  );
  await expect(primaryAction(page, "evaluations")).toBeDisabled();
  await expect(page.locator(".evaluation-results-workspace")).toHaveCount(0);
  expect(requests).toBe(0);
});
