import { expect, test, type Page } from "@playwright/test";

import {
  BUFFERED_FIXTURE_ENDPOINT,
  SYSTEM_ONE_FIXTURE_ORIGIN,
  seedProfiles,
  waitForHydration,
} from "./support";

/**
 * The Decision form's guidance for people new to decision models: field
 * hints, the "How decision requests work" guide, and the worked example.
 * Nothing here runs a request.
 */

async function openDecision(page: Page): Promise<void> {
  await seedProfiles(page, [
    { id: "buffered", instanceId: "buffered-instance", name: "Buffered fixture", endpoint: BUFFERED_FIXTURE_ENDPOINT },
    {
      id: "decisions",
      instanceId: "decisions-instance",
      name: "Decision fixture",
      endpoint: `${SYSTEM_ONE_FIXTURE_ORIGIN}/llamacpp/v1`,
      model: "unused-chat-model",
      systemOne: true,
    },
  ], "buffered");
  await page.goto("/");
  await waitForHydration(page);
  await page.getByRole("radio", { name: "Decision" }).click();
  await expect(page.getByRole("heading", { name: "Decision", level: 2 }).first()).toBeVisible();
}

function decisionPane(page: Page) {
  return page.getByRole("region", { name: "Decision request" });
}

async function exampleJson(page: Page): Promise<{ state: unknown; questions: Record<string, { type: string }> }> {
  await decisionPane(page).getByRole("tab", { name: "JSON" }).first().click();
  return JSON.parse(await page.getByLabel("Decision input (state and questions)").inputValue());
}

test("an untouched draft opens the guide, and each field says what it is for", async ({ page }) => {
  await openDecision(page);
  const pane = decisionPane(page);
  const guide = pane.locator("details.decision-guide");
  await expect(guide).toHaveAttribute("open", "");
  await expect(guide.getByText("How decision requests work")).toBeVisible();
  await expect(guide).toContainText("returns a probability for each option");

  await expect(pane.getByRole("region", { name: "State" })).toContainText("What the model judges");
  const question = pane.getByRole("article", { name: "Question 1" });
  await expect(question).toContainText("The question to ask about the state");
  await expect(question).toContainText("Picks one option");

  await question.getByLabel("Type").selectOption("score");
  await expect(question).toContainText("Rates the state on your levels, low to high");
  await question.getByLabel("Type").selectOption("noul");
  await expect(question).toContainText("probability that the answer is true");
});

test("Load example fills an untouched draft without asking", async ({ page }) => {
  await openDecision(page);
  await decisionPane(page).getByRole("button", { name: "Load example" }).click();
  await expect(page.getByRole("button", { name: "Replace with example" })).toHaveCount(0);
  const input = await exampleJson(page);
  expect(typeof input.state).toBe("string");
  expect(Object.fromEntries(Object.entries(input.questions).map(([id, { type }]) => [id, type]))).toEqual({
    intent: "choice",
    severity: "score",
    is_spam: "noul",
  });
});

test("Load example asks before replacing an edited draft, and Cancel keeps it", async ({ page }) => {
  await openDecision(page);
  const pane = decisionPane(page);
  const state = pane.getByLabel("State text");
  await state.fill("My own state");

  await pane.getByRole("button", { name: "Load example" }).click();
  await expect(pane.getByText("Replace the current request with the example?")).toBeVisible();
  await pane.getByRole("button", { name: "Cancel" }).click();
  await expect(state).toHaveValue("My own state");
  await expect(pane.getByRole("button", { name: "Replace with example" })).toHaveCount(0);

  await pane.getByRole("button", { name: "Load example" }).click();
  await pane.getByRole("button", { name: "Replace with example" }).click();
  await expect(state).not.toHaveValue("My own state");
  expect(Object.keys((await exampleJson(page)).questions)).toEqual(["intent", "severity", "is_spam"]);
});
