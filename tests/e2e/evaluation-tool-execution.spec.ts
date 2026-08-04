import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  createProjectFile,
  parseProjectFile,
  serializeProjectFile,
} from "../../packages/core/src/project";
import type { ProjectFile } from "../../packages/core/src/project";
import { createEntityId } from "../../packages/core/src/run-kernel";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  PROJECT_PROFILE_MAP_STORAGE_KEY,
  seedProfile,
  stubProjectDirectory,
  waitForHydration,
} from "./support";

/**
 * An evaluation suite that exposes a tool.
 *
 * The fixture's `tool-calling-model` echoes the tool message into its final
 * answer as `Chicago report: <text>`, so a `contains` check on the mock's text
 * passes only if the evaluation executed the tool and continued the run to a
 * second provider turn. A suite that merely finished would fail the check.
 */
const MOCK_TEXT = "72°F and clear";
const PROFILE_INSTANCE_ID = "profile-instance-evaluation-tools";
const TOOL_ID = createEntityId("tool", "evaluation-weather");

/** One suite, one case, one check — with or without a mock to serve the tool. */
function fixtureProject(options: { mocked: boolean }): ProjectFile {
  const initial = createProjectFile({
    name: "Evaluation tool fixture",
    idSuffix: "evaluation-tools",
    createdAt: "2026-08-04T11:00:00.000Z",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "tool-calling-model",
      messages: [{ role: "user", content: "What is the weather in Chicago?" }],
    },
  });
  return parseProjectFile({
    ...initial,
    tools: [{
      id: TOOL_ID,
      name: "get_weather",
      description: "Look up current weather.",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    }],
    toolMocks: options.mocked
      ? [{
          id: createEntityId("tool-mock", "evaluation-sunny"),
          toolId: TOOL_ID,
          name: "sunny default",
          enabled: true,
          match: { kind: "always" },
          result: { content: [{ type: "text", text: MOCK_TEXT }] },
        }]
      : [],
    evaluationSuites: [{
      id: "evaluation-suite_weather",
      name: "Weather quality",
      input: {
        kind: "conversation-revision",
        conversationRevisionId: initial.defaults.conversationRevisionId,
      },
      execution: {
        target: { ...initial.defaults.target, model: "tool-calling-model" },
        responseMode: "buffered",
        options: {},
        repetitions: 1,
        toolIds: [TOOL_ID],
      },
      inputBindings: [],
      cases: [{
        id: "evaluation-case_chicago",
        name: "Chicago",
        values: {},
        // Only reachable through the tool: the model has no weather of its own.
        checks: [{
          checkId: "check_reports-mock",
          kind: "contains",
          value: MOCK_TEXT,
          caseSensitive: false,
        }],
      }],
    }],
  });
}

async function openEvaluations(page: Page, project: ProjectFile): Promise<void> {
  await seedProfile(page, {
    model: "tool-calling-model",
    favoriteModels: ["tool-calling-model"],
    capabilityOverrides: { tools: true },
    instanceId: PROFILE_INSTANCE_ID,
  });
  await page.addInitScript(
    ({ mapKey, projectId, instanceId }) => {
      localStorage.setItem(
        mapKey,
        JSON.stringify({
          [projectId]: { profileId: "buffered", profileInstanceId: instanceId },
        }),
      );
    },
    {
      mapKey: PROJECT_PROFILE_MAP_STORAGE_KEY,
      projectId: project.projectId,
      instanceId: PROFILE_INSTANCE_ID,
    },
  );
  await stubProjectDirectory(page, {
    name: "evaluation-tools-fixture",
    files: { "project.json": serializeProjectFile(project) },
    directories: ["traces", "experiments"],
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project…" }).click();
  await expect(page.locator(".brand")).toContainText("Evaluation tool fixture");
  await page.evaluate(() => {
    document
      .querySelectorAll<HTMLDetailsElement>("details.project-menu")
      .forEach((menu) => {
        menu.open = false;
      });
  });
  await page.getByRole("tab", { name: /Evaluations/ }).click();
}

test("an evaluation serves its suite's tool calls and checks the answer they produced", async ({
  page,
}) => {
  await openEvaluations(page, fixtureProject({ mocked: true }));

  const editor = page.locator(".evaluation-editor");
  // Exposure is suite content; what serves it is this device's.
  await expect(editor.locator(".evaluation-tools")).toContainText("1 exposed");
  await expect(editor.locator(".evaluation-tools")).toContainText("get_weather");
  await expect(editor.locator(".evaluation-tools")).toContainText('mock "sunny default"');
  // The floor is one call per repetition; the ceiling is what it may become.
  await expect(editor).toContainText("up to 5 provider calls");
  await expect(editor).toContainText("Ready to run");

  await editor.getByRole("button", { name: "Start evaluation…" }).click();
  const confirmation = page.getByRole("dialog", { name: /Start “Weather quality”/ });
  await expect(confirmation).toContainText("Tools served automatically");
  await expect(confirmation).toContainText('mock "sunny default"');
  await expect(confirmation).toContainText("1–5");
  await confirmation.getByRole("button", { name: "Start 1 repetition" }).click();

  const results = page.locator(".evaluation-results-workspace");
  // The check passes only because the mock's text came back through the
  // provider's second turn, which requires the evaluation to have executed the
  // tool and continued the run itself.
  await expect(results).toContainText("1 / 1 passed", { timeout: 20_000 });
  await expect(results).not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);
  await results.getByRole("button", { name: "Open Response & Inspect" }).first().click();
  await expect(page.getByLabel("Run transcript")).toContainText(
    `Chicago report: ${MOCK_TEXT}`,
  );
});

test("a suite whose tool nothing can serve is blocked before any provider call", async ({
  page,
}) => {
  await openEvaluations(page, fixtureProject({ mocked: false }));

  const editor = page.locator(".evaluation-editor");
  // Marked per row, and counted as a setup issue: the preflight badge must not
  // read "Ready to run" beside a Start button that refuses.
  await expect(editor.locator(".evaluation-tools")).toContainText(
    "get_weather → nothing on this device",
  );
  await expect(editor).toContainText("1 setup issue");
  await expect(editor.locator(".evaluation-diagnostics")).toContainText(
    "Nothing on this device serves get_weather",
  );
  const start = editor.getByRole("button", { name: "Start evaluation…" });
  await expect(start).toBeDisabled();
  await expect(editor).toContainText(
    "This suite exposes get_weather, and nothing on this device can serve it",
  );
  await expect(editor).not.toContainText("Ready to run");

  // No confirmation, no execution, and therefore no provider call: the results
  // workspace never appears.
  await expect(page.getByRole("dialog", { name: /Start “Weather quality”/ })).toHaveCount(0);
  await expect(page.locator(".evaluation-results-workspace")).toHaveCount(0);
});
