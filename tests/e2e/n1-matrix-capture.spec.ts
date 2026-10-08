import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createProjectFile } from "../../packages/core/src/project";
import scenarios from "../fixtures/mcp-servers/n1-matrix.json" with { type: "json" };
import { importProject, seedProfile, waitForHydration, PROJECT_PROFILE_MAP_STORAGE_KEY } from "./support";

test.describe.configure({ mode: "serial" });

for (const scenario of scenarios) {
  test(`N1 captures ${scenario.id} through Python MCP and provider continuation`, async ({ page, request }, testInfo) => {
    const root = process.env.INFERENCE_LENS_N1_MATRIX_OUTPUT;
    test.skip(!root, "Run with playwright.n1-matrix.config.ts and the pinned Python environment.");
    const output = path.join(root!, scenario.id);
    const load = async (directory: string, name: string) => JSON.parse(await readFile(path.join(directory, name), "utf8"));
    const save = (name: string, value: unknown) => writeFile(path.join(output, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    const initial = await load(scenario.baseline, "provider-request-initial.json");
    const reference = await load(scenario.baseline, "provider-request-continuation.json");
    const endpoint = `http://127.0.0.1:${scenario.port}/v1`;
    const name = `N1 ${scenario.id}`;
    const project = createProjectFile({ name, request: { provider: "openai-compatible", endpoint,
      model: initial.model, temperature: initial.temperature, messages: initial.messages } });
    await seedProfile(page, { endpoint, model: initial.model, temperature: initial.temperature,
      instanceId: "profile-instance-n1", favoriteModels: [initial.model], capabilityOverrides: { tools: true } });
    await page.addInitScript(({ mapKey, projectId }) => {
      localStorage.setItem(mapKey, JSON.stringify({ [projectId]: { profileId: "buffered", profileInstanceId: "profile-instance-n1" } }));
    }, { mapKey: PROJECT_PROFILE_MAP_STORAGE_KEY, projectId: project.projectId });
    await page.goto("/");
    await waitForHydration(page);
    await importProject(page, project, name);
    await page.getByRole("tab", { name: "Tools" }).click();
    const panel = page.getByRole("region", { name: "MCP servers" });
    await panel.getByRole("combobox", { name: "Declared MCP server" }).selectOption("n1-matrix");
    const discovering = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/mcp/discovery");
    await panel.getByRole("button", { name: "Connect and browse tools" }).click();
    const discovered = await discovering;
    expect(discovered.ok()).toBe(true);
    await save("discovery.json", await discovered.json());
    await expect(panel).toContainText("2026-07-28");
    await panel.getByRole("checkbox", { name: `Select ${scenario.toolName}`, exact: true }).check();
    await panel.getByRole("button", { name: "Attach selected (1)" }).click();
    await page.getByRole("tab", { name: "Messages" }).click();
    await page.getByRole("button", { name: /^Run current conversation/ }).first().click();
    const card = page.locator(".tool-call-card").first();
    await expect(card).toContainText(JSON.stringify(scenario.arguments));
    await expect(readFile(path.join(output, "python-execution.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await card.getByRole("button", { name: "Approve this call" }).click();
    const executing = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/mcp/execute");
    await page.getByRole("button", { name: "Supply results and continue" }).click();
    const response = await executing;
    expect(response.ok()).toBe(true);
    const execution = await response.json();
    expect(execution.status).toBe("completed");
    expect(execution.isError).toBe(scenario.isError);
    await save("execution.json", execution);
    await expect(page.locator(".transcript-list")).toContainText("IL_N0_CAPTURE_COMPLETE");
    expect(await (await request.get(`http://127.0.0.1:${scenario.port}/status`)).json())
      .toMatchObject({ complete: true, requestCount: 2, problem: null });
    const actualInitial = await load(output, "provider-request-initial.json");
    const continuation = await load(output, "provider-request-continuation.json");
    expect(actualInitial.messages).toEqual(initial.messages);
    expect(actualInitial.tools).toHaveLength(1);
    expect(actualInitial.tools[0].function).toMatchObject({ name: scenario.toolName, description: scenario.description });
    expect(continuation.tools).toEqual(actualInitial.tools);
    expect(continuation.messages).toHaveLength(4);
    const call = continuation.messages[2].tool_calls[0];
    expect(call.function.name).toBe(scenario.toolName);
    expect(JSON.parse(call.function.arguments)).toEqual(scenario.arguments);
    expect(continuation.messages[3].tool_call_id).toBe(call.id);
    const receipt = await load(output, "python-execution.json");
    expect(receipt.arguments).toEqual(scenario.arguments);
    const result = continuation.messages[3].content;
    if (scenario.isError) {
      expect(receipt.error).toBe("IL_N0_EXPECTED_WORKFLOW_ERROR:IL_N0_EXPECTED_ERROR");
      expect(result).toContain(receipt.error);
      expect(result).not.toBe(reference.messages[3].content);
      expect(execution.content).toEqual([{ type: "text", text: result }]);
    } else {
      expect(receipt.error).toBeNull();
      expect(result).toBe(reference.messages[3].content);
      expect(receipt.result).toBe(result);
      expect(execution.content).toEqual([{ type: "text", text: result }]);
    }
    execFileSync(process.execPath, ["scripts/n1-compare-capture.mjs", output, scenario.id]);
    await page.screenshot({ path: path.join(output, "completed.png"), fullPage: true });
    const files: Record<string, string> = {};
    for (const file of ["discovery.json", "execution.json", "python-execution.json", "python-versions.json",
      "provider-request-initial.json", "provider-request-continuation.json", "provider-response-tool-call.json",
      "provider-response-final.json", "wire-differences.json", "completed.png"]) {
      files[file] = createHash("sha256").update(await readFile(path.join(output, file))).digest("hex");
    }
    await save("manifest.json", { evidenceVersion: 1, scenario: scenario.id, capturedAt: new Date().toISOString(),
      applicationBaseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      workingTreeStatus: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }),
      baseline: scenario.baseline, pythonPackages: await load(output, "python-versions.json"),
      transport: "streamable-http", provider: "Scripted local provider; buffered mode",
      schemaPolicy: "SDK-generated; no schema projection",
      resultPolicy: scenario.isError ? "Native ToolError; no n8n error projection" : "Explicit compact JSON-array text; structured_output=False",
      reviewStatus: "Unreviewed capture; not a compatibility claim", files });
    await testInfo.attach("N1 capture directory", { body: output, contentType: "text/plain" });
    console.log(`N1 ${scenario.id} capture: ${output}`);
  });
}
