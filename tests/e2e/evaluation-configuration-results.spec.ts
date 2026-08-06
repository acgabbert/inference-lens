import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { createEvaluationExperimentPlan } from "../../packages/core/src/evaluation-execution";
import {
  materializeExperimentCellInput,
  serializeExperimentPlan,
  serializeExperimentResult,
  type EvaluationExperimentCellV4,
  type EvaluationExperimentPlanV4,
} from "../../packages/core/src/experiment";
import { createProjectFile, parseProjectFile, serializeProjectFile } from "../../packages/core/src/project";
import {
  createEntityId,
  createRunState,
  createRunTrace,
  reduceRunEvent,
  type RunEvent,
} from "../../packages/core/src/run-kernel";
import { serializeRunTrace } from "../../packages/core/src/run-trace";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../../packages/core/src/types";
import { openMode, seedProfile, stubProjectDirectory, waitForHydration } from "./support";

function completedTrace(
  plan: EvaluationExperimentPlanV4,
  cell: EvaluationExperimentCellV4,
  output: string,
  durationMs: number,
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number },
) {
  const input = materializeExperimentCellInput(plan, cell.cellId);
  const turnId = createEntityId("turn", `${cell.runId}-turn`);
  const exchangeId = createEntityId("exchange", `${cell.runId}-exchange`);
  const startedAt = Date.parse(plan.createdAt);
  const event = <Value extends Omit<RunEvent, "eventId" | "runId" | "sequence" | "occurredAt" | "elapsedMs">>(
    sequence: number,
    elapsedMs: number,
    value: Value,
  ): RunEvent => ({
    eventId: createEntityId("event", `${cell.runId}-${sequence}`),
    runId: cell.runId,
    sequence,
    occurredAt: new Date(startedAt + elapsedMs).toISOString(),
    elapsedMs,
    ...value,
  } as RunEvent);
  const turnInput = {
    target: input.target,
    messages: input.messages,
    responseMode: input.responseMode,
    options: input.options,
    tools: input.tools,
  };
  const events: RunEvent[] = [
    event(0, 0, { type: "run.started", input }),
    event(1, 0, { type: "turn.started", turnId, attempt: 1, exchangeId, input: turnInput }),
    event(2, 10, { type: "exchange.requested", turnId, attempt: 1, exchangeId, request: { url: `${input.target.endpoint}/chat/completions`, method: "POST", headers: {} } }),
    event(3, Math.max(20, durationMs - 20), { type: "assistant.text_delta", turnId, attempt: 1, exchangeId, text: output }),
    ...(usage ? [event(4, durationMs - 5, { type: "usage.reported", turnId, attempt: 1, exchangeId, usage })] : []),
    event(usage ? 5 : 4, durationMs - 1, { type: "assistant.completed", turnId, attempt: 1, exchangeId, finishReason: { normalized: "stop" } }),
    event(usage ? 6 : 5, durationMs, { type: "run.completed" }),
  ];
  return createRunTrace(events.reduce(reduceRunEvent, createRunState(cell.runId)));
}

function bakeoffFixture() {
  const initial = createProjectFile({
    name: "Configuration results fixture",
    idSuffix: "configuration-results",
    createdAt: "2026-08-06T12:00:00.000Z",
    request: { provider: "openai-compatible", endpoint: "https://provider.example.test/v1", model: "base-model", messages: [{ role: "user", content: "Explain migrations." }] },
  });
  const variants = [
    { id: "evaluation-variant_fast", name: "Fast", overrides: { target: { model: "fast-model" } } },
    { id: "evaluation-variant_balanced", name: "Balanced", overrides: { target: { model: "balanced-model" } } },
    { id: "evaluation-variant_careful", name: "Careful", overrides: { target: { model: "careful-model" } } },
  ];
  const project = parseProjectFile({
    ...initial,
    evaluationSuites: [{
      id: "evaluation-suite_bakeoff", name: "Configuration bakeoff",
      input: { kind: "conversation-revision", conversationRevisionId: initial.defaults.conversationRevisionId },
      execution: { target: initial.defaults.target, responseMode: "buffered", options: {}, repetitions: 1, toolIds: [] },
      variants,
      inputBindings: [],
      cases: [{ id: "evaluation-case_migrations", name: "Migrations", values: {}, checks: [{ checkId: "check_migration", kind: "contains", value: "migration" }] }],
    }],
  });
  let suffix = 0;
  const plan = createEvaluationExperimentPlan({
    project,
    suiteId: "evaluation-suite_bakeoff",
    selectedCaseIds: ["evaluation-case_migrations"],
    selectedVariantIds: variants.map(({ id }) => id as `evaluation-variant_${string}`),
    createdAt: "2026-08-06T12:10:00.000Z",
    createSuffix: () => `configuration-results-${++suffix}`,
    runtimeTargets: Object.fromEntries(variants.map((variant) => [variant.id, {
      profileId: `profile_${variant.name.toLowerCase()}`,
      protocol: "openai-compatible-chat-completions" as const,
      endpoint: `https://${variant.name.toLowerCase()}.example.test/v1`,
      capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
    }])),
  });
  const outputs = [
    "Fast migration output.",
    "Balanced migration output with rollback.",
    "Careful migration output with backup and rollback.",
  ];
  const durations = [120, 240, 360];
  const usage = [
    { inputTokens: 4, outputTokens: 7, totalTokens: 11 },
    { inputTokens: 8, outputTokens: 14, totalTokens: 22 },
    undefined,
  ];
  const traces = plan.cells.map((cell, index) => {
    const trace = completedTrace(plan, cell, outputs[index]!, durations[index]!, usage[index]);
    return { fileName: `${cell.runId}.json`, contents: serializeRunTrace(trace) };
  });
  const result = {
    schemaVersion: 4 as const,
    experimentId: plan.experimentId,
    status: "completed" as const,
    endedAt: "2026-08-06T12:11:00.000Z",
    cells: plan.cells.map((cell) => ({ cellId: cell.cellId, runId: cell.runId, status: "completed" as const })),
  };
  return {
    files: {
      "project.json": serializeProjectFile(project),
      [`experiments/${plan.experimentId}.plan.json`]: serializeExperimentPlan(plan),
      [`experiments/${plan.experimentId}.result.json`]: serializeExperimentResult(result, plan),
      ...Object.fromEntries(traces.map(({ fileName, contents }) => [`traces/${fileName}`, contents])),
    },
  };
}

