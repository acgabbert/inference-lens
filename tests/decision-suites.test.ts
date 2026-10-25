import assert from "node:assert/strict";
import test from "node:test";

import type { CheckDefinition } from "../packages/core/src/checks.ts";
import type { DecisionInput } from "../packages/core/src/decision.ts";
import { updateDecisionRequestDraft } from "../packages/core/src/decision-request.ts";
import { evaluationSuitePreflight } from "../packages/core/src/evaluation-suites.ts";
import type { DecisionEvaluationSuite } from "../packages/core/src/evaluation-suites.ts";
import {
  PROJECT_SCHEMA_VERSION,
  createProjectFile,
  parseProjectFile,
  parseProjectJson,
  serializeProjectFile,
} from "../packages/core/src/project.ts";
import type { ProjectFile } from "../packages/core/src/project.ts";
import { resolveProviderCapabilities } from "../packages/core/src/types.ts";

const request = {
  provider: "openai-compatible" as const,
  endpoint: "http://127.0.0.1:44028/v1",
  model: "chat-model",
  messages: [{ role: "user" as const, content: "Hello" }],
  capabilities: resolveProviderCapabilities("openai-compatible"),
};

const decision: DecisionInput = {
  state: "Ticket: {{ticket}} ({{plan}})",
  questions: {
    intent: { type: "choice", instructions: "Route it", criteria: { billing: "Money", bug: "Broken" } },
    severity: { type: "score", instructions: "How urgent?", criteria: ["minor", "major", "critical"] },
    is_spam: { type: "noul", instructions: "Spam?" },
  },
};

function withRequest(): ProjectFile {
  const base = createProjectFile({ name: "Decisions", request, idSuffix: "d", createdAt: "2026-10-24T12:00:00.000Z" });
  return updateDecisionRequestDraft(base, {
    decision,
    values: { ticket: "Charged twice", plan: "pro" },
    branch: false,
    idSuffix: "one",
    createdAt: "2026-10-24T12:01:00.000Z",
  });
}

function check(definition: Record<string, unknown>, id = "c1"): CheckDefinition {
  return { checkId: `check_${id}`, ...definition } as CheckDefinition;
}

function decisionSuite(project: ProjectFile, overrides: Partial<DecisionEvaluationSuite> = {}): DecisionEvaluationSuite {
  return {
    id: "evaluation-suite_routing",
    name: "Routing",
    input: { kind: "decision-request-revision", decisionRequestRevisionId: "decision-revision_one" },
    execution: {
      target: {
        connectionRequirementId: project.defaults.target.connectionRequirementId,
        model: "local-decision",
        protocol: "systemone",
      },
      repetitions: 2,
    },
    variants: [{ id: "evaluation-variant_base", name: "Default", overrides: {} }],
    inputBindings: [{ id: "evaluation-input_ticket", name: "ticket", target: { kind: "decision-variable", variableName: "ticket" } }],
    cases: [{
      id: "evaluation-case_refund",
      name: "Refund",
      values: { "evaluation-input_ticket": "Please refund October" },
      checks: [check({ kind: "decision-choice", questionId: "intent", option: "billing" })],
    }],
    ...overrides,
  };
}

function withSuite(overrides: Partial<DecisionEvaluationSuite> = {}): ProjectFile {
  const project = withRequest();
  return { ...project, evaluationSuites: [decisionSuite(project, overrides)] };
}

function preflight(project: ProjectFile) {
  const suite = project.evaluationSuites[0]!;
  return evaluationSuitePreflight(project, suite.id, project.defaults.conversationRevisionId);
}

test("project schema is v14, and a v13 document opens unchanged", () => {
  assert.equal(PROJECT_SCHEMA_VERSION, 14);
  const v13 = { ...withRequest(), schemaVersion: 13 };
  const opened = parseProjectFile(v13);
  assert.equal(opened.schemaVersion, 14);
  assert.deepEqual(opened.decisionRequestRevisions, withRequest().decisionRequestRevisions);
});

