import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { createProjectFile, serializeProjectFile } from "../../packages/core/src/project";
import { createEntityId } from "../../packages/core/src/run-kernel";
import { snapshotMcpTool } from "../../app/tools/mcp-tool-snapshot";
import type { McpDiscoveredTool } from "../../packages/contracts/src/mcp-discovery";
import {
  BUFFERED_FIXTURE_ENDPOINT, PROJECT_PROFILE_MAP_STORAGE_KEY,
  seedProfile, stubProjectDirectory, waitForHydration,
} from "./support";

/**
 * The M3 live checks that were first accepted by hand against the Python
 * tryout server: stopping a run during a call, losing the server during a
 * call, and reading a saved trace once the server is gone.
 *
 * They need a call that is genuinely in flight, so this fixture's catalog
 * entry allows 30 seconds per call and its `hold` record waits for the spec to
 * interrupt it. Against the 200 ms entries the other MCP specs use, a stop or
 * an outage would land on a call that had already timed out.
 */
const SERVER_ID = "interruption-fixture";
const SERVER_LABEL = "Synthetic MCP interruption fixture";
const FIXTURE = "http://127.0.0.1:44023";

test.describe.configure({ mode: "serial" });

type FixtureStatus = { calls: number; held: number; down: boolean; mcpRequests: number };

async function fixtureStatus(request: APIRequestContext): Promise<FixtureStatus> {
  return (await request.get(`${FIXTURE}/status`)).json() as Promise<FixtureStatus>;
}

test.afterEach(async ({ request }) => {
  await request.post(`${FIXTURE}/release`);
  await request.post(`${FIXTURE}/restore`);
});

async function openMcpProject(page: Page, request: APIRequestContext, model: string): Promise<void> {
  const discovery = await request.post("/api/mcp/discovery", { data: { serverId: SERVER_ID } });
  expect(discovery.ok()).toBe(true);
  const body = await discovery.json() as { tools: McpDiscoveredTool[] };
  const discovered = body.tools.find(({ remoteName }) => remoteName === "lookup_record");
  expect(discovered?.fingerprint).toBeTruthy();
  const project = createProjectFile({
    name: "MCP interruption fixture", idSuffix: "mcp-interruption", createdAt: "2026-09-26T12:00:00.000Z",
    request: { provider: "openai-compatible", endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model, messages: [{ role: "user", content: "Look up a record." }] },
  });
  const tool = snapshotMcpTool(discovered!, "lookup_record", createEntityId("tool", "mcp-interruption-record"));
  const fixture = { ...project, tools: [tool], defaults: { ...project.defaults, enabledToolIds: [tool.id] } };
  await seedProfile(page, { model, favoriteModels: [model],
    capabilityOverrides: { tools: true }, instanceId: "profile-instance-mcp-interruption" });
  await page.addInitScript(({ mapKey, projectId }) => {
    localStorage.setItem(mapKey, JSON.stringify({ [projectId]: { profileId: "buffered", profileInstanceId: "profile-instance-mcp-interruption" } }));
  }, { mapKey: PROJECT_PROFILE_MAP_STORAGE_KEY, projectId: fixture.projectId });
  await stubProjectDirectory(page, { name: "mcp-interruption-fixture", files: { "project.json": serializeProjectFile(fixture) }, directories: ["traces"] });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project folder…" }).click();
  await expect(page.locator(".brand")).toContainText("MCP interruption fixture");
  await page.evaluate(() => document.querySelectorAll<HTMLDetailsElement>("details.project-menu").forEach((menu) => { menu.open = false; }));
}

async function allowMcp(page: Page, mode: "ask" | "automatic"): Promise<void> {
  await page.getByRole("tab", { name: "Tools" }).click();
  const editor = page.getByRole("group", { name: "MCP execution for lookup_record" });
  await editor.getByRole("combobox", { name: "Local MCP server" }).selectOption(SERVER_ID);
  await editor.getByRole("combobox", { name: "Execution mode for lookup_record" }).selectOption(mode);
  await expect(editor.getByRole("combobox", { name: "Execution mode for lookup_record" })).toHaveValue(mode);
  await page.getByRole("tab", { name: "Messages" }).click();
}

/** Runs, approves the held call, and returns once the fixture is holding it. */
async function startHeldCall(page: Page, request: APIRequestContext): Promise<void> {
  const before = await fixtureStatus(request);
  await page.getByRole("button", { name: /^Run current conversation/ }).first().click();
  const card = page.locator(".tool-call-card").first();
  await expect(card).toContainText('"record_id":"hold"');
  await card.getByRole("button", { name: "Approve this call" }).click();
  await page.getByRole("button", { name: "Supply results and continue" }).click();
  await expect.poll(async () => (await fixtureStatus(request)).held).toBe(before.held + 1);
}

