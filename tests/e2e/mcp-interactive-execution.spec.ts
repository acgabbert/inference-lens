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

test.describe.configure({ mode: "serial" });

async function openMcpProject(page: Page, request: APIRequestContext, model = "mcp-tool-model"): Promise<void> {
  const discovery = await request.post("/api/mcp/discovery", { data: { serverId: "execution-fixture" } });
  expect(discovery.ok()).toBe(true);
  const body = await discovery.json() as { tools: McpDiscoveredTool[] };
  const discovered = body.tools.find(({ remoteName }) => remoteName === "lookup_record");
  expect(discovered?.fingerprint).toBeTruthy();
  const project = createProjectFile({
    name: "MCP execution fixture", idSuffix: "mcp-execution", createdAt: "2026-09-24T12:00:00.000Z",
    request: { provider: "openai-compatible", endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model, messages: [{ role: "user", content: "Look up sample-42." }] },
  });
  const tool = snapshotMcpTool(discovered!, "lookup_record", createEntityId("tool", "mcp-execution-record"));
  const fixture = { ...project, tools: [tool], defaults: { ...project.defaults, enabledToolIds: [tool.id] } };
  await seedProfile(page, { model, favoriteModels: [model],
    capabilityOverrides: { tools: true }, instanceId: "profile-instance-mcp" });
  await page.addInitScript(({ mapKey, projectId }) => {
    localStorage.setItem(mapKey, JSON.stringify({ [projectId]: { profileId: "buffered", profileInstanceId: "profile-instance-mcp" } }));
  }, { mapKey: PROJECT_PROFILE_MAP_STORAGE_KEY, projectId: fixture.projectId });
  await stubProjectDirectory(page, { name: "mcp-execution-fixture", files: { "project.json": serializeProjectFile(fixture) }, directories: ["traces"] });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project folder…" }).click();
  await expect(page.locator(".brand")).toContainText("MCP execution fixture");
  await page.evaluate(() => document.querySelectorAll<HTMLDetailsElement>("details.project-menu").forEach((menu) => { menu.open = false; }));
}

async function allowMcp(page: Page, mode: "ask" | "automatic") {
  await page.getByRole("tab", { name: "Tools" }).click();
  const editor = page.getByRole("group", { name: "MCP execution for lookup_record" });
  await editor.getByRole("combobox", { name: "Local MCP server" }).selectOption("execution-fixture");
  await editor.getByRole("combobox", { name: "Execution mode for lookup_record" }).selectOption(mode);
  await expect(editor.getByRole("combobox", { name: "Execution mode for lookup_record" })).toHaveValue(mode);
  await page.getByRole("tab", { name: "Messages" }).click();
}

async function callCount(request: APIRequestContext): Promise<number> {
  const status = await (await request.get("http://127.0.0.1:44019/status")).json() as { calls: number };
  return status.calls;
}

async function savedTrace(page: Page): Promise<{ raw: string; toolExecutions: Array<{ executor: unknown }>; toolResults: Array<{ isError?: boolean }> }> {
  return page.evaluate(async () => {
    const root = await (window as unknown as { showDirectoryPicker(): Promise<{
      getDirectoryHandle(name: string): Promise<{ values(): AsyncIterable<{ getFile(): Promise<File> }> }>;
    }> }).showDirectoryPicker();
    const traces = await root.getDirectoryHandle("traces");
    for await (const entry of traces.values()) {
      const raw = await (await entry.getFile()).text();
      return { ...JSON.parse(raw), raw };
    }
    throw new Error("The MCP run wrote no trace.");
  });
}

