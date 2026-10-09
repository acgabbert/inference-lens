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
 * Retrying a rate-limited request, opted into at the start dialog, as a person
 * reading the results sees it.
 *
 * The 429 comes from a real loopback provider, so the retry wait reads the
 * provider's own Retry-After through the same transport a hosted provider's
 * would, and the retried attempt is a second real request.
 */

const PROJECT_NAME = "Rate limit retry fixture";
const PROFILE_INSTANCE_ID = "profile-instance-rate-limit-retry";
const ANSWER = "Buffered fixture answer.";

/**
 * Buffered chat completions that answer every request, except that it answers
 * 429 to the first `refuseReplication` requests about replication, asking for
 * a one-second wait.
 */
async function rateLimitingProvider() {
  const state = { refuseReplication: 0, refused: 0, requests: 0 };
  const server = createServer(async (request, reply) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      reply.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    state.requests += 1;
    if (state.refused < state.refuseReplication && body.includes("replication")) {
      state.refused += 1;
      reply.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
      reply.end(JSON.stringify({ error: { message: "Too many requests" } }));
      return;
    }
    reply.writeHead(200, { "content-type": "application/json" });
    reply.end(JSON.stringify({
      id: "chatcmpl-rate-limit-retry-fixture",
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
    idSuffix: "rate-limit-retry",
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
    name: "rate-limit-retry-fixture",
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

test("a 429 is retried only when the start dialog asks, and the results say so", async ({ page }) => {
  const provider = await rateLimitingProvider();
  try {
    await openDurableProject(page, project(provider.endpoint), provider.endpoint);
    const results = page.locator(".evaluation-results-workspace");
    const start = async (retry: boolean) => {
      await expect(page.locator(".evaluation-editor")).toContainText("Ready to run");
      await primaryAction(page, "evaluations").click();
      const dialog = page.getByRole("dialog", { name: /Start “Topics”/ });
      const option = dialog.getByRole("checkbox", { name: "Retry rate-limited requests" });
      // Off every time the dialog opens, whatever the last run chose.
      await expect(option).not.toBeChecked();
      await expect(dialog).toContainText("retried up to 2 times per turn");
      if (retry) await option.check();
      await dialog.getByRole("button", { name: "Start 2 calls" }).click();
    };

    // Opted in: the refused request is retried after its wait and the case passes.
    provider.state.refuseReplication = 1;
    await start(true);
    await expect(results).toContainText("2 / 2 passed");
    expect(provider.state.refused, "the fixture really answered 429").toBe(1);
    expect(provider.state.requests, "the refused request was sent again").toBe(3);
    await expect(results.locator(".evaluation-results-header")).toContainText("rate-limited requests retried up to 2 times");
    await expect(results).toContainText("0 incomplete · 1 retried after rate limiting");
    const replication = results.locator(".evaluation-case-result").filter({ hasText: "replication" });
    await expect(replication.locator(".evaluation-repetition-heading .run-history-status")).toHaveText("passed");
    expect(await results.innerText()).not.toMatch(/NaN|Infinity|undefined|\[object Object\]/);

    // Not opted in: the same refusal is not retried and the case is incomplete.
    await results.getByRole("button", { name: "Back to editing" }).click();
    provider.state.refused = 0;
    provider.state.requests = 0;
    await start(false);
    await expect(results).toContainText("1 / 2 passed");
    expect(provider.state.requests, "nothing was retried").toBe(2);
    await expect(results.locator(".evaluation-results-header")).not.toContainText("retried");
    await expect(results).not.toContainText("retried after rate limiting");
    await expect(results.locator(".evaluation-case-result").filter({ hasText: "replication" })
      .locator(".evaluation-repetition-heading .run-history-status")).toHaveText("rate limited");
  } finally {
    await provider.close();
  }
});
