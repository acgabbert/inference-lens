import { readFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import { DECISIONS_API_PATH, INFERENCE_API_PATH } from "../../packages/contracts/src";
import {
  BUFFERED_FIXTURE_ENDPOINT,
  SYSTEM_ONE_FIXTURE_ORIGIN,
  seedProfiles,
  waitForHydration,
} from "./support";

/**
 * Decision Compose against the System One capture replay (D21). Model ids
 * name the capture scenario (D15), and the questions sent are the captured
 * ones, so every number asserted here is the captured server's own.
 */

function capturedRequest(name: string): { state: unknown; questions: unknown } {
  const fixture = JSON.parse(
    readFileSync(new URL(`../fixtures/system-one/${name}.json`, import.meta.url), "utf8"),
  );
  return { state: fixture.request.state, questions: fixture.request.questions };
}

const ALL_TYPES = capturedRequest("llamacpp-all-types");

async function seedDecisionProfiles(page: Page, runtime = "llamacpp"): Promise<void> {
  await seedProfiles(page, [
    { id: "buffered", instanceId: "buffered-instance", name: "Buffered fixture", endpoint: BUFFERED_FIXTURE_ENDPOINT },
    {
      id: "decisions",
      instanceId: "decisions-instance",
      name: "Decision fixture",
      endpoint: `${SYSTEM_ONE_FIXTURE_ORIGIN}/${runtime}/v1`,
      model: "unused-chat-model",
      systemOne: true,
    },
  ], "buffered");
}

async function openDecision(page: Page): Promise<void> {
  await page.goto("/");
  await waitForHydration(page);
  await page.getByRole("radio", { name: "Decision" }).click();
  await expect(page.getByRole("heading", { name: "Decision", level: 2 }).first()).toBeVisible();
}

function decisionPane(page: Page) {
  return page.getByRole("region", { name: "Decision request" });
}

async function enterJson(page: Page, input: unknown): Promise<void> {
  await decisionPane(page).getByRole("tab", { name: "JSON" }).first().click();
  await page.getByLabel("Decision input (state and questions)").fill(JSON.stringify(input, null, 2));
}

async function chooseModel(page: Page, model: string): Promise<void> {
  const combobox = decisionPane(page).getByRole("combobox", { name: "Model" });
  await combobox.fill(model);
  await combobox.press("Escape");
}

function runDecision(page: Page) {
  return page.getByRole("button", { name: /^Run decision/ });
}

async function expectNoBrokenNumbers(page: Page, selector: string): Promise<void> {
  const text = await page.locator(selector).innerText();
  expect(text).not.toMatch(/NaN|Infinity|undefined/);
}

test("runs the captured all-types decision and renders its exact values", async ({ page }) => {
  await seedDecisionProfiles(page);
  await openDecision(page);
  // Only the connection that declares System One is offered (U2, D9).
  const connection = decisionPane(page).getByLabel("Decision connection");
  await expect(connection.locator("option")).toHaveCount(1);
  await expect(connection.locator("option")).toHaveText(/Decision fixture/);

  await chooseModel(page, "all-types");
  await enterJson(page, ALL_TYPES);
  await runDecision(page).click();

  const intent = page.getByRole("article", { name: "Answer intent" });
  await expect(intent).toContainText("Choice billing");
  await expect(intent).toContainText("confidence 89.2%");
  await expect(intent.getByRole("listitem")).toHaveText([
    /billing\s*92\.8%/,
    /bug\s*5\.9%/,
    /other\s*1\.3%/,
  ]);
  const severity = page.getByRole("article", { name: "Answer severity" });
  await expect(severity).toContainText("Score 1.09 of 2");
  await expect(severity).toContainText("confidence 64.4%");
  await expect(severity.getByRole("listitem")).toHaveText([
    /0 · minor\s*7\.5%/,
    /1 · major\s*76\.2%/,
    /2 · \{"label":"critical","note":"data loss or money lost"\}\s*16\.2%/,
  ]);
  const spam = page.getByRole("article", { name: "Answer is_spam" });
  await expect(spam.getByRole("listitem")).toHaveText([/P\(true\)\s*7\.8%/]);
  await expect(spam).not.toContainText("confidence");
  const response = page.locator(".decision-response");
  await expect(response).toContainText("203 input · 0 output · 203 total tokens");
  await expect(response).toContainText(/Duration\s*\d+(\.\d+)? (ms|s)/);
  await expectNoBrokenNumbers(page, ".decision-response");

  // Complete evidence: the exact request sent and the raw body received.
  const evidence = page.getByRole("region", { name: "Decision evidence" });
  await expect(evidence).toContainText("POST");
  await expect(evidence).toContainText("/llamacpp/v1/systemone");
  await expect(evidence.getByLabel("Attempt 1 raw response body")).toContainText("0.9282073370713441");
  await expectNoBrokenNumbers(page, ".decision-inspect");
});

test("each kind keeps its draft across switches, and form ↔ JSON is lossless", async ({ page }) => {
  await seedDecisionProfiles(page);
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Message 1 content").fill("Chat draft that must survive.");

  await page.getByRole("radio", { name: "Decision" }).click();
  await enterJson(page, ALL_TYPES);
  await decisionPane(page).getByRole("tab", { name: "Form" }).first().click();
  // The JSON-valued instructions are shown as a value, not stringified into text.
  await expect(decisionPane(page)).toContainText('["How urgent is this ticket?",{"consider":"customer impact"}]');

  await page.getByRole("radio", { name: "Chat" }).click();
  await expect(page.getByLabel("Message 1 content")).toHaveValue("Chat draft that must survive.");
  await page.getByRole("radio", { name: "Decision" }).click();

  await decisionPane(page).getByRole("tab", { name: "JSON" }).first().click();
  const text = await page.getByLabel("Decision input (state and questions)").inputValue();
  expect(JSON.stringify(JSON.parse(text))).toBe(JSON.stringify(ALL_TYPES));
});

test("invalid JSON blocks Run and the switch to the form, keeping the text", async ({ page }) => {
  await seedDecisionProfiles(page);
  await openDecision(page);
  await chooseModel(page, "all-types");
  await enterJson(page, ALL_TYPES);
  await expect(runDecision(page)).toBeEnabled();

  const broken = '{"state": "x", "questions": {';
  await page.getByLabel("Decision input (state and questions)").fill(broken);
  await expect(runDecision(page)).toBeDisabled();
  const reasonId = await runDecision(page).getAttribute("aria-describedby");
  expect(reasonId).toBeTruthy();
  await expect(page.locator(`#${reasonId}`)).toContainText("JSON: Not valid JSON");

  await decisionPane(page).getByRole("tab", { name: "Form" }).first().click();
  await expect(page.getByLabel("Decision input (state and questions)")).toHaveValue(broken);
  await expect(decisionPane(page).getByRole("alert").first()).toContainText("Not valid JSON");
});

test("a decision run locks the kind switch until it is stopped", async ({ page }) => {
  await seedDecisionProfiles(page);
  // Park the decision so the run is observably in flight.
  let release: (() => void) | undefined;
  await page.route(`**${DECISIONS_API_PATH}`, async (route) => {
    await new Promise<void>((resolve) => { release = resolve; });
    await route.continue().catch(() => {});
  });
  await openDecision(page);
  await chooseModel(page, "all-types");
  await enterJson(page, ALL_TYPES);
  await runDecision(page).click();

  await expect(page.locator(".decision-response")).toContainText("Waiting for decision…");
  await expect(page.getByRole("radio", { name: "Chat" })).toBeDisabled();
  await expect(page.getByText("Stop the running request to switch.")).toBeVisible();
  // The shortcut does not start a second run while one executes.
  await page.keyboard.press("Control+Enter");

  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.locator(".decision-response")).toContainText("Request stopped");
  await expect(page.getByRole("radio", { name: "Chat" })).toBeEnabled();
  release?.();
  // A late answer cannot revive the stopped run.
  await page.waitForTimeout(300);
  await expect(page.locator(".decision-response")).toContainText("Request stopped");
});