test("an attached local MCP tool can receive a session execution consent", async ({ request }) => {
  const discovery = await request.post("/api/mcp/discovery", { data: { serverId: "execution-fixture" } });
  expect(discovery.ok()).toBe(true);
  const body = await discovery.json() as { tools: Array<{ remoteName: string; fingerprint?: string }> };
  const tool = body.tools.find(({ remoteName }) => remoteName === "lookup_record");
  expect(tool?.fingerprint).toBeTruthy();

  const ungranted = await request.post("/api/mcp/execute", {
    data: { toolId: "tool:mcp-fixture-regression", toolCallId: "call-ungranted", arguments: { record_id: "sample-42" } },
  });
  expect(ungranted.status()).toBe(403);
  const stale = await request.post("/api/mcp/grants", {
    data: { toolId: "tool:mcp-fixture-regression", serverId: "execution-fixture", remoteToolName: "lookup_record",
      discoveryFingerprint: "0".repeat(64), mode: "automatic" },
  });
  expect(stale.status()).toBe(409);

  const grant = await request.post("/api/mcp/grants", {
    data: {
      toolId: "tool:mcp-fixture-regression",
      serverId: "execution-fixture",
      remoteToolName: "lookup_record",
      discoveryFingerprint: tool!.fingerprint,
      mode: "ask",
    },
  });
  expect(grant.status()).toBe(201);
  const errorCall = await request.post("/api/mcp/execute", {
    data: { toolId: "tool:mcp-fixture-regression", toolCallId: "call-error", arguments: { record_id: "tool-error" } },
  });
  expect(errorCall.ok()).toBe(true);
  expect(await errorCall.json()).toEqual({
    status: "completed", content: [{ type: "text", text: "Record lookup rejected by fixture." }], isError: true,
  });
  const structuredCall = await request.post("/api/mcp/execute", {
    data: { toolId: "tool:mcp-fixture-regression", toolCallId: "call-structured", arguments: { record_id: "structured" } },
  });
  expect(structuredCall.ok()).toBe(true);
  expect(await structuredCall.json()).toEqual({
    status: "completed", content: [{ type: "text", text: '{"record_id":"structured","value":7}' }], isError: false,
  });
  for (const [recordId, expectedKind] of [["slow", "timeout"], ["protocol-error", "execution_failed"], ["malformed", "execution_failed"]] as const) {
    const response = await request.post("/api/mcp/execute", {
      data: { toolId: "tool:mcp-fixture-regression", toolCallId: `call-${recordId}`, arguments: { record_id: recordId } },
    });
    expect(response.ok()).toBe(true);
    const outcome = await response.json() as { status: string; failure?: { kind: string } };
    expect(outcome.status).toBe("failed");
    expect(outcome.failure?.kind).toBe(expectedKind);
  }
});

test("an MCP call waits for approval, then reaches the server and provider continuation", async ({ page, request }) => {
  await openMcpProject(page, request);
  await allowMcp(page, "ask");
  const before = await callCount(request);
  await page.getByRole("button", { name: /^Run current conversation/ }).first().click();
  const card = page.locator(".tool-call-card").first();
  await expect(card).toContainText("lookup_record");
  await expect(card).toContainText('"record_id":"sample-42"');
  expect(await callCount(request)).toBe(before);
  await expect(page.getByRole("button", { name: "Supply results and continue" })).toBeDisabled();
  await card.getByRole("button", { name: "Approve this call" }).click();
  await page.getByRole("button", { name: "Supply results and continue" }).click();
  await expect(page.locator(".transcript-list")).toContainText("Record sample-42: local MCP result");
  expect(await callCount(request)).toBe(before + 1);
  const trace = await savedTrace(page);
  expect(trace.toolExecutions[0]?.executor).toMatchObject({ kind: "mcp", label: "Synthetic MCP execution fixture" });
  expect(trace.raw).not.toContain("http://127.0.0.1:44019/mcp");
  expect(trace.raw).not.toContain("il_mcp_session");
  expect(trace.raw).not.toContain("grantedAt");
});

test("rejecting an MCP call contacts no server", async ({ page, request }) => {
  await openMcpProject(page, request);
  await allowMcp(page, "ask");
  const before = await callCount(request);
  await page.getByRole("button", { name: /^Run current conversation/ }).first().click();
  const card = page.locator(".tool-call-card").first();
  await card.getByRole("button", { name: "Reject this call" }).click();
  await expect(card).toContainText("Type a manual result to continue");
  expect(await callCount(request)).toBe(before);
  await expect(page.getByRole("button", { name: "Supply results and continue" })).toBeDisabled();
});

test("an explicit automatic permission executes without a second approval", async ({ page, request }) => {
  await openMcpProject(page, request);
  await allowMcp(page, "automatic");
  const before = await callCount(request);
  await page.getByRole("button", { name: /^Run current conversation/ }).first().click();
  await expect(page.locator(".transcript-list")).toContainText("Record sample-42: local MCP result");
  expect(await callCount(request)).toBe(before + 1);
});

