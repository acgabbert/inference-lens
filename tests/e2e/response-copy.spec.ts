import { expect, test } from "@playwright/test";

import { seedProfile, waitForHydration } from "./support";

import { controlledStream } from "./support/controlled-stream";

/**
 * The response pane renders Markdown, so selecting the rendered text loses the
 * syntax. Copying has to hand back the characters the model produced.
 */
const ANSWER = "# Result\n\nSome **bold** text and `code`.\n\n- one\n- two\n";

test("the live answer and each finished assistant message copy their Markdown source", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const provider = await controlledStream();
  try {
    await seedProfile(page, { endpoint: provider.endpoint, model: "controlled-stream", streaming: "stream" });
    await page.goto("/");
    await waitForHydration(page);
    await page.getByLabel("Message 1 content").fill("Format something");
    await page.getByRole("button", { name: "Run current conversation ⌘↵" }).click();
    await expect.poll(() => provider.request()).toMatchObject({ stream: true });

    provider.send(ANSWER);
    const output = page.locator(".output-scroll");
    await expect(output.locator(".markdown-body h1")).toHaveText("Result");
    await output.getByRole("button", { name: "Copy Markdown" }).click();
    await expect(output.getByRole("status").filter({ hasText: "Copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(ANSWER);

    await page.evaluate(() => navigator.clipboard.writeText(""));
    provider.finish();
    await expect(page.getByLabel("Run summary")).toContainText("Completed");

    const transcript = page.getByLabel("Run transcript");
    const assistant = transcript.locator("article").filter({ hasText: "assistant" });
    const user = transcript.locator("article").filter({ hasText: "user" });
    // Authored messages are the user's own text; only model output is offered.
    await expect(user.getByRole("button", { name: "Copy Markdown" })).toHaveCount(0);
    await assistant.getByRole("button", { name: "Copy Markdown" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(ANSWER);
    // Copying is not a click on the row: the message stays expanded.
    await expect(assistant.locator(".transcript-body h1")).toHaveText("Result");
  } finally {
    await provider.close();
  }
});