test("a running chat request locks the switch to Decision", async ({ page }) => {
  await seedDecisionProfiles(page);
  let release: (() => void) | undefined;
  await page.route(`**${INFERENCE_API_PATH}`, async (route) => {
    await new Promise<void>((resolve) => { release = resolve; });
    await route.continue().catch(() => {});
  });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByRole("button", { name: /^Run current conversation/ }).click();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Decision" })).toBeDisabled();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Decision" })).toBeEnabled();
  release?.();
});

test("a 429 waits out retry-after, then retries the same input with attempts kept", async ({ page }) => {
  await seedDecisionProfiles(page);
  await openDecision(page);
  await chooseModel(page, "429");
  await enterJson(page, ALL_TYPES);
  await runDecision(page).click();

  const response = page.locator(".decision-response");
  await expect(response).toContainText("Attempt 1 failed");
  const retry = response.getByRole("button", { name: /^Retry attempt/ });
  // The synthetic fixture sends retry-after: 1.
  await expect(response).toContainText(/Retry is available in 1 second/);
  await expect(retry).toBeDisabled();
  await expect(retry).toBeEnabled({ timeout: 3_000 });
  await retry.click();
  // The fixture answers every request with 429, so a success after the wait
  // cannot be shown; the second attempt is retained beside the first.
  await expect(response).toContainText("Attempt 2 failed");
  const evidence = page.getByRole("region", { name: "Decision evidence" });
  await expect(evidence.getByRole("article")).toHaveCount(2);
  await expect(evidence.getByLabel("Attempt 2 raw response body")).toContainText("Synthetic rate limit");

  await response.getByRole("button", { name: "Discard failed run" }).click();
  await expect(response).toContainText("Request failed");
});

