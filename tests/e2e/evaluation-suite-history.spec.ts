import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { createEvaluationExperimentPlan } from "../../packages/core/src/evaluation-execution";
import {
  materializeExperimentCellInput,
  serializeExperimentPlan,
  serializeExperimentResult,
  type EvaluationExperimentPlanV3,
  type ExperimentResultV3,
} from "../../packages/core/src/experiment";
import {
  createProjectFile,
  parseProjectFile,
  serializeProjectFile,
} from "../../packages/core/src/project";
import { RunCoordinator } from "../../packages/core/src/run-kernel/coordinator";
import { createRunTrace } from "../../packages/core/src/run-kernel";
import type { ResolvedRunInput } from "../../packages/core/src/run-kernel/types";
import { serializeRunTrace } from "../../packages/core/src/run-trace";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../../packages/core/src/types";
import { stubProjectDirectory } from "./support";

/**
 * A project folder holding one evaluation suite and one finished execution of
 * it. Case values are chosen so the outcome is predictable rather than merely
 * plausible: the suite has two cases, one output contains "migration" and the
 * other does not, so the only correct pass rate the UI can show is 1/2. A
 * surface that mislabels run status as pass rate would read "2 completed" here
 * and the assertion below would catch it.
 */
function projectWithSuite() {
  const initial = createProjectFile({
    name: "Suite history fixture",
    idSuffix: "suite-history",
    createdAt: "2026-08-02T11:00:00.000Z",
    request: {
      provider: "openai-compatible",
      endpoint: "https://provider.example.test/v1",
      model: "history-fixture-model",
      messages: [{ role: "user", content: "Explain database migrations." }],
    },
  });
  return parseProjectFile({
    ...initial,
    evaluationSuites: [{
      id: "evaluation-suite_topics",
      name: "Topic quality",
      input: {
        kind: "conversation-revision",
        conversationRevisionId: initial.defaults.conversationRevisionId,
      },
      execution: {
        target: { ...initial.defaults.target },
        responseMode: "buffered",
        options: {},
        repetitions: 1,
      },
      inputBindings: [],
      cases: [
        {
          id: "evaluation-case_migrations",
          name: "Mentions migrations",
          values: {},
          checks: [{
            checkId: "check_mentions-migrations",
            kind: "contains",
            value: "migration",
            caseSensitive: false,
          }],
        },
        {
          id: "evaluation-case_rollbacks",
          name: "Mentions rollbacks",
          values: {},
          checks: [{
            checkId: "check_mentions-rollbacks",
            kind: "contains",
            value: "rollback",
            caseSensitive: false,
          }],
        },
      ],
    }],
  });
}

function completed(input: ResolvedRunInput, text: string) {
  const coordinator = new RunCoordinator(input);
  const { execution } = coordinator.start();
  coordinator.accept({ type: "text_delta", text, source: { exchangeId: execution.exchangeId } });
  coordinator.accept({
    type: "completed",
    finishReason: { normalized: "stop" },
    source: { exchangeId: execution.exchangeId },
  });
  coordinator.finishTurnStream();
  return coordinator.state;
}

