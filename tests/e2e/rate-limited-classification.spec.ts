import { createServer } from "node:http";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  addEvaluationCase,
  addEvaluationCheck,
  addEvaluationInput,
  createEvaluationSuite,
  evaluationBindingCandidates,
  updateEvaluationCase,
  updateEvaluationCheck,
} from "../../packages/core/src/evaluation-suite-authoring";
import {
  createProjectFile,
  createPromptTemplate,
  insertPromptTemplateUse,
  serializeProjectFile,
} from "../../packages/core/src/project";
import type { ProjectFile } from "../../packages/core/src/project";
import {
  PROJECT_PROFILE_MAP_STORAGE_KEY,
  openMode,
  primaryAction,
  seedProfile,
  stubProjectDirectory,
  waitForHydration,
} from "./support";

/**
 * A rate-limited repetition, as a person reading the results and a baseline
 * comparison sees it.
 *
 * The 429 comes from a real loopback provider rather than a route stub at the
 * app's inference path, so the status reaches the classification through the
 * same transport a hosted provider's would.
 */

const PROJECT_NAME = "Rate limit fixture";
const PROFILE_INSTANCE_ID = "profile-instance-rate-limited";
const ANSWER = "Buffered fixture answer.";

/**
 * Buffered chat completions that answer every request, except that while
 * `limiting` is on it answers 429 to any request about replication.
 */