test("a provider error is readable and its body is kept as evidence", async ({ page }) => {
  await seedDecisionProfiles(page);
  await openDecision(page);
  await chooseModel(page, "401");
  await enterJson(page, ALL_TYPES);
  await runDecision(page).click();
  await expect(page.locator(".decision-response")).toContainText("Invalid API Key");
  await expect(page.getByRole("region", { name: "Decision evidence" }).getByLabel("Attempt 1 raw response body"))
    .toContainText('"authentication_error"');
});

test("discovery lists marked decision models, and an unfiltered listing says so", async ({ page }) => {
  await seedDecisionProfiles(page);
  await openDecision(page);
  await decisionPane(page).getByRole("combobox", { name: "Model" }).click();
  await expect(decisionPane(page).getByRole("listbox").getByRole("option")).toHaveText(["local-decision"]);
  await expect(decisionPane(page).getByText(/does not mark decision models/)).toHaveCount(0);
});

test("a proxied Ollama listing is unfiltered, and a typed model id still runs", async ({ page }) => {
  await seedDecisionProfiles(page, "ollama-proxied");
  await openDecision(page);
  await decisionPane(page).getByRole("combobox", { name: "Model" }).click();
  await expect(decisionPane(page).getByText(/does not mark decision models/)).toBeVisible();
  await chooseModel(page, "all-types");
  await enterJson(page, capturedRequest("ollama-all-types"));
  await runDecision(page).click();
  await expect(page.getByRole("article", { name: "Answer intent" })).toContainText("billing");
});

test("an exported decision trace imports back to the same rendered result", async ({ page }) => {
  await seedDecisionProfiles(page);
  await openDecision(page);
  await chooseModel(page, "all-types");
  await enterJson(page, ALL_TYPES);
  await runDecision(page).click();
  await expect(page.getByRole("article", { name: "Answer intent" })).toBeVisible();
  const before = await page.locator(".decision-answers").innerText();
  const evidenceBefore = await page.getByLabel("Attempt 1 raw response body").innerText();

  await page.locator(".run-data-menu > summary").click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export run trace…" }).click(),
  ]);
  const path = await download.path();
  expect(JSON.parse(readFileSync(path, "utf8")).kind).toBe("decision");

  // A fresh page: nothing of the live run survives except the file.
  await page.reload();
  await waitForHydration(page);
  await expect(page.getByRole("radio", { name: "Chat" })).toHaveAttribute("aria-checked", "true");
  await page.locator('.menu-file-button:has-text("Import run trace") input[type=file]').setInputFiles(path);
  await expect(page.getByRole("radio", { name: "Decision" })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".decision-response")).toContainText("Imported run trace");
  expect(await page.locator(".decision-answers").innerText()).toBe(before);
  expect(await page.getByLabel("Attempt 1 raw response body").innerText()).toBe(evidenceBefore);

});

test("Connections declares System One, which offers the connection for decisions", async ({ page }) => {
  await seedProfiles(page, [
    { id: "buffered", instanceId: "buffered-instance", name: "Buffered fixture", endpoint: `${SYSTEM_ONE_FIXTURE_ORIGIN}/llamacpp/v1` },
  ], "buffered");
  await openDecision(page);
  await expect(decisionPane(page)).toContainText("No connection declares System One.");
  await decisionPane(page).getByRole("button", { name: "Open Connections" }).first().click();
  const drawer = page.getByRole("dialog", { name: "Connections" });
  await drawer.getByRole("checkbox", { name: /System One/ }).check();
  await drawer.getByRole("button", { name: /close/i }).first().click();
  await expect(decisionPane(page).getByLabel("Decision connection").locator("option")).toHaveText([/Buffered fixture/]);
});
