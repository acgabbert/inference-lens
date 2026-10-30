import type { CheckDefinition } from "../../packages/core/src/checks.ts";
import type {
  DecisionAnswer,
  DecisionInput,
  DecisionRun,
  ResolvedDecisionRunInput,
  ResolvedDecisionTarget,
} from "../../packages/core/src/decision.ts";
import { updateDecisionRequestDraft } from "../../packages/core/src/decision-request.ts";
import { createDecisionEvaluationExperimentPlan } from "../../packages/core/src/evaluation-execution.ts";
import type { DecisionEvaluationExperimentPlan } from "../../packages/core/src/experiment.ts";
import type { DecisionEvaluationSuite } from "../../packages/core/src/evaluation-suites.ts";
import { createProjectFile } from "../../packages/core/src/project.ts";
import type { ProjectFile } from "../../packages/core/src/project.ts";
import { createEntityId } from "../../packages/core/src/run-kernel/index.ts";
import type { EvaluationVariantId, RunError, RunTokenUsage } from "../../packages/core/src/run-kernel/index.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES, resolveProviderCapabilities } from "../../packages/core/src/types.ts";

/**
 * A project holding one decision request and a two-case, two-configuration
 * decision suite, for the D47–D50 plan, scoring, and execution tests.
 */

const request = {
  provider: "openai-compatible" as const,
  endpoint: "http://127.0.0.1:24028/v1",
  model: "chat-model",
  messages: [{ role: "user" as const, content: "Hello" }],
  capabilities: resolveProviderCapabilities("openai-compatible"),
};

// Question and option order are deliberately not alphabetical, so a writer
// that sorted them would be caught.
export const decision: DecisionInput = {
  state: "Ticket: {{ticket}} ({{plan}})",
  questions: {
    severity: { type: "score", instructions: "How urgent?", criteria: ["minor", "major", "critical"] },
    intent: { type: "choice", instructions: "Route {{plan}}", criteria: { refund: "Money back", bug: "Broken", billing: "Money" } },
    is_spam: { type: "noul", instructions: "Spam?" },
  },
};

export function check(definition: Record<string, unknown>, id = "c1"): CheckDefinition {
  return { checkId: `check_${id}`, ...definition } as CheckDefinition;
}

export function decisionProject(): ProjectFile {
  const base = createProjectFile({ name: "Decisions", request, idSuffix: "d", createdAt: "2026-10-24T12:00:00.000Z" });
  const withRequest = updateDecisionRequestDraft(base, {
    decision,
    values: { ticket: "Charged twice", plan: "pro" },
    branch: false,
    idSuffix: "one",
    createdAt: "2026-10-24T12:01:00.000Z",
  });
  const suite: DecisionEvaluationSuite = {
    id: "evaluation-suite_routing",
    name: "Routing",
    input: { kind: "decision-request-revision", decisionRequestRevisionId: "decision-revision_one" },
    execution: {
      target: {
        connectionRequirementId: withRequest.defaults.target.connectionRequirementId,
        model: "local-decision",
        protocol: "systemone",
      },
      repetitions: 2,
    },
    variants: [
      { id: "evaluation-variant_base", name: "Default", overrides: {} },
      { id: "evaluation-variant_big", name: "Big", overrides: { target: { model: "big-decision" } } },
    ],
    inputBindings: [{ id: "evaluation-input_ticket", name: "ticket", target: { kind: "decision-variable", variableName: "ticket" } }],
    cases: [
      {
        id: "evaluation-case_refund",
        name: "Refund",
        values: { "evaluation-input_ticket": "Please refund October" },
        checks: [check({ kind: "decision-choice", questionId: "intent", option: "refund" })],
      },
      {
        id: "evaluation-case_crash",
        name: "Crash",
        values: { "evaluation-input_ticket": "The app crashes" },
        checks: [check({ kind: "decision-score-range", questionId: "severity", min: 1 }), check({ kind: "max-duration-ms", limit: 5000 }, "c2")],
      },
    ],
  };
  return { ...withRequest, evaluationSuites: [suite] };
}

