import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  createProjectFile,
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
 * The command executor against a real process, in the real app.
 *
 * The fixture catalog that makes this possible is declared to the dev server
 * in playwright.config.ts, which is also the point: nothing in this app can
 * spawn anything until an operator says so, so a spec that could run without
 * that variable would be testing a different product.
 */

const mockText = "72°F and clear";
const commandText = "61F and drizzle in Chicago, measured by get_weather";

/**
 * A project whose one tool has an *enabled* mock.
 *
 * The mock is not incidental. Its text differs from the command's, so the
 * transcript alone proves which binding answered — and the precedence rule
 * (a grant on this device outranks a mock that arrived with the project) is
 * checked against the running app rather than only against a unit test.
 */
function toolFixtureProject(): ProjectFile {
  const project = createProjectFile({
    name: "Command tool fixture",
    idSuffix: "command-tool",
    createdAt: "2026-08-04T11:00:00.000Z",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "tool-calling-model",
      messages: [{ role: "user", content: "What is the weather in Chicago?" }],
    },
  });
  const toolId = createEntityId("tool", "command-tool-weather");
  return {
    ...project,
    tools: [
      {
        id: toolId,
        name: "get_weather",
        description: "Look up current weather.",
        inputSchema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ],
    toolMocks: [
      {
        id: createEntityId("tool-mock", "command-tool-sunny"),
        toolId,
        name: "sunny default",
        enabled: true,
        match: { kind: "always" },
        result: { content: [{ type: "text", text: mockText }] },
      },
    ],
    defaults: { ...project.defaults, enabledToolIds: [toolId] },
  };
}

const PROFILE_INSTANCE_ID = "profile-instance-command-tool";

async function openFixtureProject(page: Page): Promise<void> {
  const project = toolFixtureProject();
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
    name: "command-tool-fixture",
    files: { "project.json": serializeProjectFile(project) },
    directories: ["traces"],
  });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project…" }).click();
  await expect(page.locator(".brand")).toContainText("Command tool fixture");
  await page.evaluate(() => {
    document
      .querySelectorAll<HTMLDetailsElement>("details.project-menu")
      .forEach((menu) => {
        menu.open = false;
      });
  });
}

/** Grants one declared command through the consent surface, as a user does. */
async function allowCommand(page: Page, label: string): Promise<void> {
  await page.getByRole("tab", { name: "Tools" }).click();
  const fields = page.locator(".tool-command-fields");
  await expect(fields).toBeVisible();
  await fields.getByLabel("Command tool for get_weather").selectOption({ label });
  await fields.getByRole("button", { name: /^Allow / }).click();
  await expect(fields).toContainText("answers get_weather on this device");
  await page.getByRole("tab", { name: "Messages" }).click();
}

async function savedTrace(page: Page): Promise<{
  schemaVersion: number;
  events: { type: string; [key: string]: unknown }[];
  toolExecutions: Record<string, unknown>[];
  toolResults: Record<string, unknown>[];
  raw: string;
}> {
  return page.evaluate(async () => {
    const root = await (
      window as unknown as {
        showDirectoryPicker(): Promise<{
          getDirectoryHandle(name: string): Promise<{
            values(): AsyncIterable<{ getFile(): Promise<File> }>;
          }>;
        }>;
      }
    ).showDirectoryPicker();
    const traces = await root.getDirectoryHandle("traces");
    for await (const entry of traces.values()) {
      const raw = await (await entry.getFile()).text();
      return { ...JSON.parse(raw), raw };
    }
    throw new Error("No trace was written to the project folder.");
  });
}

test("a granted command answers the call, and the trace says which one", async ({
  page,
}) => {
  await openFixtureProject(page);
  await allowCommand(page, "Local weather script");

  await page.getByRole("button", { name: /^Run/ }).first().click();

  const card = page.locator(".tool-call-card");
  await expect(card).toContainText("get_weather");
  // Nothing is prefilled, and the card says what continuing will do — the
  // difference between this and a call waiting on a human.
  await expect(card.locator("textarea")).toHaveValue("");
  await expect(card.locator(".tool-call-pending-executor")).toContainText(
    "Continuing runs the command tool “Local weather script” on this device.",
  );
  await expect(card.locator(".provider-pill")).toHaveText("Command tool");

  await page.getByRole("button", { name: "Supply results and continue" }).click();

  const transcript = page.locator(".transcript-list");
  // The command's own text, carrying the city it read from the model's
  // arguments on stdin. The project's enabled mock says something else, so
  // this is also the precedence rule, checked in the app.
  await expect(transcript).toContainText(`Chicago report: ${commandText}`);
  await expect(transcript).not.toContainText(mockText);
  await expect(transcript.locator(".transcript-tool-result")).toContainText(
    /Returned by command tool “Local weather script” in \d+ ms\./,
  );

  const trace = await savedTrace(page);
  expect(trace.schemaVersion).toBe(6);
  expect(
    trace.events.map(({ type }) => type).filter((type) => type.startsWith("tool.")),
  ).toEqual([
    "tool.execution_started",
    "tool.execution_completed",
    "tool.result_supplied",
  ]);
  expect(trace.toolExecutions[0]!.executor).toEqual({
    kind: "command",
    executorId: "weather",
    label: "Local weather script",
  });
  expect(trace.toolResults[0]!.resolution).toEqual({
    kind: "live",
    executorId: "weather",
  });
  // Device-local configuration must not reach a portable artifact: not the
  // path that ran, not the arguments it ran with, not when it was allowed.
  expect(trace.raw).not.toContain("weather.mjs");
  expect(trace.raw).not.toContain("grantedAt");
  expect(trace.raw).not.toContain("fixtures/command-tools");
});

test("a command that hangs times out, and the call stays answerable by hand", async ({
  page,
}) => {
  await openFixtureProject(page);
  await allowCommand(page, "Weather script that hangs");

  await page.getByRole("button", { name: /^Run/ }).first().click();
  await expect(page.locator(".tool-call-card")).toBeVisible();
  await page.getByRole("button", { name: "Supply results and continue" }).click();

  // The timeout is the command's own, declared in the catalog at 1000ms.
  const notice = page.locator(".project-error, .app-error, [role='alert']").first();
  await expect(notice).toContainText(
    /get_weather could not be executed: The command tool “Weather script that hangs” did not finish within 1000ms/,
  );
  await expect(notice).toContainText("Supply a result by hand to continue.");

  // A failed execution never fabricates a result: the call is still pending,
  // and the draft has stopped promising an executor.
  const card = page.locator(".tool-call-card");
  await expect(card.locator(".tool-call-pending-executor")).toHaveCount(0);
  await card.locator("textarea").fill("Answered by hand after the timeout");
  await page.getByRole("button", { name: "Supply results and continue" }).click();

  const transcript = page.locator(".transcript-list");
  await expect(transcript).toContainText(
    "Chicago report: Answered by hand after the timeout",
  );
  // The value on screen came from the person, so that is stated first; the
  // failed attempt follows as evidence rather than as its provenance.
  await expect(transcript.locator(".transcript-tool-result")).toContainText(
    /Supplied by hand\. Timed out after running command tool “Weather script that hangs” in [\d.]+ s\./,
  );

  const text = await transcript.innerText();
  expect(text.match(/NaN|Infinity|undefined|\[object/g)).toBeNull();
});