async function openResults(page: Page): Promise<void> {
  await seedProfile(page);
  await stubProjectDirectory(page, { name: "configuration-results-fixture", files: bakeoffFixture().files, directories: [] });
  await page.goto("/");
  await waitForHydration(page);
  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "Open project…" }).click();
  await expect(page.getByText(/Inspect every model run · Configuration results fixture/)).toBeVisible();
  await openMode(page, "Evaluations");
  const history = page.locator(".evaluation-suite-history");
  await history.getByText("Past executions").click();
  await history.locator(".evaluation-suite-history-item").click();
  await expect(page.getByRole("region", { name: "Evaluation results" })).toBeVisible();
}

test("configuration results expose exact metrics, trace evidence, and selectable output differences", async ({ page }) => {
  await openResults(page);
  const workspace = page.getByRole("region", { name: "Evaluation results" });
  const table = workspace.getByRole("table", { name: "Configuration results" });
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(table.locator("tbody tr").nth(0)).toContainText("Fast");
  await expect(table.locator("tbody tr").nth(0)).toContainText("120ms median · 120ms–120ms");
  await expect(table.locator("tbody tr").nth(0)).toContainText("11 tokens");
  await expect(table.locator("tbody tr").nth(0)).toContainText("1/1 runs reported");
  await expect(table.locator("tbody tr").nth(1)).toContainText("240ms median · 240ms–240ms");
  await expect(table.locator("tbody tr").nth(1)).toContainText("22 tokens");
  await expect(table.locator("tbody tr").nth(2)).toContainText("360ms median · 360ms–360ms");
  await expect(table.locator("tbody tr").nth(2)).toContainText("0/1 runs reported");
  await expect(workspace.getByRole("button", { name: "Open Response & Inspect" })).toHaveCount(1);

  await table.getByRole("button", { name: /Careful/ }).click();
  await expect(workspace.getByRole("button", { name: "Open Response & Inspect" })).toHaveCount(1);
  await workspace.getByRole("button", { name: "Compare output…" }).click();
  const drawer = page.getByRole("dialog", { name: "Compare output" });
  const selectors = drawer.locator("select");
  await expect(selectors.nth(0)).toHaveValue("evaluation-variant_careful");
  await expect(selectors.nth(1)).toHaveValue("evaluation-variant_fast");
  await expect(drawer).toContainText("Careful migration output with backup and rollback.");
  await expect(drawer).toContainText("Fast migration output.");
  await selectors.nth(1).selectOption("evaluation-variant_balanced");
  await expect(drawer.getByRole("region", { name: "right configuration" })).toContainText("Balanced");
  await expect(drawer).toContainText("Balanced migration output with rollback.");
  await expect(workspace).not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);
});

test("settled results remain reachable at full and narrow widths", async ({ page }) => {
  await openResults(page);
  const workspace = page.getByRole("region", { name: "Evaluation results" });
  await expect(workspace.getByRole("table", { name: "Configuration results" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(workspace.getByRole("table", { name: "Configuration results" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const scroll = workspace.locator(".evaluation-configuration-table-scroll");
  const box = await scroll.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await expect(workspace).not.toContainText(/NaN|Infinity|undefined|\[object Object\]/);
});
