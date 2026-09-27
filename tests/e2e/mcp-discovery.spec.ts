import { expect, test } from "@playwright/test";

import { createProjectFile } from "../../packages/core/src/project";
import { seedProfile, waitForHydration, importProject } from "./support";

// This fixture has shared discovery counters and a mutable descriptor.
test.describe.configure({ mode: "serial" });

test("a declared MCP server is connected deliberately and its tools attach as detached snapshots", async ({ page, request }) => {
  await seedProfile(page, { capabilityOverrides: { tools: true } });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByRole("tab", { name: "Tools" }).click();
  const executionRequests: string[] = [];
  page.on("request", (outgoing) => {
    if (new URL(outgoing.url()).pathname === "/api/mcp/execute") executionRequests.push(outgoing.url());
  });

  const panel = page.getByRole("region", { name: "MCP servers" });
  await expect(panel).toContainText("Synthetic MCP fixture");
  const before = await (await request.get("http://127.0.0.1:44018/status")).json() as { discoveryRequests: number; calls: number };
  const undeclared = await request.post("http://127.0.0.1:4300/api/mcp/discovery", {
    data: { serverId: "http://127.0.0.1:44018/mcp" },
  });
  expect(undeclared.status()).toBe(404);
  expect((await (await request.get("http://127.0.0.1:44018/status")).json() as { discoveryRequests: number }).discoveryRequests).toBe(before.discoveryRequests);

  await panel.getByRole("button", { name: "Connect and browse tools" }).click();
  await expect(panel).toContainText("inference-lens-discovery-fixture");
  const headingLeft = (await panel.getByRole("heading", { name: "MCP servers" }).boundingBox())!.x;
  const leadLeft = (await panel.getByText("Connect to an operator-declared server", { exact: false }).boundingBox())!.x;
  expect(leadLeft).toBeGreaterThanOrEqual(headingLeft - 2);
  await expect(panel).toContainText("2 tools");
  await panel.locator("summary").filter({ hasText: "Tool details" }).evaluateAll((summaries) => summaries.forEach((summary) => { (summary.parentElement as HTMLDetailsElement).open = true; }));
  await expect(panel).toContainText("A tool on the second page.");
  await expect(panel).toContainText("<img src=x onerror=window.__mcpInjected=1>");
  await expect(panel.locator("img")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __mcpInjected?: number }).__mcpInjected)).toBeUndefined();
  const after = await (await request.get("http://127.0.0.1:44018/status")).json() as { discoveryRequests: number; calls: number };
  expect(after.discoveryRequests).toBeGreaterThanOrEqual(before.discoveryRequests + 2);
  expect(executionRequests).toEqual([]);

  const firstTool = panel.getByRole("article").filter({ hasText: "Look up a record" });
  await expect(firstTool).toContainText("Find a synthetic record.");
  await panel.getByRole("combobox", { name: "Attachment", exact: true }).selectOption("project");
  await panel.getByRole("combobox", { name: "Execution mode", exact: true }).selectOption("manual");
  await firstTool.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "Attach selected (1)" }).click();
  await expect(page.getByRole("region", { name: "Tools attached to this request" })).toContainText("lookup_record");
  const secondTool = panel.getByRole("article").filter({ hasText: "A tool on the second page." });
  await secondTool.getByRole("textbox", { name: "Model-visible name for second_tool" }).fill("second_alias");
  await panel.getByRole("combobox", { name: "Attachment", exact: true }).selectOption("request");
  await secondTool.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "Attach selected (1)" }).click();
  await expect(panel.getByRole("status")).toContainText("in this tab");
  await expect(page.getByRole("region", { name: "Tools attached to this request" })).toContainText("second_alias");

  await request.post("http://127.0.0.1:44018/change");
  await panel.getByRole("button", { name: "Refresh tools" }).click();
  await expect(firstTool).toContainText("Changed since last refresh: description");
  await expect(firstTool).toContainText("Find an updated synthetic record.");
  await page.getByText("lookup_record · Edit definition", { exact: true }).click();
  await expect(page.locator(".tool-list > .tool-editor").first()).toContainText("Find a synthetic record.");
});

