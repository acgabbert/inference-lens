import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

import { createProjectFile, parseProjectFile, serializeProjectFile } from "../../packages/core/src/project";
import type { ProjectFile } from "../../packages/core/src/project";
import { createEntityId } from "../../packages/core/src/run-kernel";
import type { ToolDefinition } from "../../packages/core/src/run-kernel";
import { snapshotMcpTool } from "../../app/tools/mcp-tool-snapshot";
import { LOCAL_TOOL_GRANTS_STORAGE_KEY } from "../../app/tools/local-tool-grants.client";
import type { McpDiscoveredTool } from "../../packages/contracts/src/mcp-discovery";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  PROJECT_PROFILE_MAP_STORAGE_KEY,
  openMode,
  primaryAction,
  seedProfile,
  stubProjectDirectory,
  waitForHydration,
} from "./support";

/**
 * MCP tools served by repeated runs and evaluations.
 *
 * A dedicated fixture server (port 44020) keeps outage and schema-change
 * scenarios away from the interactive specs. The fixture model echoes the
 * tool message into its final answer as `Chicago report: <text>`, so seeing
 * the MCP result in a repetition proves the batch called the server and
 * continued the run — not merely that a run finished.
 */
const FIXTURE = "http://127.0.0.1:44020";
const SERVER_ID = "batch-fixture";
const SERVER_LABEL = "Synthetic MCP batch fixture";
const MCP_RESULT = "Record sample-42: local MCP result";
const PROFILE_INSTANCE_ID = "profile-instance-mcp-batch";

test.describe.configure({ mode: "serial" });

test.afterEach(async ({ request }) => {
  await request.post(`${FIXTURE}/restore`);
});

async function fixtureStatus(request: APIRequestContext): Promise<{ calls: number; down: boolean }> {
  return (await request.get(`${FIXTURE}/status`)).json();
}

async function lookupSnapshot(request: APIRequestContext, idSuffix: string): Promise<ToolDefinition> {
  const discovery = await request.post("/api/mcp/discovery", { data: { serverId: SERVER_ID } });
  expect(discovery.ok()).toBe(true);
  const { tools } = await discovery.json() as { tools: McpDiscoveredTool[] };
  const discovered = tools.find(({ remoteName }) => remoteName === "lookup_record");
  expect(discovered?.fingerprint).toBeTruthy();
  return snapshotMcpTool(discovered!, "lookup_record", createEntityId("tool", `${idSuffix}-lookup`));
}

function fixtureProject(model: string, idSuffix: string, tool: ToolDefinition): ProjectFile {
  const initial = createProjectFile({
    name: "MCP batch fixture",
    idSuffix,
    createdAt: "2026-09-26T12:00:00.000Z",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model,
      messages: [{ role: "user", content: "Look up sample-42." }],
    },
  });
  return parseProjectFile({
    ...initial,
    tools: [tool],
    defaults: { ...initial.defaults, enabledToolIds: [tool.id] },
    evaluationSuites: [{
      id: "evaluation-suite_mcp-lookup",
      name: "MCP lookup",
      input: { kind: "conversation-revision", conversationRevisionId: initial.defaults.conversationRevisionId },
      execution: {
        target: { ...initial.defaults.target, model },
        responseMode: "buffered",
        options: {},
        repetitions: 1,
        toolIds: [tool.id],
      },
      inputBindings: [],
      variants: [{ id: "evaluation-variant_default", name: "Default", overrides: {} }],
      cases: [{
        id: "evaluation-case_sample",
        name: "Sample 42",
        values: {},
        checks: [
          { checkId: "check_reports-record", kind: "contains", value: MCP_RESULT, caseSensitive: true },
          { checkId: "check_called-lookup", kind: "tool-call-arguments", toolName: "lookup_record", argumentsSubset: { record_id: "sample-42" } },
        ],
      }],
    }],
  });
}

/**
 * Opens the fixture with an MCP grant already on this device. The grant is
 * `ask` on purpose: a batch's confirmation approves its calls whatever the
 * interactive mode says.
 */