test("a kept MCP snapshot answers successive runs and clears on reload", async ({ page, request }) => {
  await seedProfile(page, { model: "mcp-tool-model", favoriteModels: ["mcp-tool-model"], capabilityOverrides: { tools: true } });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByRole("tab", { name: "Tools" }).click();
  const panel = page.getByRole("region", { name: "MCP servers" });
  await panel.getByRole("combobox", { name: "Declared MCP server" }).selectOption("execution-fixture");
  await panel.getByRole("button", { name: "Connect and browse tools" }).click();
  await panel.getByRole("checkbox", { name: "Select lookup_record", exact: true }).check();
  await panel.getByRole("button", { name: "Attach selected (1)" }).click();
  const editor = page.getByRole("group", { name: "MCP execution for lookup_record" });
  await expect(editor.getByRole("combobox", { name: "Execution mode for lookup_record" })).toHaveValue("ask");
  await expect(editor).toContainText("Synthetic MCP execution fixture");
  await page.getByRole("tab", { name: "Messages" }).click();
  await page.getByRole("textbox", { name: "Message 1 content" }).fill("Look up sample-42.");
  await page.getByRole("button", { name: /^Run current conversation/ }).first().click();
  await page.getByRole("button", { name: "Approve this call" }).click();
  await page.getByRole("button", { name: "Supply results and continue" }).click();
  await expect(page.locator(".transcript-list")).toContainText("Record sample-42: local MCP result");
  await page.getByRole("tab", { name: "Tools" }).click();
  await expect(page.getByRole("region", { name: "Tools attached to this request" })).toContainText("lookup_record");
  const beforeSecondRun = await callCount(request);
  await editor.getByRole("combobox", { name: "Execution mode for lookup_record" }).selectOption("automatic");
  await expect(editor.getByRole("combobox", { name: "Execution mode for lookup_record" })).toHaveValue("automatic");
  await page.getByRole("tab", { name: "Messages" }).click();
  await page.getByRole("button", { name: /^Run current conversation/ }).first().click();
  await expect(page.locator(".transcript-list")).toContainText("Record sample-42: local MCP result");
  await expect.poll(() => callCount(request)).toBe(beforeSecondRun + 1);
  await page.reload();
  await waitForHydration(page);
  await page.getByRole("tab", { name: "Tools" }).click();
  await expect(page.getByRole("region", { name: "Tools attached to this request" })).toContainText("No tools attached");
});

test("an attached MCP tool without permission explains the manual result prompt", async ({ page }) => {
  await seedProfile(page, { model: "mcp-tool-model", favoriteModels: ["mcp-tool-model"], capabilityOverrides: { tools: true } });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByRole("tab", { name: "Tools" }).click();
  const panel = page.getByRole("region", { name: "MCP servers" });
  await panel.getByRole("combobox", { name: "Declared MCP server" }).selectOption("execution-fixture");
  await panel.getByRole("button", { name: "Connect and browse tools" }).click();
  await panel.getByRole("combobox", { name: "Execution mode", exact: true }).selectOption("manual");
  await panel.getByRole("checkbox", { name: "Select lookup_record", exact: true }).check();
  await panel.getByRole("button", { name: "Attach selected (1)" }).click();
  await page.getByRole("tab", { name: "Messages" }).click();
  await page.getByRole("textbox", { name: "Message 1 content" }).fill("Look up sample-42.");
  await page.getByRole("button", { name: /^Run current conversation/ }).first().click();
  const card = page.locator(".tool-call-card").first();
  await expect(card).toContainText("MCP execution permission was not set");
  await expect(card).toContainText("Tools attached to this request");
  await expect(card.getByRole("button", { name: "Approve this call" })).toHaveCount(0);
});

test("a tool-reported MCP error reaches the model as a completed result", async ({ page, request }) => {
  await openMcpProject(page, request, "mcp-error-model");
  await allowMcp(page, "ask");
  await page.getByRole("button", { name: /^Run current conversation/ }).first().click();
  await page.getByRole("button", { name: "Approve this call" }).click();
  await page.getByRole("button", { name: "Supply results and continue" }).click();
  await expect(page.locator(".transcript-list")).toContainText("Record lookup rejected by fixture.");
  const trace = await savedTrace(page);
  expect(trace.toolResults[0]?.isError).toBe(true);
});

test("an MCP timeout leaves the call pending for a manual answer", async ({ page, request }) => {
  await openMcpProject(page, request, "mcp-slow-model");
  await allowMcp(page, "ask");
  await page.getByRole("button", { name: /^Run current conversation/ }).first().click();
  await page.getByRole("button", { name: "Approve this call" }).click();
  await page.getByRole("button", { name: "Supply results and continue" }).click();
  const card = page.locator(".tool-call-card").first();
  await expect(card.locator(".tool-call-pending-executor")).toHaveCount(0);
  await card.locator("textarea").fill("Manual result after MCP timeout");
  await page.getByRole("button", { name: "Supply results and continue" }).click();
  await expect(page.locator(".transcript-list")).toContainText("Manual result after MCP timeout");
});
