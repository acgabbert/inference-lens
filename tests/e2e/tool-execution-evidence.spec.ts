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

const mockText = "72°F and clear";

/**
 * A project whose one tool is served by an enabled mock.
 *
 * The mock's text is deliberately distinctive: the fixture provider echoes the
 * tool message back into the final answer, so seeing it on screen proves the
 * executor's value reached the provider, rather than proving only that a card
 * rendered.
 */
function toolFixtureProject(): ProjectFile {
  const project = createProjectFile({
    name: "Tool execution fixture",
    idSuffix: "tool-execution",
    createdAt: "2026-08-04T11:00:00.000Z",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "tool-calling-model",
      messages: [{ role: "user", content: "What is the weather in Chicago?" }],
    },
  });
  const toolId = createEntityId("tool", "tool-execution-weather");
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
        id: createEntityId("tool-mock", "tool-execution-sunny"),
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

const PROFILE_INSTANCE_ID = "profile-instance-tool-execution";

/**
 * Opens the fixture with its connection already mapped and tool calling
 * allowed. Both are prerequisites rather than the subject: the openai-compatible
 * baseline turns tool calling off, so without the override the request is built
 * with no tools and the fixture refuses it.
 */
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
    name: "tool-execution-fixture",
    files: { "project.json": serializeProjectFile(project) },
    directories: ["traces"],
  });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project…" }).click();
  await expect(page.locator(".brand")).toContainText("Tool execution fixture");
  await page.evaluate(() => {
    document
      .querySelectorAll<HTMLDetailsElement>("details.project-menu")
      .forEach((menu) => {
        menu.open = false;
      });
  });
}

/** Reads the trace the app actually wrote into the stubbed project folder. */
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

test("a mocked tool call records who executed it, and the evidence survives the trace", async ({
  page,
}) => {
  await openFixtureProject(page);

  await page.getByRole("button", { name: /^Run request/ }).first().click();

  const card = page.locator(".tool-call-card");
  await expect(card).toContainText("get_weather");
  await expect(card.locator("textarea")).toHaveValue(mockText);
  // The pause is unchanged: nothing has executed yet, so there is no
  // provenance line to read.
  await expect(card.locator(".tool-call-provenance")).toHaveCount(0);

  await page.getByRole("button", { name: "Supply results and continue" }).click();

  const transcript = page.locator(".transcript-list");
  await expect(transcript).toContainText(`Chicago report: ${mockText}`);
  // The finished transcript is where a saved run gets inspected, so the
  // executor is named there rather than only while the run is live.
  await expect(transcript.locator(".transcript-tool-result")).toContainText(
    /Tool result for get_weather · Returned by mock “sunny default” in \d+ ms\./,
  );

  const trace = await savedTrace(page);
  expect(trace.schemaVersion).toBe(6);
  expect(
    trace.events
      .map(({ type }) => type)
      .filter((type) => type.startsWith("tool.")),
  ).toEqual([
    "tool.execution_started",
    "tool.execution_completed",
    "tool.result_supplied",
  ]);
  expect(trace.toolExecutions).toHaveLength(1);
  expect(trace.toolExecutions[0]!.executor).toEqual({
    kind: "mock",
    executorId: "tool-mock_tool-execution-sunny",
    label: "sunny default",
  });
  expect(trace.toolExecutions[0]!.status).toBe("completed");
  expect(typeof trace.toolExecutions[0]!.durationMs).toBe("number");
  expect(trace.toolResults[0]!.resolution).toEqual({
    kind: "mock",
    ruleId: "tool-mock_tool-execution-sunny",
  });
  // Ordering the reducer enforces, restated against the artifact: the result is
  // supplied after its execution settles, never before.
  const started = trace.events.findIndex(
    ({ type }) => type === "tool.execution_started",
  );
  const completed = trace.events.findIndex(
    ({ type }) => type === "tool.execution_completed",
  );
  const supplied = trace.events.findIndex(
    ({ type }) => type === "tool.result_supplied",
  );
  expect(started).toBeLessThan(completed);
  expect(completed).toBeLessThan(supplied);
  expect(trace.raw).not.toContain('"binding"');
});

test("editing a mocked draft makes the result manual, and says so", async ({
  page,
}) => {
  await openFixtureProject(page);
  await page.getByRole("button", { name: /^Run request/ }).first().click();

  const card = page.locator(".tool-call-card");
  await expect(card.locator("textarea")).toHaveValue(mockText);
  await card.locator("textarea").fill("Snowing hard");
  await page.getByRole("button", { name: "Supply results and continue" }).click();

  const transcript = page.locator(".transcript-list");
  await expect(transcript).toContainText("Chicago report: Snowing hard");
  await expect(transcript.locator(".transcript-tool-result")).toContainText(
    "Tool result for get_weather · Supplied by hand.",
  );

  const trace = await savedTrace(page);
  // A human-supplied result is not an execution, so no execution evidence was
  // fabricated for it and the resolution stops claiming the mock produced it.
  expect(trace.toolExecutions).toEqual([]);
  expect(
    trace.events.filter(({ type }) => type.startsWith("tool.execution")),
  ).toEqual([]);
  expect(trace.toolResults[0]!.resolution).toEqual({ kind: "manual" });
});

test("provenance carries no placeholder values", async ({ page }) => {
  await openFixtureProject(page);
  await page.getByRole("button", { name: /^Run request/ }).first().click();
  await expect(page.locator(".tool-call-card")).toBeVisible();
  await page.getByRole("button", { name: "Supply results and continue" }).click();
  await expect(page.locator(".transcript-list")).toContainText("Chicago report");

  // The three strings a formatting or divide-by-zero bug looks like once it
  // reaches a user. The duration is assembled from optional fields, so this is
  // the surface where an absent one would show.
  const text = await page.locator(".transcript-list").innerText();
  expect(text.match(/NaN|Infinity|undefined|\[object/g)).toBeNull();
});
