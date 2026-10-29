import { createServer } from "node:http";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { primaryAction, seedProfile, waitForHydration } from "./support";

/**
 * What the reflex action does after a failed attempt, once the user has
 * changed the request.
 *
 * Retry re-sends the failed attempt's frozen input, which is right when the
 * provider hiccupped and wrong when the request itself was the problem. So once
 * the composer would send something else, the failure card and ⌘↵ run the
 * edited request instead, and Retry stays available for the original.
 *
 * The provider is a loopback fixture owned by this spec rather than the shared
 * flaky fixture, whose request counter other specs reset in parallel. It
 * answers 503 to the first request and 200 afterwards, and keeps every body so
 * the spec can read which request was actually sent.
 */

const ANSWER = "Answered by the retry-after-edit fixture.";

async function failOnceProvider() {
  const bodies: string[] = [];
  const server = createServer(async (request, reply) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      reply.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    bodies.push(Buffer.concat(chunks).toString("utf8"));
    if (bodies.length === 1) {
      reply.writeHead(503, { "content-type": "text/plain" });
      reply.end("Intentional first-attempt failure.");
      return;
    }
    reply.writeHead(200, { "content-type": "application/json" });
    reply.end(JSON.stringify({
      id: "chatcmpl-retry-after-edit",
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
    /** The user turn's text in each request the provider received, in order. */
    userTexts(): string[] {
      return bodies.map((body) => {
        const messages = (JSON.parse(body) as { messages: { role: string; content: unknown }[] }).messages;
        const content = messages.filter(({ role }) => role === "user").at(-1)?.content;
        return typeof content === "string" ? content : JSON.stringify(content);
      });
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

type Provider = Awaited<ReturnType<typeof failOnceProvider>>;

let provider: Provider;
test.beforeEach(async () => { provider = await failOnceProvider(); });
test.afterEach(async () => { await provider.close(); });

async function open(page: Page): Promise<void> {
  await seedProfile(page, { endpoint: provider.endpoint, name: "Fail-once fixture" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await waitForHydration(page, "Fail-once fixture");
}

const userMessage = (page: Page) => page.getByLabel("Message 2 content");
const failureCard = (page: Page) => page.locator(".run-failure-state");

async function failFirstAttempt(page: Page): Promise<string> {
  const original = await userMessage(page).inputValue();
  await primaryAction(page, "compose").click();
  await expect(failureCard(page)).toContainText("Attempt failed");
  await expect.poll(() => provider.userTexts()).toEqual([original]);
  return original;
}

test("an unchanged request still retries the failed attempt", async ({ page }) => {
  await open(page);
  const original = await failFirstAttempt(page);

  await expect(failureCard(page).getByRole("button", { name: /^Retry attempt/ })).toBeVisible();
  await expect(failureCard(page).getByRole("button", { name: /^Run edited request/ })).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Enter");

  await expect(page.locator(".response-pane")).toContainText(ANSWER);
  expect(provider.userTexts()).toEqual([original, original]);
});

test("after editing, the reflex action sends the edited request", async ({ page }) => {
  await open(page);
  const original = await failFirstAttempt(page);

  await userMessage(page).fill("Say hello in one word.");
  await page.locator(".response-pane").click();
  await page.keyboard.press("ControlOrMeta+Enter");

  await expect.poll(() => provider.userTexts()).toEqual([original, "Say hello in one word."]);
  await expect(page.locator(".response-pane")).toContainText(ANSWER);
});

test("after editing, the failure card leads with the edited request and keeps Retry", async ({ page }) => {
  await open(page);
  const original = await failFirstAttempt(page);

  await userMessage(page).fill("Say hello in one word.");
  const card = failureCard(page);
  await expect(card).toContainText("The request has changed since this attempt.");
  await expect(card.getByRole("button", { name: /^Run edited request/ })).toBeVisible();
  await expect(primaryAction(page, "compose")).toBeEnabled();

  // Retry is still the original request, and says so.
  await card.getByRole("button", { name: /^Retry original request/ }).click();
  await expect(page.locator(".response-pane")).toContainText(ANSWER);
  expect(provider.userTexts()).toEqual([original, original]);
});

test("an empty user message blocks the run before anything is sent", async ({ page }) => {
  await open(page);

  await userMessage(page).fill("   ");
  await expect(primaryAction(page, "compose")).toBeDisabled();
  await expect(page.locator("body")).toContainText("The last user message is empty");
  await page.locator(".response-pane").click();
  await page.keyboard.press("ControlOrMeta+Enter");

  // Nothing may reach the provider; give a stray request time to arrive.
  await page.waitForTimeout(500);
  expect(provider.userTexts()).toEqual([]);

  // The notice's action lands in the message that needs writing.
  await page.getByRole("button", { name: "Write the message" }).first().click();
  await expect(userMessage(page)).toBeFocused();
});
