import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPERIMENT_SCHEMA_VERSION,
  experimentExposedTools,
  materializeParsedDecisionCellInput,
  parseExperimentPlanFile,
  parseExperimentPlanJson,
  sequentialExperimentConcurrency,
  serializeExperimentPlan,
} from "../packages/core/src/experiment.ts";
import type { DecisionEvaluationExperimentPlan } from "../packages/core/src/experiment.ts";
import { EvaluationSetupError, createEvaluationExperimentPlan } from "../packages/core/src/evaluation-execution.ts";
import type { EvaluationVariantId } from "../packages/core/src/run-kernel/index.ts";
import {
  check,
  decision,
  decisionPlan,
  decisionProject,
  decisionRuntimeTarget,
} from "./fixtures/decision-evaluation.ts";

const project = decisionProject;
const runtimeTarget = decisionRuntimeTarget;
const plan = decisionPlan;

test("plan schema is Version 5", () => {
  assert.equal(EXPERIMENT_SCHEMA_VERSION, 5);
  assert.equal(plan().schemaVersion, 5);
});

test("a decision plan freezes each case's resolved request, with case values over the revision's", () => {
  const built = plan();
  assert.equal(built.kind, "decision-evaluation");
  assert.equal(built.checkSchemaVersion, 5);
  assert.equal(built.repetitions, 2);
  assert.equal("turnCeiling" in built, false);
  assert.equal("tools" in built.suite, false);
  assert.equal(built.suite.decisionRequestRevisionId, "decision-revision_one");
  const [refund, crash] = built.suite.cases;
  assert.deepEqual(refund!.input, {
    decisionRequestId: "decision-request_one",
    decisionRequestRevisionId: "decision-revision_one",
    decision: {
      state: "Ticket: Please refund October (pro)",
      questions: {
        severity: decision.questions.severity,
        intent: { type: "choice", instructions: "Route pro", criteria: decision.questions.intent!.criteria },
        is_spam: decision.questions.is_spam,
      },
    },
    resolvedAt: "2026-10-24T13:00:00.000Z",
  });
  assert.equal((crash!.input.decision.state as string), "Ticket: The app crashes (pro)");
  assert.deepEqual(refund!.values, { "evaluation-input_ticket": "Please refund October" });
  assert.deepEqual(built.suite.inputBindings, project().evaluationSuites[0]!.inputBindings);
});

test("a decision variant snapshot is its name and resolved target, nothing more", () => {
  const [base, big] = plan().suite.variants;
  assert.deepEqual(base, {
    variantId: "evaluation-variant_base",
    name: "Default",
    target: { ...runtimeTarget("local"), model: "local-decision" },
  });
  assert.deepEqual(big!.target, { ...runtimeTarget("remote"), model: "big-decision" });
});

test("decision cells keep case, configuration, and repetition order", () => {
  assert.deepEqual(plan().cells.map(({ caseId, variantId, repetition, ordinal }) => [caseId, variantId, repetition, ordinal]), [
    ["evaluation-case_refund", "evaluation-variant_base", 1, 1],
    ["evaluation-case_refund", "evaluation-variant_base", 2, 2],
    ["evaluation-case_refund", "evaluation-variant_big", 1, 3],
    ["evaluation-case_refund", "evaluation-variant_big", 2, 4],
    ["evaluation-case_crash", "evaluation-variant_base", 1, 5],
    ["evaluation-case_crash", "evaluation-variant_base", 2, 6],
    ["evaluation-case_crash", "evaluation-variant_big", 1, 7],
    ["evaluation-case_crash", "evaluation-variant_big", 2, 8],
  ]);
});

test("a decision plan round-trips with its questions and options in authored order", () => {
  const built = plan();
  const serialized = serializeExperimentPlan(built);
  const reopened = parseExperimentPlanJson(serialized);
  assert.deepEqual(reopened, built);
  if (reopened.kind !== "decision-evaluation") throw new Error("expected a decision plan");
  const sent = reopened.suite.cases[0]!.input.decision;
  assert.deepEqual(Object.keys(sent.questions), ["severity", "intent", "is_spam"]);
  const intent = sent.questions.intent!;
  assert.deepEqual(Object.keys(intent.criteria as object), ["refund", "bug", "billing"]);
  // Everything outside the request keeps its deterministic order.
  assert.ok(serialized.indexOf("\"cells\"") < serialized.indexOf("\"checkSchemaVersion\""));
});