export function decisionRuntimeTarget(suffix: string): Omit<ResolvedDecisionTarget, "model"> {
  return {
    profileId: createEntityId("profile", suffix),
    protocol: "systemone",
    endpoint: `http://127.0.0.1:2403${suffix.length}/v1`,
    capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
  };
}

export function decisionPlan(
  overrides: Partial<Parameters<typeof createDecisionEvaluationExperimentPlan>[0]> = {},
): DecisionEvaluationExperimentPlan {
  let counter = 0;
  return createDecisionEvaluationExperimentPlan({
    project: decisionProject(),
    suiteId: "evaluation-suite_routing",
    selectedCaseIds: ["evaluation-case_refund", "evaluation-case_crash"],
    runtimeTargets: {
      ["evaluation-variant_base" as EvaluationVariantId]: decisionRuntimeTarget("local"),
      ["evaluation-variant_big" as EvaluationVariantId]: decisionRuntimeTarget("remote"),
    },
    createdAt: "2026-10-24T13:00:00.000Z",
    createSuffix: () => `s${++counter}`,
    ...overrides,
  });
}

/** Answers for the fixture's three questions, routing to `choice` at `severity`. */
export function decisionAnswers(choice: string, severity: number): Record<string, DecisionAnswer> {
  return {
    severity: { type: "score", score: severity, probabilities: { 0: 0.2, 1: 0.5, 2: 0.3 }, confidence: 0.6 },
    intent: { type: "choice", choice, probabilities: { refund: 0.1, bug: 0.1, billing: 0.1, [choice]: 0.8 }, confidence: 0.7 },
    is_spam: { type: "noul", noul: 0.05 },
  };
}

function at(ms: number): string {
  return new Date(Date.UTC(2026, 9, 24, 13, 0, 0) + ms).toISOString();
}

export const RATE_LIMITED: RunError = {
  code: "provider_error",
  message: "Too many requests.",
  retryable: true,
  providerStatus: 429,
};

export interface FinishedRunOptions {
  /** Attempts that failed before the last, oldest first. */
  failedFirst?: RunError[];
  /** How the last attempt ended. */
  last:
    | { kind: "completed"; answers: Record<string, DecisionAnswer>; usage?: RunTokenUsage }
    | { kind: "failed"; error: RunError }
    | { kind: "cancelled" };
  durationMs?: number;
}

/** A finished decision run, built directly in the shape the run transitions leave. */
export function finishedDecisionRun(input: ResolvedDecisionRunInput, options: FinishedRunOptions): DecisionRun {
  const endedAt = at(options.durationMs ?? 1_000);
  const exchange = (attempt: number) => createEntityId("exchange", `${input.runId.slice("run_".length)}-${attempt}`);
  const failed = (options.failedFirst ?? []).map((error, index) => ({
    attempt: index + 1,
    exchangeId: exchange(index + 1),
    status: "failed" as const,
    error,
  }));
  const number = failed.length + 1;
  const { last } = options;
  const lastAttempt = last.kind === "completed"
    ? { attempt: number, exchangeId: exchange(number), status: "completed" as const, result: { answers: last.answers, ...(last.usage ? { usage: last.usage } : {}) } }
    : last.kind === "failed"
      ? { attempt: number, exchangeId: exchange(number), status: "failed" as const, error: last.error }
      : { attempt: number, exchangeId: exchange(number), status: "cancelled" as const };
  const attempts = [...failed, lastAttempt];
  return {
    kind: "decision",
    runId: input.runId,
    input,
    status: last.kind === "completed"
      ? { kind: "completed", completedAt: endedAt }
      : last.kind === "failed"
        ? { kind: "failed", failedAt: endedAt, error: last.error }
        : { kind: "cancelled", cancelledAt: endedAt },
    attempts,
    exchanges: Object.fromEntries(attempts.map(({ attempt, exchangeId }) => [exchangeId, { exchangeId, attempt, frames: [] }])),
    startedAt: at(0),
    endedAt,
  };
}