async function openProject(page: Page, project: ProjectFile, tool: ToolDefinition, model: string): Promise<void> {
  await seedProfile(page, { model, favoriteModels: [model], capabilityOverrides: { tools: true }, instanceId: PROFILE_INSTANCE_ID });
  await page.addInitScript(({ mapKey, projectId, instanceId, grantsKey, grant }) => {
    localStorage.setItem(mapKey, JSON.stringify({ [projectId]: { profileId: "buffered", profileInstanceId: instanceId } }));
    localStorage.setItem(grantsKey, JSON.stringify([grant]));
  }, {
    mapKey: PROJECT_PROFILE_MAP_STORAGE_KEY,
    projectId: project.projectId,
    instanceId: PROFILE_INSTANCE_ID,
    grantsKey: LOCAL_TOOL_GRANTS_STORAGE_KEY,
    grant: {
      kind: "mcp", toolId: tool.id, serverId: SERVER_ID,
      remoteToolName: tool.source!.remoteToolName, discoveryFingerprint: tool.source!.discoveryFingerprint,
      mode: "ask", grantedAt: "2026-09-26T12:00:00.000Z",
    },
  });
  await stubProjectDirectory(page, {
    name: "mcp-batch-fixture",
    files: { "project.json": serializeProjectFile(project) },
    directories: ["traces", "experiments"],
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project folder…" }).click();
  await expect(page.locator(".brand")).toContainText("MCP batch fixture");
  await page.evaluate(() => document.querySelectorAll<HTMLDetailsElement>("details.project-menu").forEach((menu) => { menu.open = false; }));
}

/** Every file the app wrote under one project subdirectory, by name. */
async function savedFiles(page: Page, directory: string): Promise<Record<string, string>> {
  return page.evaluate(async (name) => {
    const root = await (window as unknown as { showDirectoryPicker(): Promise<{
      getDirectoryHandle(name: string): Promise<{ values(): AsyncIterable<{ name: string; getFile(): Promise<File> }> }>;
    }> }).showDirectoryPicker();
    const handle = await root.getDirectoryHandle(name);
    const files: Record<string, string> = {};
    for await (const entry of handle.values()) files[entry.name] = await (await entry.getFile()).text();
    return files;
  }, directory);
}

async function startRepeat(page: Page, repetitions: number) {
  await page.getByRole("button", { name: "Repeat…" }).click();
  const dialog = page.getByRole("dialog", { name: "Run this frozen request repeatedly" });
  await dialog.getByLabel("Repetitions").fill(String(repetitions));
  return dialog;
}

test("a repeated run serves an MCP tool without per-call approval after confirmation", async ({ page, request }) => {
  const tool = await lookupSnapshot(request, "mcp-batch-repeat");
  await openProject(page, fixtureProject("mcp-tool-model", "mcp-batch-repeat", tool), tool, "mcp-tool-model");
  const before = await fixtureStatus(request);

  const dialog = await startRepeat(page, 2);
  await expect(dialog).toContainText(`lookup_record → MCP "lookup_record" on ${SERVER_LABEL}`);
  await expect(dialog).toContainText("Starting approves every MCP call this batch makes");
  await dialog.getByRole("button", { name: "Start 2 repetitions" }).click();

  const workspace = page.getByRole("region", { name: "Repeated experiment results" });
  await expect(page.getByRole("progressbar", { name: "Experiment progress" })).toHaveCount(0, { timeout: 20_000 });
  await expect(workspace).toContainText("2 completed");
  const rows = workspace.locator(".repeated-experiment-row");
  await expect(rows).toHaveCount(2);
  for (const row of await rows.all()) await expect(row).toContainText(`Chicago report: ${MCP_RESULT}`);
  expect((await fixtureStatus(request)).calls).toBe(before.calls + 2);

  const artifacts = Object.values(await savedFiles(page, "experiments")).join("\n");
  const traces = Object.values(await savedFiles(page, "traces")).join("\n");
  expect(artifacts).toContain('"schemaVersion": 5');
  for (const evidence of [artifacts, traces]) {
    for (const forbidden of [SERVER_ID, "44020", "grantedAt"]) expect(evidence).not.toContain(forbidden);
  }

  // Reopening saved results reads evidence only; it never contacts the server.
  const settled = await fixtureStatus(request);
  await page.reload();
  await waitForHydration(page);
  expect((await fixtureStatus(request)).calls).toBe(settled.calls);
});

test("an evaluation runs through MCP and its tool-call check sees the arguments", async ({ page, request }) => {
  const tool = await lookupSnapshot(request, "mcp-batch-evaluation");
  await openProject(page, fixtureProject("mcp-tool-model", "mcp-batch-evaluation", tool), tool, "mcp-tool-model");
  await openMode(page, "Evaluations");
  const editor = page.locator(".evaluation-editor");
  await expect(editor.locator(".evaluation-tools")).toContainText(`MCP "lookup_record" on ${SERVER_LABEL}`);
  await expect(editor).toContainText("Ready to run");

  await primaryAction(page, "evaluations").click();
  const confirmation = page.getByRole("dialog", { name: /Start “MCP lookup”/ });
  await expect(confirmation).toContainText("Starting approves every MCP call this batch makes");
  await confirmation.getByRole("button", { name: "Start 1 repetition" }).click();

  const results = page.locator(".evaluation-results-workspace");
  await expect(results).toContainText("1 / 1 passed", { timeout: 20_000 });
});

test("a changed MCP tool blocks the batch before any plan or provider request", async ({ page, request }) => {
  const tool = await lookupSnapshot(request, "mcp-batch-stale");
  await openProject(page, fixtureProject("mcp-tool-model", "mcp-batch-stale", tool), tool, "mcp-tool-model");
  await request.post(`${FIXTURE}/change`);
  const before = await fixtureStatus(request);

  const dialog = await startRepeat(page, 2);
  await dialog.getByRole("button", { name: "Start 2 repetitions" }).click();

  const workspace = page.getByRole("region", { name: "Repeated experiment results" });
  await expect(workspace).toContainText("Nothing was sent. lookup_record cannot run: The MCP tool changed since it was attached.");
  expect((await fixtureStatus(request)).calls).toBe(before.calls);
  expect(await savedFiles(page, "experiments")).toEqual({});
  expect(await savedFiles(page, "traces")).toEqual({});
});

test("a server that stops mid-batch stops the batch after the affected run", async ({ page, request }) => {
  const tool = await lookupSnapshot(request, "mcp-batch-outage");
  await openProject(page, fixtureProject("mcp-outage-model", "mcp-batch-outage", tool), tool, "mcp-outage-model");

  const dialog = await startRepeat(page, 3);
  await dialog.getByRole("button", { name: "Start 3 repetitions" }).click();

  const workspace = page.getByRole("region", { name: "Repeated experiment results" });
  await expect(page.getByRole("progressbar", { name: "Experiment progress" })).toHaveCount(0, { timeout: 20_000 });
  await expect(workspace.locator(".repeated-experiment-header .run-history-status")).toHaveText("stopped");
  await expect(workspace).toContainText("lookup_record became unavailable in run 2 of 3, so 1 remaining run was not sent.");
  expect((await fixtureStatus(request)).down).toBe(true);

  const files = await savedFiles(page, "experiments");
  const result = JSON.parse(Object.entries(files).find(([name]) => name.endsWith(".result.json"))![1]) as {
    status: string; stop?: { reason: string; toolId: string }; cells: Array<{ status: string }>;
  };
  expect(result.status).toBe("stopped");
  expect(result.stop).toMatchObject({ reason: "tool_unavailable", toolId: tool.id });
  expect(result.cells.map(({ status }) => status)).toEqual(["completed", "failed", "not-run"]);
});

test("a timed-out MCP call fails its repetition and the batch continues", async ({ page, request }) => {
  const tool = await lookupSnapshot(request, "mcp-batch-timeout");
  await openProject(page, fixtureProject("mcp-slow-model", "mcp-batch-timeout", tool), tool, "mcp-slow-model");

  const dialog = await startRepeat(page, 2);
  await dialog.getByRole("button", { name: "Start 2 repetitions" }).click();

  const workspace = page.getByRole("region", { name: "Repeated experiment results" });
  await expect(page.getByRole("progressbar", { name: "Experiment progress" })).toHaveCount(0, { timeout: 20_000 });
  await expect(workspace.locator(".repeated-experiment-header .run-history-status")).toHaveText("completed");
  await expect(workspace).toContainText("2 failed");
});