test("a decision cell materializes as the decision run input it sends", () => {
  const built = plan();
  const cell = built.cells[2]!;
  assert.deepEqual(materializeParsedDecisionCellInput(built, cell), {
    runId: cell.runId,
    resolvedAt: "2026-10-24T13:00:00.000Z",
    target: built.suite.variants[1]!.target,
    decision: built.suite.cases[0]!.input.decision,
  });
});

test("a decision plan exposes no tools and runs one connection per target", () => {
  const built = plan();
  assert.deepEqual(experimentExposedTools(built), []);
  assert.deepEqual(sequentialExperimentConcurrency(built), {
    maxInFlight: 1,
    connections: [
      { profileId: runtimeTarget("local").profileId, endpoint: runtimeTarget("local").endpoint, limit: 1 },
      { profileId: runtimeTarget("remote").profileId, endpoint: runtimeTarget("remote").endpoint, limit: 1 },
    ],
  });
});

test("a decision plan refuses chat checks, a chat target, another revision, and an older version", () => {
  const built = plan();
  const withCase = (change: Partial<DecisionEvaluationExperimentPlan["suite"]["cases"][number]>) => ({
    ...built,
    suite: { ...built.suite, cases: [{ ...built.suite.cases[0]!, ...change }, built.suite.cases[1]!] },
  });
  assert.throws(
    () => parseExperimentPlanFile(withCase({ checks: [check({ kind: "contains", value: "refund" })] })),
    /"contains" checks read a chat run/,
  );
  assert.throws(
    () => parseExperimentPlanFile(withCase({
      input: { ...built.suite.cases[0]!.input, decisionRequestRevisionId: "decision-revision_other" as never },
    })),
    /resolves a different decision request revision/,
  );
  assert.throws(
    () => parseExperimentPlanFile({
      ...built,
      suite: {
        ...built.suite,
        variants: [{ ...built.suite.variants[0]!, target: { ...built.suite.variants[0]!.target, protocol: "openai-compatible-chat-completions" } }, built.suite.variants[1]!],
      },
    }),
    /Invalid experiment plan at suite\.variants\.0\.target\.protocol/,
  );
  assert.throws(
    () => parseExperimentPlanFile(withCase({ input: { ...built.suite.cases[0]!.input, decision: { state: "x", questions: {} } } })),
    /Invalid experiment plan at suite\.cases\.0\.input\.decision/,
  );
  assert.throws(() => parseExperimentPlanFile({ ...built, checkSchemaVersion: 4 }), /Invalid experiment plan/);
  assert.throws(() => parseExperimentPlanFile({ ...built, schemaVersion: 4 }), /Invalid experiment plan/);
  assert.throws(() => parseExperimentPlanFile({ ...built, schemaVersion: 6 }), /Version 6 is unsupported/);
});

test("building a decision plan needs a resolved local connection for every configuration", () => {
  assert.throws(
    () => plan({ runtimeTargets: { ["evaluation-variant_base" as EvaluationVariantId]: runtimeTarget("local") } }),
    (error: unknown) => error instanceof EvaluationSetupError && /“Big” does not have a resolved local connection/.test(error.message),
  );
});

test("building a decision plan reports preflight diagnostics", () => {
  const source = project();
  const revision = source.decisionRequestRevisions[0]!;
  assert.throws(
    () => plan({ project: { ...source, decisionRequestRevisions: [{ ...revision, values: { ticket: "x" } }] } }),
    (error: unknown) => error instanceof EvaluationSetupError &&
      error.diagnostics.some(({ code }) => code === "unresolved-template-variable"),
  );
});

test("a chat suite cannot be built as a decision plan, nor a decision suite as a chat plan", () => {
  assert.throws(
    () => createEvaluationExperimentPlan({
      project: project(),
      suiteId: "evaluation-suite_routing",
      selectedCaseIds: ["evaluation-case_refund"],
    }),
    (error: unknown) => error instanceof EvaluationSetupError && error.diagnostics[0]?.code === "unsupported-suite-kind",
  );
  const chat = project();
  const chatSuite = {
    id: "evaluation-suite_chat" as const,
    name: "Chat",
    input: { kind: "conversation-revision" as const, conversationRevisionId: chat.defaults.conversationRevisionId },
    execution: { target: chat.defaults.target, responseMode: "buffered" as const, options: {}, repetitions: 1, toolIds: [] },
    variants: [{ id: "evaluation-variant_base" as const, name: "Default", overrides: {} }],
    inputBindings: [],
    cases: [],
  };
  assert.throws(
    () => plan({ project: { ...chat, evaluationSuites: [chatSuite] }, suiteId: "evaluation-suite_chat" }),
    (error: unknown) => error instanceof EvaluationSetupError && error.diagnostics[0]?.code === "unsupported-suite-kind",
  );
});