test("a v13 document cannot carry a decision suite or a decision check", () => {
  assert.throws(() => parseProjectFile({ ...withSuite(), schemaVersion: 13 }), /Decision suites require project schema v14/);
  // A decision check smuggled into a v13 chat suite is vocabulary 5, which v13 never had.
  const chat = withRequest();
  const v13 = {
    ...chat,
    schemaVersion: 13,
    evaluationSuites: [{
      id: "evaluation-suite_chat",
      name: "Chat",
      input: { kind: "conversation-revision", conversationRevisionId: chat.defaults.conversationRevisionId },
      execution: { target: chat.defaults.target, responseMode: "buffered", options: {}, repetitions: 1, toolIds: [] },
      variants: [{ id: "evaluation-variant_base", name: "Default", overrides: {} }],
      inputBindings: [],
      cases: [{ id: "evaluation-case_one", name: "One", values: {}, checks: [check({ kind: "decision-noul", questionId: "is_spam", comparator: "at-most", value: 0.5 })] }],
    }],
  };
  assert.throws(() => parseProjectFile(v13), /requires check vocabulary version 5/);
});

test("a decision suite saves and reopens as authored", () => {
  const project = withSuite();
  const reopened = parseProjectJson(serializeProjectFile(project));
  assert.deepEqual(reopened.evaluationSuites, project.evaluationSuites);
});

test("a decision suite must name a known revision and connection", () => {
  assert.throws(
    () => parseProjectFile(withSuite({ input: { kind: "decision-request-revision", decisionRequestRevisionId: "decision-revision_gone" } })),
    /unknown decision request revision/,
  );
  const project = withRequest();
  assert.throws(
    () => parseProjectFile({ ...project, evaluationSuites: [decisionSuite(project, {
      execution: { target: { connectionRequirementId: "connection_gone", model: "m", protocol: "systemone" }, repetitions: 1 },
    })] }),
    /unknown connection requirement/,
  );
});

test("a decision suite holds only decision-shaped execution, bindings, and configurations", () => {
  const project = withRequest();
  const suite = decisionSuite(project);
  const invalid: unknown[] = [
    { ...suite, execution: { ...suite.execution, responseMode: "buffered" } },
    { ...suite, execution: { ...suite.execution, target: { ...suite.execution.target, protocol: "openai-compatible-chat-completions" } } },
    { ...suite, variants: [{ id: "evaluation-variant_base", name: "Default", overrides: { responseMode: "buffered" } }] },
    { ...suite, inputBindings: [{ id: "evaluation-input_ticket", name: "ticket", target: { kind: "template-variable", templateUseId: "template-use_x", variableName: "ticket" } }] },
  ];
  for (const candidate of invalid) {
    assert.throws(() => parseProjectFile({ ...project, evaluationSuites: [candidate] }), /Invalid Inference Lens project/);
  }
});

test("a decision binding never names a secret-like variable", () => {
  assert.throws(
    () => parseProjectFile(withSuite({
      inputBindings: [{ id: "evaluation-input_ticket", name: "key", target: { kind: "decision-variable", variableName: "api_key" } }],
      cases: [{ id: "evaluation-case_refund", name: "Refund", values: { "evaluation-input_ticket": "x" }, checks: [check({ kind: "max-duration-ms", limit: 1 })] }],
    })),
    /Secret-like/,
  );
});

test("each suite kind refuses the other kind's checks; shared kinds fit both", () => {
  assert.throws(
    () => parseProjectFile(withSuite({
      cases: [{ id: "evaluation-case_refund", name: "Refund", values: { "evaluation-input_ticket": "x" }, checks: [check({ kind: "contains", value: "billing" })] }],
    })),
    /"contains" checks read a chat run/,
  );
  const shared = withSuite({
    cases: [{ id: "evaluation-case_refund", name: "Refund", values: { "evaluation-input_ticket": "x" }, checks: [check({ kind: "max-duration-ms", limit: 5000 }), check({ kind: "max-total-tokens", limit: 500 }, "c2")] }],
  });
  assert.equal(parseProjectFile(shared).evaluationSuites.length, 1);

  const chat = parseProjectFile(withRequest());
  const chatSuite = {
    id: "evaluation-suite_chat",
    name: "Chat",
    input: { kind: "conversation-revision", conversationRevisionId: chat.defaults.conversationRevisionId },
    execution: { target: chat.defaults.target, responseMode: "buffered", options: {}, repetitions: 1, toolIds: [] },
    variants: [{ id: "evaluation-variant_base", name: "Default", overrides: {} }],
    inputBindings: [],
    cases: [{ id: "evaluation-case_one", name: "One", values: {}, checks: [check({ kind: "decision-confidence", questionId: "intent", atLeast: 0.5 })] }],
  };
  assert.throws(() => parseProjectFile({ ...chat, evaluationSuites: [chatSuite] }), /"decision-confidence" checks read a decision run/);
});