test("multi-selection attaches with explicit automatic execution and can save a kept tool to the project", async ({ page }, testInfo) => {
  await seedProfile(page, { capabilityOverrides: { tools: true } });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByRole("tab", { name: "Tools" }).click();
  await expect(page.getByText("No project tools yet", { exact: true })).toHaveCount(0);
  const panel = page.getByRole("region", { name: "MCP servers" });
  await panel.getByRole("button", { name: "Connect and browse tools" }).click();
  await panel.getByRole("combobox", { name: "Execution mode", exact: true }).selectOption("automatic");
  await panel.getByRole("checkbox", { name: "Select lookup_record", exact: true }).check();
  await panel.getByRole("checkbox", { name: "Select second_tool", exact: true }).check();
  await panel.getByRole("button", { name: "Attach selected (2)" }).click();
  const manifest = page.getByRole("region", { name: "Tools attached to this request" });
  await expect(manifest.getByRole("listitem")).toHaveCount(2);
  await expect(manifest.getByRole("combobox", { name: "Execution mode for lookup_record" })).toHaveValue("automatic");
  await expect(manifest.getByRole("combobox", { name: "Execution mode for second_tool" })).toHaveValue("automatic");
  await expect(panel.getByRole("checkbox", { name: "Select lookup_record", exact: true })).toBeDisabled();
  await manifest.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("attached-tools.png"), fullPage: true });
  const row = manifest.getByRole("listitem").filter({ hasText: "lookup_record" });
  await row.getByRole("button", { name: "Save to project" }).click();
  await expect(row.locator(".tool-origin")).toHaveText("Project");
  await expect(row.getByRole("combobox")).toHaveValue("automatic");
  await row.getByRole("combobox").selectOption("manual");
  await expect(row.getByRole("combobox", { name: "Execution mode for lookup_record" })).toHaveValue("manual");
});

test("a refused permission leaves a visible manual attachment and explains the failure", async ({ page }) => {
  await seedProfile(page, { capabilityOverrides: { tools: true } });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByRole("tab", { name: "Tools" }).click();
  const panel = page.getByRole("region", { name: "MCP servers" });
  await panel.getByRole("button", { name: "Connect and browse tools" }).click();
  await page.route("**/api/tool-bindings/check", async (route) => {
    const { bindings } = route.request().postDataJSON() as { bindings: Array<{ toolId: string }> };
    await route.fulfill({ json: { results: bindings.map(({ toolId }) => ({
      toolId, status: "unavailable", reason: "fingerprint_changed", message: "The MCP tool changed since it was attached.",
    })) } });
  });
  await panel.getByRole("checkbox", { name: "Select lookup_record", exact: true }).check();
  await panel.getByRole("button", { name: "Attach selected (1)" }).click();
  await expect(panel.getByRole("alert")).toContainText("execution permission could not be set");
  await panel.getByRole("checkbox", { name: "Select lookup_record", exact: true }).uncheck();
  await expect(panel.getByRole("button", { name: "Attach selected (0)" })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "Execution mode for lookup_record" })).toHaveValue("manual");
});


test("kept tools survive same-project replacement and clear for a different project", async ({ page }) => {
  await seedProfile(page, { capabilityOverrides: { tools: true } });
  await page.goto("/");
  await waitForHydration(page);
  const request = { provider: "openai-compatible" as const, endpoint: "http://127.0.0.1:44014/v1/chat/completions", model: "buffered-test-model", messages: [{ role: "user" as const, content: "Hello" }] };
  const project = createProjectFile({ name: "Tool lifetime A", idSuffix: "tool-lifetime-a", request });
  await importProject(page, project, "Tool lifetime A");
  await page.getByRole("tab", { name: "Tools" }).click();
  const panel = page.getByRole("region", { name: "MCP servers" });
  await panel.getByRole("button", { name: "Connect and browse tools" }).click();
  await panel.getByRole("combobox", { name: "Execution mode", exact: true }).selectOption("manual");
  await panel.getByRole("checkbox", { name: "Select lookup_record", exact: true }).check();
  await panel.getByRole("button", { name: "Attach selected (1)" }).click();
  const manifest = page.getByRole("region", { name: "Tools attached to this request" });
  await expect(manifest).toContainText("lookup_record");
  await importProject(page, project, "Tool lifetime A");
  await page.getByRole("tab", { name: "Tools" }).click();
  await expect(manifest).toContainText("lookup_record");
  await importProject(page, createProjectFile({ name: "Tool lifetime B", idSuffix: "tool-lifetime-b", request }), "Tool lifetime B");
  await page.getByRole("tab", { name: "Tools" }).click();
  await expect(manifest).toContainText("No tools attached");
});