function historyFixture() {
  const project = projectWithSuite();
  let suffix = 0;
  const plan: EvaluationExperimentPlanV3 = createEvaluationExperimentPlan({
    project,
    suiteId: "evaluation-suite_topics",
    selectedCaseIds: ["evaluation-case_migrations", "evaluation-case_rollbacks"],
    createdAt: "2026-08-02T12:00:00.000Z",
    createSuffix: () => `suite-history-${++suffix}`,
    runtimeTarget: {
      profileId: "profile_history",
      protocol: "openai-compatible-chat-completions",
      endpoint: "https://provider.example.test/v1",
      capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
    },
  });
  // Both runs complete. Only the first satisfies its check, so strict scoring
  // must report one passing case out of two.
  const outputs = [
    "Database migrations need a plan.",
    "Take a backup before you begin.",
  ];
  const traces = plan.cells.map((cell, index) => {
    const state = completed(
      materializeExperimentCellInput(plan, cell.cellId),
      outputs[index]!,
    );
    return { fileName: `${state.runId}.json`, contents: serializeRunTrace(createRunTrace(state)) };
  });
  const result: ExperimentResultV3 = {
    schemaVersion: 3,
    experimentId: plan.experimentId,
    status: "completed",
    endedAt: "2026-08-02T12:01:00.000Z",
    cells: plan.cells.map((cell) => ({
      cellId: cell.cellId,
      runId: cell.runId,
      status: "completed",
    })),
  };
  return {
    files: {
      "project.json": serializeProjectFile(project),
      [`experiments/${plan.experimentId}.plan.json`]: serializeExperimentPlan(plan),
      [`experiments/${plan.experimentId}.result.json`]: serializeExperimentResult(result, plan),
      ...Object.fromEntries(traces.map(({ fileName, contents }) => [`traces/${fileName}`, contents])),
    },
    planFileName: `${plan.experimentId}.plan.json`,
  };
}

async function openFixtureProject(page: Page): Promise<void> {
  const { files } = historyFixture();
  await stubProjectDirectory(page, {
    name: "suite-history-fixture",
    files,
    directories: [],
  });
  await page.goto("/");
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project…" }).click();
  await expect(page.getByText(/Inspect every model run · Suite history fixture/)).toBeVisible();
  await page.getByRole("tab", { name: /Evaluations/ }).click();
}

test("past executions of the authored suite open from the suite editor", async ({ page }) => {
  await openFixtureProject(page);

  const section = page.locator(".evaluation-suite-history");
  await expect(section).toBeVisible();
  const items = section.locator(".evaluation-suite-history-item");

  // Collapsed, and nothing has been listed: the projection parses every
  // artifact in the folder, so an unopened section must not pay for it. A
  // count would prove the listing already ran, which is exactly what must not
  // have happened yet.
  await expect(section).not.toHaveAttribute("open", /.*/);
  await expect(items).toHaveCount(0);
  // Collapsed, the card must still say it opens and what is behind it.
  await expect(section).toContainText("Show saved runs of this suite");
  await expect(section).not.toContainText("saved execution of this suite");

  await section.getByText("Past executions").click();
  await expect(section).toContainText("1 saved execution of this suite");
  await expect(section).toContainText("Hide");
  await expect(items).toHaveCount(1);

  // Two runs completed; one case passed. The row must report the evaluation
  // outcome, not the run status.
  await expect(items).toContainText("1/2 cases passed");
  await expect(items).not.toContainText("2 completed");
  await expect(items).toContainText("2 planned runs");
  await expect(section).not.toContainText("Ran against a different input revision");
  await expect(section).not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);

  await items.click();

  // Opening from the editor reaches the same results workspace the run-history
  // drawer reaches, with the same strict scoring.
  const workspace = page.getByRole("region", { name: "Evaluation results" });
  await expect(workspace).toBeVisible();
  await expect(workspace).toContainText("Topic quality");
  await expect(workspace).toContainText("1 / 2 passed");
  await expect(workspace).not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);
});

test("the run-history drawer filters saved evidence by kind", async ({ page }) => {
  await openFixtureProject(page);

  await page.getByLabel("Run data menu").click();
  await page.getByRole("button", { name: "Run history…" }).click();

  const entries = page.locator(".run-history-item");
  // The evaluation's own traces are grouped into it rather than listed loose,
  // so the folder's three artifacts read as one entry.
  await expect(entries).toHaveCount(1);
  await expect(entries).toContainText("Evaluation · Topic quality");
  await expect(entries).toContainText("1/2 cases passed");

  await page.getByRole("group", { name: "Filter saved evidence" })
    .getByRole("button", { name: "Runs" }).click();
  await expect(entries).toHaveCount(0);
  await expect(page.locator(".run-history-empty")).toContainText("Nothing matches this filter");

  await page.getByRole("group", { name: "Filter saved evidence" })
    .getByRole("button", { name: "Evaluations" }).click();
  await expect(entries).toHaveCount(1);
});