async function savedTrace(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const root = await (window as unknown as { showDirectoryPicker(): Promise<{
      getDirectoryHandle(name: string): Promise<{ values(): AsyncIterable<{ getFile(): Promise<File> }> }>;
    }> }).showDirectoryPicker();
    const traces = await root.getDirectoryHandle("traces");
    for await (const entry of traces.values()) return (await entry.getFile()).text();
    throw new Error("The MCP run wrote no trace.");
  });
}

test("stopping a run while its MCP call is in flight cancels it and a new run can start", async ({ page, request }) => {
  await openMcpProject(page, request, "mcp-hold-model");
  await allowMcp(page, "ask");
  await startHeldCall(page, request);

  await page.locator(".header-actions").getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByLabel("Run summary")).toContainText("Cancelled");
  const transcript = page.locator(".transcript-list");
  await expect(transcript).toContainText('lookup_record({"record_id":"hold"})');
  await expect(transcript).not.toContainText("Record hold");
  await expect(transcript).not.toContainText("Chicago report");

  // A late answer from the server has nowhere to go once the run is stopped.
  await request.post(`${FIXTURE}/release`);
  await expect.poll(async () => (await fixtureStatus(request)).held).toBe(0);
  await expect(transcript).not.toContainText("Record hold");

  await startHeldCall(page, request);
  await request.post(`${FIXTURE}/release`);
  await expect(transcript).toContainText("Chicago report: Record hold: released");
});

test("losing the MCP server mid-call fails promptly and a manual result continues the run", async ({ page, request }) => {
  await openMcpProject(page, request, "mcp-hold-model");
  await allowMcp(page, "ask");
  await startHeldCall(page, request);

  const dropped = Date.now();
  await request.post(`${FIXTURE}/drop`);
  const card = page.locator(".tool-call-card").first();
  await expect(page.getByRole("alert")).toContainText(
    "lookup_record could not be executed: The MCP server could not complete the call. Supply a result by hand to continue.");
  // Well inside the catalog's 30 s call timeout: the loss itself was reported.
  expect(Date.now() - dropped).toBeLessThan(10_000);
  await expect(card).toContainText("Execution failed");
  await expect(card.locator("textarea")).toHaveValue("");

  await card.locator("textarea").fill("Manual result after the MCP server was lost");
  await page.getByRole("button", { name: "Supply results and continue" }).click();
  await expect(page.locator(".transcript-list"))
    .toContainText("Chicago report: Manual result after the MCP server was lost");
  const trace = JSON.parse(await savedTrace(page)) as { toolExecutions: Array<{ status: string; failure?: { kind: string } }> };
  // Reported as a failed execution, not reached through the call timeout.
  expect(trace.toolExecutions).toEqual([
    expect.objectContaining({ status: "failed", failure: expect.objectContaining({ kind: "execution_failed" }) }),
  ]);
});

test("a saved MCP trace imports and renders with its server gone", async ({ page, browser, request }) => {
  await openMcpProject(page, request, "mcp-tool-model");
  await allowMcp(page, "automatic");
  await page.getByRole("button", { name: /^Run current conversation/ }).first().click();
  await expect(page.locator(".transcript-list")).toContainText("Chicago report: Record sample-42: local MCP result");
  const trace = await savedTrace(page);

  await request.post(`${FIXTURE}/drop`);
  const before = await fixtureStatus(request);
  expect(before.down).toBe(true);

  // A fresh browser: nothing from the run survives except the trace file.
  const context = await browser.newContext();
  const reader = await context.newPage();
  await seedProfile(reader);
  await reader.goto("/");
  await waitForHydration(reader);
  await reader.locator(".run-data-menu > summary").click();
  await reader.getByLabel("Import run trace…").setInputFiles({
    name: "run_mcp-server-gone.json", mimeType: "application/json", buffer: Buffer.from(trace),
  });
  await expect(reader.getByRole("status").filter({ hasText: "Imported run trace" })).toContainText("run_mcp-server-gone.json");
  await expect(reader.getByLabel("Run summary")).toContainText("Completed");
  const transcript = reader.locator(".transcript-list");
  await expect(transcript).toContainText(`Returned by MCP server “${SERVER_LABEL}”`);
  await expect(transcript).toContainText("Chicago report: Record sample-42: local MCP result");
  await expect(reader.locator(".inspect-view")).not.toContainText(/NaN|Infinity|undefined/);
  expect((await fixtureStatus(request)).mcpRequests).toBe(before.mcpRequests);
  await context.close();
});
