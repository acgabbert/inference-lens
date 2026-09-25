import { expect, test } from "@playwright/test";

import { seedProfile, waitForHydration } from "./support";

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
  await expect(panel).toContainText("A tool on the second page.");
  await expect(panel).toContainText("<img src=x onerror=window.__mcpInjected=1>");
  await expect(panel.locator("img")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __mcpInjected?: number }).__mcpInjected)).toBeUndefined();
  const after = await (await request.get("http://127.0.0.1:44018/status")).json() as { discoveryRequests: number; calls: number };
  expect(after.discoveryRequests).toBeGreaterThanOrEqual(before.discoveryRequests + 2);
  expect(executionRequests).toEqual([]);

  const firstTool = panel.getByRole("article").filter({ hasText: "Look up a record" });
  await expect(firstTool).toContainText("Find a synthetic record.");
  await firstTool.getByRole("button", { name: "Attach to project" }).click();
  await expect(page.getByRole("region", { name: "Tools attached to this request" })).toContainText("lookup_record");
  const secondTool = panel.getByRole("article").filter({ hasText: "A tool on the second page." });
  await secondTool.getByRole("textbox", { name: "Model-visible name for second_tool" }).fill("second_alias");
  await secondTool.getByRole("button", { name: "Attach to next request" }).click();
  await expect(panel.getByRole("status")).toContainText("Allow execution in Tools attached to this request");
  await expect(page.getByRole("region", { name: "Tools attached to this request" })).toContainText("second_alias");

  await request.post("http://127.0.0.1:44018/change");
  await panel.getByRole("button", { name: "Refresh tools" }).click();
  await expect(firstTool).toContainText("Changed since last refresh: description");
  await expect(firstTool).toContainText("Find an updated synthetic record.");
  await expect(page.locator(".tool-list > .tool-editor").first()).toContainText("Find a synthetic record.");
});