async function rateLimitingProvider() {
  const state = { limiting: false, refused: 0 };
  const server = createServer(async (request, reply) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      reply.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    if (state.limiting && body.includes("replication")) {
      state.refused += 1;
      reply.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
      reply.end(JSON.stringify({ error: { message: "Too many requests" } }));
      return;
    }
    reply.writeHead(200, { "content-type": "application/json" });
    reply.end(JSON.stringify({
      id: "chatcmpl-rate-limit-fixture",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: ANSWER }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1`,
    state,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

/** Two cases whose checks pass against the fixture's answer, one repetition each. */
function project(endpoint: string): ProjectFile {
  let file = createProjectFile({
    name: PROJECT_NAME,
    request: {
      provider: "openai-compatible",
      endpoint,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Hello" }],
    },
    idSuffix: "rate-limited",
    createdAt: "2026-10-09T12:00:00.000Z",
  });
  file = createPromptTemplate(file, {
    name: "Question",
    messages: [{ role: "user", content: "Explain {{topic}}." }],
    idSuffix: "question",
    createdAt: "2026-10-09T12:00:01.000Z",
  });
  file = insertPromptTemplateUse(file, {
    conversationRevisionId: file.defaults.conversationRevisionId,
    templateId: "template_question",
    itemIndex: 1,
    idSuffix: "question-use",
  });
  const candidates = evaluationBindingCandidates(file, file.defaults.conversationRevisionId);
  const created = createEvaluationSuite(file, "Topics", () => "topics");
  file = created.project;
  const input = addEvaluationInput(file, created.suiteId, candidates[0]!, () => "topic");
  file = input.project;
  for (const [index, value] of ["migrations", "replication"].entries()) {
    const added = addEvaluationCase(file, created.suiteId, () => `case-${index}`);
    file = updateEvaluationCase(added.project, created.suiteId, added.caseId, {
      name: value,
      values: { [input.inputId]: `database ${value}` },
    });
    file = addEvaluationCheck(file, created.suiteId, added.caseId, { kind: "contains" }, () => `check-${index}`);
    const check = file.evaluationSuites[0]!.cases[index]!.checks[0]!;
    file = updateEvaluationCheck(file, created.suiteId, added.caseId, {
      checkId: check.checkId,
      kind: "contains",
      label: "Answered by the fixture",
      value: "Buffered fixture",
    });
  }
  return file;
}

async function openDurableProject(page: Page, file: ProjectFile, endpoint: string): Promise<void> {
  await seedProfile(page, { endpoint, instanceId: PROFILE_INSTANCE_ID });
  await page.addInitScript(
    ({ mapKey, projectId, instanceId }) => {
      localStorage.setItem(mapKey, JSON.stringify({
        [projectId]: { profileId: "buffered", profileInstanceId: instanceId },
      }));
    },
    { mapKey: PROJECT_PROFILE_MAP_STORAGE_KEY, projectId: file.projectId, instanceId: PROFILE_INSTANCE_ID },
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubProjectDirectory(page, {
    name: "rate-limit-fixture",
    files: { "project.json": serializeProjectFile(file) },
    directories: ["traces", "experiments"],
  });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project folder…" }).click();
  await expect(page.locator(".brand")).toContainText(PROJECT_NAME);
  await page.locator(".project-menu").evaluate((element) => element.removeAttribute("open"));
  await openMode(page, "Evaluations");
}

async function runEvaluation(page: Page) {
  await expect(page.locator(".evaluation-editor")).toContainText("Ready to run");
  await primaryAction(page, "evaluations").click();
  const dialog = page.getByRole("dialog", { name: /Start “Topics”/ });
  await dialog.getByRole("button", { name: "Start 2 calls" }).click();
}

test("a rate-limited case reads as incomplete, and against a baseline as inconclusive rather than regressed", async ({ page }) => {
  const provider = await rateLimitingProvider();
  try {
    await openDurableProject(page, project(provider.endpoint), provider.endpoint);
    const results = page.locator(".evaluation-results-workspace");

    // Baseline: the provider answers everything.
    await runEvaluation(page);
    await expect(results).toContainText("2 / 2 passed");
    await results.getByRole("button", { name: "Back to editing" }).click();
    await page.locator(".evaluation-suite-history").getByText("Past executions").click();
    const entries = page.locator(".evaluation-suite-history-entry");
    await expect(entries).toHaveCount(1);
    await entries.first().getByRole("button", { name: "Pin as baseline…" }).click();
    await page.getByLabel("Baseline name").fill("Unlimited");
    await entries.first().getByRole("button", { name: "Save baseline" }).click();
    await expect(entries.first()).toContainText("Baseline · Unlimited");

    // Candidate: the provider refuses the replication case with a 429.
    provider.state.limiting = true;
    await runEvaluation(page);
    await expect(results).toContainText("1 / 2 passed");
    expect(provider.state.refused, "the fixture really answered 429").toBe(1);
    await expect(results).toContainText("0 failed · 1 incomplete");
    const replication = results.locator(".evaluation-case-result").filter({ hasText: "replication" });
    await expect(replication.locator(".evaluation-repetition-heading .run-history-status")).toHaveText("rate limited");
    await expect(results).not.toContainText("run failed");
    expect(await results.innerText()).not.toMatch(/NaN|Infinity|undefined|\[object Object\]/);

    await results.getByRole("button", { name: "Back to editing" }).click();
    await expect(entries).toHaveCount(2);
    const candidate = entries.filter({ hasNotText: "Baseline · Unlimited" });
    const baselineOption = candidate.getByLabel("Compare against baseline").locator("option", { hasText: "Unlimited" });
    await candidate.getByLabel("Compare against baseline").selectOption({ label: (await baselineOption.innerText()).trim() });
    await candidate.getByRole("button", { name: "Compare" }).click();

    const comparison = page.getByRole("region", { name: "Evaluation comparison" });
    const tiles = comparison.getByLabel("Comparison summary");
    await expect(tiles.locator("div").filter({ hasText: "Regressed" }).locator("strong")).toHaveText("0");
    await expect(tiles.locator("div").filter({ hasText: "Inconclusive" }).locator("strong")).toHaveText("1");
    const row = comparison.locator("tr").filter({ hasText: "replication" });
    await expect(row).toContainText("inconclusive · rate limited");
    // The candidate's missing evidence is named on its side, not left to read as a failed check.
    await expect(row.locator("td").nth(1)).toContainText("1 rate limited");
    await expect(comparison).not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);
  } finally {
    await provider.close();
  }
});