test("a ready decision suite has no preflight diagnostics", () => {
  assert.deepEqual(preflight(withSuite()), []);
});

test("preflight names a check's missing question, wrong question type, and unknown option", () => {
  const checks = [
    check({ kind: "decision-choice", questionId: "", option: "" }, "empty"),
    check({ kind: "decision-choice", questionId: "routing", option: "billing" }, "gone"),
    check({ kind: "decision-score-range", questionId: "intent", min: 1 }, "type"),
    check({ kind: "decision-confidence", questionId: "is_spam", atLeast: 0.5 }, "noconf"),
    check({ kind: "decision-choice", questionId: "intent", option: "refund" }, "option"),
    check({ kind: "decision-option-probability", questionId: "severity", option: "3", comparator: "at-least", value: 0.1 }, "level"),
    check({ kind: "decision-option-probability", questionId: "severity", option: "2", comparator: "at-least", value: 0.1 }, "ok"),
  ];
  const diagnostics = preflight(withSuite({
    cases: [{ id: "evaluation-case_refund", name: "Refund", values: { "evaluation-input_ticket": "x" }, checks }],
  }));
  assert.deepEqual(diagnostics.map((diagnostic) => [diagnostic.code, "checkId" in diagnostic ? diagnostic.checkId : undefined]), [
    ["missing-decision-question", "check_empty"],
    ["missing-decision-question", "check_gone"],
    ["wrong-question-type", "check_type"],
    ["wrong-question-type", "check_noconf"],
    ["unknown-decision-option", "check_option"],
    ["unknown-decision-option", "check_level"],
  ]);
  assert.match(diagnostics[2]!.message, /score range check on case "Refund" needs a score question; "intent" is a choice question/);
});

test("a case value overrides the revision's value, and a variable left without one blocks the run", () => {
  // `plan` is unbound and keeps the revision's value; `ticket` is bound and overridden.
  assert.deepEqual(preflight(withSuite()), []);

  const project = withRequest();
  const revision = project.decisionRequestRevisions[0]!;
  const withoutPlan: ProjectFile = {
    ...project,
    decisionRequestRevisions: [{ ...revision, values: { ticket: "Charged twice" } }],
  };
  const diagnostics = preflight({ ...withoutPlan, evaluationSuites: [decisionSuite(withoutPlan)] });
  assert.deepEqual(diagnostics.map(({ code }) => code), ["unresolved-template-variable"]);
  assert.match(diagnostics[0]!.message, /Case "Refund" cannot resolve template variable "plan"/);
});

test("preflight names a malformed token in the pinned revision with the same guidance Compose gives", () => {
  const project = withRequest();
  const revision = project.decisionRequestRevisions[0]!;
  const malformed: ProjectFile = {
    ...project,
    decisionRequestRevisions: [{ ...revision, decision: { ...decision, state: "Ticket: {{ticket}} {{ not valid }}" }, values: { ticket: "Charged twice" } }],
  };
  const diagnostics = preflight({ ...malformed, evaluationSuites: [decisionSuite(malformed)] });
  assert.deepEqual(diagnostics.map(({ code }) => code), ["invalid-decision-template"]);
  assert.match(diagnostics[0]!.message, /^The pinned decision request cannot be rendered: .+ Write \\\{\{ for literal braces\.$/);
});

test("preflight reports a binding the pinned revision does not use, an empty case value, and a case without checks", () => {
  const diagnostics = preflight(withSuite({
    inputBindings: [
      { id: "evaluation-input_ticket", name: "ticket", target: { kind: "decision-variable", variableName: "ticket" } },
      { id: "evaluation-input_region", name: "region", target: { kind: "decision-variable", variableName: "region" } },
    ],
    cases: [{ id: "evaluation-case_refund", name: "Refund", values: { "evaluation-input_ticket": " ", "evaluation-input_region": "eu" }, checks: [] }],
  }));
  assert.deepEqual(diagnostics.map(({ code }) => code), ["no-checks", "empty-case-value", "missing-decision-variable"]);
});
