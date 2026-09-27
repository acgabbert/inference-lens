import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createProjectFile } from "../../packages/core/src/project";
import { wireDifferences } from "../../scripts/n1-wire-diff.mjs";
import { importProject, seedProfile, waitForHydration, PROJECT_PROFILE_MAP_STORAGE_KEY } from "./support";

const baseline = "tests/fixtures/n8n/captures/2.39.10/string-input-tool-workflow";

test("N1 captures Python discovery, attachment, execution and provider continuation", async ({ page, request }, testInfo) => {
  const output = process.env.INFERENCE_LENS_N1_OUTPUT;
  test.skip(!output, "Run with --config playwright.n1.config.ts and the pinned Python environment.");
  const initial = JSON.parse(await readFile(path.join(baseline, "provider-request-initial.json"), "utf8"));
  const endpoint = "http://127.0.0.1:44022/v1";
  const project = createProjectFile({ name: "N1 string input",
    request: { provider: "openai-compatible", endpoint, model: initial.model,
      temperature: 0, messages: initial.messages } });
  await seedProfile(page, { endpoint, model: initial.model, temperature: 0,
    instanceId: "profile-instance-n1", favoriteModels: [initial.model], capabilityOverrides: { tools: true } });
  await page.addInitScript(({ mapKey, projectId }) => {
    localStorage.setItem(mapKey, JSON.stringify({ [projectId]: { profileId: "buffered", profileInstanceId: "profile-instance-n1" } }));
  }, { mapKey: PROJECT_PROFILE_MAP_STORAGE_KEY, projectId: project.projectId });
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, project, "N1 string input");
  await page.getByRole("tab", { name: "Tools" }).click();
  const panel = page.getByRole("region", { name: "MCP servers" });
  await panel.getByRole("combobox", { name: "Declared MCP server" }).selectOption("n1-string-input");
  const discoveryResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/mcp/discovery");
  await panel.getByRole("button", { name: "Connect and browse tools" }).click();
  const discovery = await discoveryResponse;
  expect(discovery.ok()).toBe(true);
  await writeFile(path.join(output!, "discovery.json"), await discovery.text());
  await panel.getByRole("checkbox", { name: "Select il_echo_string", exact: true }).check();
  await panel.getByRole("button", { name: "Attach selected (1)" }).click();
  await page.getByRole("tab", { name: "Messages" }).click();
  await page.getByRole("button", { name: /^Run current conversation/ }).first().click();
  const card = page.locator(".tool-call-card").first();
  await expect(card).toContainText('"text":"IL_N0_STRING_VALUE"');
  await expect(readFile(path.join(output!, "python-execution.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  await card.getByRole("button", { name: "Approve this call" }).click();
  const executionResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/mcp/execute");
  await page.getByRole("button", { name: "Supply results and continue" }).click();
  const execution = await executionResponse;
  expect(execution.ok()).toBe(true);
  const executed = await execution.json();
  expect(executed.status).toBe("completed");
  expect(executed.isError).toBe(false);
  await writeFile(path.join(output!, "execution.json"), JSON.stringify(executed, null, 2));
  await expect(page.locator(".transcript-list")).toContainText("IL_N0_CAPTURE_COMPLETE");
  expect(await (await request.get("http://127.0.0.1:44022/status")).json())
    .toMatchObject({ complete: true, requestCount: 2, problem: null });
  const continuation = JSON.parse(await readFile(path.join(output!, "provider-request-continuation.json"), "utf8"));
  const reference = JSON.parse(await readFile(path.join(baseline, "provider-request-continuation.json"), "utf8"));
  expect(continuation.messages[3].content).toBe(reference.messages[3].content);
  expect(continuation.messages[3].tool_call_id).toBe(continuation.messages[2].tool_calls[0].id);
  expect(continuation.tools[0].function.name).toBe("il_echo_string");
  expect(JSON.parse(await readFile(path.join(output!, "python-execution.json"), "utf8")))
    .toEqual({ arguments: { text: "IL_N0_STRING_VALUE" }, result: reference.messages[3].content });
  const golden = "tests/fixtures/mcp-servers/n1-string-input";
  const differences: Record<string, unknown> = {};
  for (const phase of ["initial", "continuation"]) {
    const filename = `provider-request-${phase}.json`;
    const actual = JSON.parse(await readFile(path.join(output!, filename), "utf8"));
    expect(actual).toEqual(JSON.parse(await readFile(path.join(golden, filename), "utf8")));
    differences[phase] = wireDifferences(JSON.parse(await readFile(path.join(baseline, filename), "utf8")), actual);
  }
  await writeFile(path.join(output!, "wire-differences.json"), JSON.stringify({ baseline, candidate: "Python MCP string-input", phases: differences }, null, 2));
  await page.screenshot({ path: path.join(output!, "completed.png"), fullPage: true });
  await testInfo.attach("N1 capture directory", { body: output!, contentType: "text/plain" });
  console.log(`N1 capture: ${output}`);
});
