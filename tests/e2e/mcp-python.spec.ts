import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { seedProfile, waitForHydration } from "./support";

/**
 * The M3 live checks that need the official Python SDK rather than the Node
 * fixture: a run on the `2026-07-28` protocol, and a server process that is
 * really killed mid-call. Run with `--config playwright.python-mcp.config.ts`.
 */
test.skip(!process.env.INFERENCE_LENS_PYTHON_MCP, "Run with --config playwright.python-mcp.config.ts and .venv-mcp.");

const KILL_PORT = 44025;

async function attachFromServer(page: Page, serverId: string, model: string): Promise<void> {
  await seedProfile(page, { model, favoriteModels: [model], capabilityOverrides: { tools: true } });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByRole("tab", { name: "Tools" }).click();
  const panel = page.getByRole("region", { name: "MCP servers" });
  await panel.getByRole("combobox", { name: "Declared MCP server" }).selectOption(serverId);
  await panel.getByRole("button", { name: "Connect and browse tools" }).click();
  await expect(panel).toContainText("Connected to inference-lens-local-example");
  await panel.getByRole("checkbox", { name: "Select lookup_record", exact: true }).check();
  await panel.getByRole("button", { name: "Attach selected (1)" }).click();
  await expect(page.getByRole("group", { name: "MCP execution for lookup_record" })
    .getByRole("combobox", { name: "Execution mode for lookup_record" })).toHaveValue("ask");
}

async function runAndApprove(page: Page, message: string): Promise<void> {
  await page.getByRole("tab", { name: "Messages" }).click();
  await page.getByRole("textbox", { name: "Message 1 content" }).fill(message);
  await page.getByRole("button", { name: /^Run current conversation/ }).first().click();
  await page.locator(".tool-call-card").first().getByRole("button", { name: "Approve this call" }).click();
  await page.getByRole("button", { name: "Supply results and continue" }).click();
}

test("a Python MCP server negotiates 2026-07-28 and answers a run", async ({ page }) => {
  await attachFromServer(page, "python-local", "mcp-tool-model");
  await page.getByRole("tab", { name: "Tools" }).click();
  await expect(page.getByRole("region", { name: "MCP servers" })).toContainText("MCP 2026-07-28");
  await runAndApprove(page, "Look up sample-42.");
  await expect(page.locator(".transcript-list")).toContainText("Chicago report: Record sample-42: local MCP result");
});

let server: ChildProcess | undefined;

test.afterEach(() => {
  if (server?.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
  server = undefined;
});

/** Starts a Python server this test owns, resolving once it accepts MCP requests. */
async function startKillableServer(): Promise<{ output: () => string }> {
  let output = "";
  server = spawn(".venv-mcp/bin/python", ["scripts/local-mcp-server.py"], {
    env: { ...process.env, INFERENCE_LENS_LOCAL_MCP_PORT: String(KILL_PORT), PYTHONUNBUFFERED: "1" },
  });
  server.stdout?.on("data", (chunk) => { output += chunk; });
  server.stderr?.on("data", (chunk) => { output += chunk; });
  await expect.poll(() => output, { timeout: 15_000 }).toContain(`127.0.0.1:${KILL_PORT}`);
  return { output: () => output };
}

test("killing the Python MCP server mid-call fails promptly and a manual result continues", async ({ page }) => {
  const python = await startKillableServer();
  await attachFromServer(page, "python-kill", "mcp-slow-model");
  await runAndApprove(page, "Look up slow.");
  await expect.poll(python.output, { timeout: 10_000 }).toContain("Waiting 60 seconds");

  const killed = Date.now();
  server!.kill("SIGKILL");
  await expect(page.getByRole("alert")).toContainText("lookup_record could not be executed:");
  await expect(page.getByRole("alert")).toContainText("Supply a result by hand to continue.");
  // The catalog allows 120 s per call: this is the loss, not the timeout.
  expect(Date.now() - killed).toBeLessThan(10_000);
  const card = page.locator(".tool-call-card").first();
  await expect(card).toContainText("Execution failed");

  await card.locator("textarea").fill("Manual result after the Python server was killed");
  await page.getByRole("button", { name: "Supply results and continue" }).click();
  await expect(page.locator(".transcript-list"))
    .toContainText("Chicago report: Manual result after the Python server was killed");
});
