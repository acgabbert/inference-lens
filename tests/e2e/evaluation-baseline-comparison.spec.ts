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
  type ProjectFile,
} from "../../packages/core/src/project";
import { RunCoordinator } from "../../packages/core/src/run-kernel/coordinator";
import { createRunTrace } from "../../packages/core/src/run-kernel";
import type { ResolvedRunInput } from "../../packages/core/src/run-kernel/types";
import { serializeRunTrace } from "../../packages/core/src/run-trace";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../../packages/core/src/types";
import { stubProjectDirectory, openMode } from "./support";

/**
 * Three executions of one two-case suite, chosen so every number on the
 * comparison screen has exactly one correct value:
 *
 * - `baseline-model`  — mentions migrations, not rollbacks → 1/2 cases pass
 * - `candidate-model` — the mirror image                   → 1/2 cases pass
 * - `partial-model`   — like the baseline, but the rollback repetition's trace
 *                       is missing from the folder
 *
 * Comparing the first two must therefore report exactly one regression and
 * exactly one fix — a surface that compared pass *rates* would report "no
 * change", since both executions pass one case of two.
 */
function projectWithSuite(model: string): ProjectFile {
  const initial = createProjectFile({
    name: "Baseline comparison fixture",
    idSuffix: "baseline-comparison",
    createdAt: "2026-08-02T11:00:00.000Z",
    request: {
      provider: "openai-compatible",
      endpoint: "https://provider.example.test/v1",
      model,
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
        target: { ...initial.defaults.target, model },
        responseMode: "buffered",
        options: {},
        repetitions: 1,
        toolIds: [],
      },
      inputBindings: [],
      variants: [{ id: "evaluation-variant_default", name: "Default", overrides: {} }],
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

interface ExecutionFixture {
  model: string;
  createdAt: string;
  idPrefix: string;
  /** One output per case, in suite order. */
  outputs: [string, string];
  /** Case ids whose trace is deliberately absent from the folder. */
  withoutTraces?: string[];
}

function executionFiles(fixture: ExecutionFixture): Record<string, string> {
  const project = projectWithSuite(fixture.model);
  let suffix = 0;
  const plan: EvaluationExperimentPlanV3 = createEvaluationExperimentPlan({
    project,
    suiteId: "evaluation-suite_topics",
    selectedCaseIds: ["evaluation-case_migrations", "evaluation-case_rollbacks"],
    createdAt: fixture.createdAt,
    createSuffix: () => `${fixture.idPrefix}-${++suffix}`,
    runtimeTarget: {
      profileId: "profile_history",
      protocol: "openai-compatible-chat-completions",
      endpoint: "https://provider.example.test/v1",
      capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
    },
  });
  const withoutTraces = new Set(fixture.withoutTraces ?? []);
  const traces: Array<[string, string]> = [];
  plan.cells.forEach((cell, index) => {
    const state = completed(
      materializeExperimentCellInput(plan, cell.cellId),
      fixture.outputs[index]!,
    );
    if (withoutTraces.has(cell.caseId)) return;
    traces.push([`traces/${state.runId}.json`, serializeRunTrace(createRunTrace(state))]);
  });
  const result: ExperimentResultV3 = {
    schemaVersion: 4,
    experimentId: plan.experimentId,
    status: "completed",
    endedAt: fixture.createdAt,
    cells: plan.cells.map((cell) => ({
      cellId: cell.cellId,
      runId: cell.runId,
      status: "completed" as const,
    })),
  };
  return {
    [`experiments/${plan.experimentId}.plan.json`]: serializeExperimentPlan(plan),
    [`experiments/${plan.experimentId}.result.json`]: serializeExperimentResult(result, plan),
    ...Object.fromEntries(traces),
  };
}

async function openFixtureProject(page: Page): Promise<void> {
  await stubProjectDirectory(page, {
    name: "baseline-comparison-fixture",
    files: {
      "project.json": serializeProjectFile(projectWithSuite("baseline-model")),
      ...executionFiles({
        model: "baseline-model",
        createdAt: "2026-08-02T12:00:00.000Z",
        idPrefix: "baseline",
        outputs: ["Database migrations need a plan.", "Take a backup."],
      }),
      ...executionFiles({
        model: "candidate-model",
        createdAt: "2026-08-02T13:00:00.000Z",
        idPrefix: "candidate",
        outputs: ["Take a backup.", "Plan the rollback."],
      }),
      ...executionFiles({
        model: "partial-model",
        createdAt: "2026-08-02T14:00:00.000Z",
        idPrefix: "partial",
        outputs: ["Database migrations need a plan.", "Take a backup."],
        withoutTraces: ["evaluation-case_rollbacks"],
      }),
    },
    directories: [],
  });
  await page.goto("/");
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project…" }).click();
  await expect(page.getByText(/Inspect every model run · Baseline comparison fixture/)).toBeVisible();
  await openMode(page, "Evaluations");
  await page.locator(".evaluation-suite-history").getByText("Past executions").click();
  await expect(page.locator(".evaluation-suite-history-entry")).toHaveCount(3);
}

function entry(page: Page, model: string) {
  return page.locator(".evaluation-suite-history-entry").filter({ hasText: model });
}

async function pinBaseline(page: Page): Promise<void> {
  const baseline = entry(page, "baseline-model");
  await baseline.getByRole("button", { name: "Pin as baseline…" }).click();
  await page.getByLabel("Baseline name").fill("Before the model swap");
  await baseline.getByRole("button", { name: "Save baseline" }).click();
  await expect(baseline).toContainText("Baseline · Before the model swap");
}

test("a pinned baseline separates a regression from a fix and names the drift", async ({ page }) => {
  await openFixtureProject(page);
  await pinBaseline(page);

  const candidate = entry(page, "candidate-model");
  await candidate.getByLabel("Compare against baseline").selectOption({ label: "Before the model swap" });
  await candidate.getByRole("button", { name: "Compare" }).click();

  const comparison = page.getByRole("region", { name: "Evaluation comparison" });
  await expect(comparison).toBeVisible();
  await expect(comparison).toContainText("Before the model swap");

  // Both executions pass one case of two. Only a per-case comparison can tell
  // that anything changed at all, which is the whole point of the screen.
  const summary = comparison.getByLabel("Comparison summary");
  await expect(summary.locator("div").filter({ hasText: "Regressed" }).locator("strong"))
    .toHaveText("1");
  await expect(summary.locator("div").filter({ hasText: "Fixed" }).locator("strong"))
    .toHaveText("1");
  await expect(summary.locator("div").filter({ hasText: "Unchanged" }).locator("strong"))
    .toHaveText("0 passing · 0 failing");

  const rows = comparison.locator(".evaluation-comparison-table tbody tr");
  await expect(rows.filter({ hasText: "Mentions migrations" })).toContainText("regressed");
  await expect(rows.filter({ hasText: "Mentions rollbacks" })).toContainText("fixed");

  // The model moved between these executions, so the finding is qualified
  // rather than presented as a pure prompt regression.
  const drift = comparison.getByLabel("Execution differences");
  await expect(drift).toContainText("did not run under the same conditions");
  await expect(drift).toContainText("baseline-model");
  await expect(drift).toContainText("candidate-model");

  await expect(comparison).toContainText("1/2 → 1/2");
  await expect(comparison).not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);

  // The pin is an annotation in the project folder, not a change to evidence:
  // reopening the baseline execution still reads exactly as it did.
  await comparison.getByRole("button", { name: "Back to editing" }).click();
  await entry(page, "baseline-model").locator(".evaluation-suite-history-item").click();
  const workspace = page.getByRole("region", { name: "Evaluation results" });
  await expect(workspace).toContainText("1 / 2 passed");
});

test("a case whose trace is missing is reported, not dropped from the comparison", async ({ page }) => {
  await openFixtureProject(page);
  await pinBaseline(page);

  const partial = entry(page, "partial-model");
  await partial.getByLabel("Compare against baseline").selectOption({ label: "Before the model swap" });
  await partial.getByRole("button", { name: "Compare" }).click();

  const comparison = page.getByRole("region", { name: "Evaluation comparison" });
  await expect(comparison).toBeVisible();

  // Both cases are still listed and still counted. The rollback case has no
  // readable evidence on the candidate side, and the row says so rather than
  // quietly shrinking the denominator to make the run look complete.
  const rows = comparison.locator(".evaluation-comparison-table tbody tr");
  await expect(rows.filter({ hasText: "Mentions migrations" })).toContainText("unchanged");
  const missing = rows.filter({ hasText: "Mentions rollbacks" });
  await expect(missing).toContainText("1 trace missing");
  await expect(comparison).toContainText("1/2 → 1/2");
  await expect(comparison).not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);
});
