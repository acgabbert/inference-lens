import assert from "node:assert/strict";
import test from "node:test";

import {
  authoredCheckDefinitionSchema,
  CHECK_SCHEMA_VERSION,
  evaluateCheck,
  parseCheckDefinition,
  type CheckDefinition,
  type CheckOutcome,
} from "../packages/core/src/checks.ts";
import {
  EvaluationAssessmentError,
  parseEvaluationAssessmentJson,
  serializeEvaluationAssessment,
  type EvaluationAssessmentV1,
} from "../packages/core/src/evaluation-assessment.ts";
import { createEvaluationExperimentPlan, EvaluationSetupError } from "../packages/core/src/evaluation-execution.ts";
import { evaluationSuitePreflight } from "../packages/core/src/evaluation-suites.ts";
import { defaultCheck } from "../packages/core/src/evaluation-suite-authoring.ts";
import { parseExperimentPlanJson, serializeExperimentPlan, type EvaluationExperimentPlanV4 } from "../packages/core/src/experiment.ts";
import { MAX_SCHEMA_OUTPUT_CODE_UNITS } from "../packages/core/src/json-schema/limits.ts";
import { createProjectFile, parseProjectFile, PROJECT_SCHEMA_VERSION, type ProjectFile } from "../packages/core/src/project.ts";
import type { CheckId } from "../packages/core/src/run-kernel/types.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";

const checkId = "check_structured" as CheckId;
const answerSchema = {
  type: "object",
  required: ["answer", "score"],
  properties: { answer: { type: "string" }, score: { type: "number", minimum: 0, maximum: 1 } },
};

function schemaCheck(extra: Record<string, unknown> = {}): CheckDefinition {
  return parseCheckDefinition({ checkId, kind: "json-schema", dialect: "draft-07", schema: answerSchema, ...extra });
}

function run(definition: CheckDefinition, output: string): CheckOutcome {
  return evaluateCheck(definition, { output, toolCalls: [] });
}

test("the check vocabulary is version 4", () => {
  assert.equal(CHECK_SCHEMA_VERSION, 4);
});

test("JSON Schema checks parse as portable, non-negatable definitions", () => {
  const definition = schemaCheck({ inputPolicy: "surrounding-fence", label: "Answer shape" });
  assert.deepEqual(definition, {
    checkId, kind: "json-schema", dialect: "draft-07", schema: answerSchema,
    inputPolicy: "surrounding-fence", label: "Answer shape",
  });
  assert.equal(parseCheckDefinition({ checkId, kind: "json-schema", dialect: "draft-07", schema: true }).kind, "json-schema");
  for (const invalid of [
    { negate: true },
    { dialect: "2020-12" },
    { inputPolicy: "anywhere" },
    { topLevel: "object" },
    { schema: "not a schema" },
  ]) {
    assert.throws(() => schemaCheck(invalid), /Invalid check definition/, JSON.stringify(invalid));
  }
});

test("a runnable definition requires a supported schema, while authoring may keep an unsupported draft", () => {
  const draft = { checkId, kind: "json-schema", dialect: "draft-07", schema: { pattern: "^a" } };
  assert.throws(() => parseCheckDefinition(draft), /Pattern constraints are unsupported/);
  assert.equal(authoredCheckDefinitionSchema.safeParse(draft).success, true);
  assert.equal(authoredCheckDefinitionSchema.safeParse({ ...draft, schema: "not a schema" }).success, false);
});

test("valid-json accepts an input policy and keeps strict as the default", () => {
  const fenced = "```json\n{\"answer\":\"yes\"}\n```";
  const strict = parseCheckDefinition({ checkId, kind: "valid-json" });
  const surrounding = parseCheckDefinition({ checkId, kind: "valid-json", inputPolicy: "surrounding-fence" });
  assert.equal(run(strict, fenced).status, "failed");
  const passed = run(surrounding, fenced);
  assert.equal(passed.status, "passed");
  assert.deepEqual(passed.status === "passed" && passed.evidence, {
    valid: true, characters: fenced.length, topLevel: "object", inputPolicy: "surrounding-fence", path: "surrounding-fence",
  });
  // A strict definition's evidence is unchanged from vocabulary v3.
  assert.deepEqual(run(strict, "{}"), { status: "passed", evidence: { valid: true, characters: 2, topLevel: "object" } });
});

test("a JSON Schema check passes a conforming answer and records only measurements", () => {
  const outcome = run(schemaCheck({ inputPolicy: "first-json-fence" }), "Here:\n```json\n{\"answer\":\"secret-text\",\"score\":0.5}\n```");
  assert.equal(outcome.status, "passed");
  const evidence = JSON.stringify(outcome);
  assert.doesNotMatch(evidence, /secret-text/);
  assert.match(evidence, /"path":"first-json-fence"/);
});

test("a schema mismatch fails with a located, value-free diagnostic", () => {
  const outcome = run(schemaCheck(), JSON.stringify({ answer: 42, score: 3, "private-extra": "private-value" }));
  assert.equal(outcome.status, "failed");
  if (outcome.status !== "failed") return;
  assert.equal(outcome.message, "Schema mismatch at answer: expected string. 1 more issue.");
  const evidence = outcome.evidence as { code: string; issues: unknown[]; truncated: boolean };
  assert.equal(evidence.code, "schema-mismatch");
  assert.deepEqual(evidence.issues, [
    { keyword: "type", location: [{ property: "answer" }], expectedType: "string" },
    { keyword: "maximum", location: [{ property: "score" }] },
  ]);
  assert.equal(evidence.truncated, false);
  assert.doesNotMatch(JSON.stringify(outcome), /private-extra|private-value|42/);

  const missing = run(schemaCheck(), "{\"score\":0.5}");
  assert.equal(missing.status === "failed" && missing.message, "Schema mismatch at the root: missing required property \"answer\".");
  const extra = run(
    parseCheckDefinition({ checkId, kind: "json-schema", dialect: "draft-07", schema: { additionalProperties: false } }),
    "{\"private-key\":1}",
  );
  assert.equal(extra.status === "failed" && extra.message, "Schema mismatch at <additional property>: unexpected property.");
  assert.doesNotMatch(JSON.stringify(extra), /private-key/);
});

test("JSON Schema checks fail invalid JSON and oversized answers before validating", () => {
  const invalid = run(schemaCheck(), "```json\n{\"answer\":\"x\",\"score\":0.5}\n```");
  assert.equal(invalid.status, "failed");
  assert.equal(invalid.status === "failed" && invalid.message, "Final assistant output is not valid JSON under the strict input policy.");
  assert.equal((invalid.status === "failed" && (invalid.evidence as { code: string }).code), "invalid-json");

  const oversized = `"${"a".repeat(MAX_SCHEMA_OUTPUT_CODE_UNITS)}"`;
  const tooLarge = run(parseCheckDefinition({ checkId, kind: "json-schema", dialect: "draft-07", schema: true }), oversized);
  assert.equal(tooLarge.status, "failed");
  assert.deepEqual(tooLarge.status === "failed" && tooLarge.evidence, {
    code: "output-too-large", codeUnits: MAX_SCHEMA_OUTPUT_CODE_UNITS + 2, limit: MAX_SCHEMA_OUTPUT_CODE_UNITS,
  });
});

test("exhausting a data bound is not-evaluated, and unchecked formats are listed", () => {
  let deep: unknown = 0;
  for (let i = 0; i < 70; i++) deep = [deep];
  const exhausted = run(parseCheckDefinition({ checkId, kind: "json-schema", dialect: "draft-07", schema: true }), JSON.stringify(deep));
  assert.equal(exhausted.status, "not-evaluated");

  const formatted = run(
    parseCheckDefinition({ checkId, kind: "json-schema", dialect: "draft-07", schema: { properties: { when: { type: "string", format: "date-time" } } } }),
    "{\"when\":\"not a date\"}",
  );
  assert.equal(formatted.status, "passed");
  assert.deepEqual((formatted.status === "passed" && (formatted.evidence as { uncheckedFormats: unknown }).uncheckedFormats), [
    { format: "date-time", schemaPath: ["properties", "when", "format"] },
  ]);
});

test("a new JSON Schema check starts with an object schema and the strict policy", () => {
  const added = defaultCheck({ kind: "json-schema" }, () => "new");
  assert.deepEqual(added, { checkId: "check_new", kind: "json-schema", dialect: "draft-07", schema: { type: "object" } });
  assert.equal(parseCheckDefinition(added).kind, "json-schema");
});

function suiteProject(checks: unknown[]): ProjectFile {
  const initial = createProjectFile({
    name: "Structured fixture",
    idSuffix: "structured-fixture",
    createdAt: "2026-10-16T12:00:00.000Z",
    request: {
      provider: "openai-compatible",
      endpoint: "https://provider.example.test/v1",
      model: "authored-model",
      messages: [{ role: "user", content: "Answer as JSON." }],
    },
  });
  return parseProjectFile({
    ...initial,
    evaluationSuites: [{
      id: "evaluation-suite_topics",
      name: "Topics",
      input: { kind: "conversation-revision", conversationRevisionId: initial.defaults.conversationRevisionId },
      execution: { target: { ...initial.defaults.target }, responseMode: "buffered", options: {}, repetitions: 1, toolIds: [] },
      variants: [{ id: "evaluation-variant_default", name: "Default", overrides: {} }],
      inputBindings: [],
      cases: [{ id: "evaluation-case_migrations", name: "Migrations", values: {}, checks }],
    }],
  });
}

function planFor(project: ProjectFile): EvaluationExperimentPlanV4 {
  let suffix = 0;
  return createEvaluationExperimentPlan({
    project,
    suiteId: "evaluation-suite_topics",
    selectedCaseIds: ["evaluation-case_migrations"],
    createdAt: "2026-10-16T12:10:00.000Z",
    createSuffix: () => `structured-${++suffix}`,
    runtimeTarget: {
      profileId: "profile_confirmed",
      protocol: "openai-compatible-chat-completions",
      endpoint: "https://provider.example.test/v1",
      capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
    },
  }) as EvaluationExperimentPlanV4;
}

const schemaCheckJson = { checkId: "check_shape", kind: "json-schema", dialect: "draft-07", schema: answerSchema };
const containsCheckJson = { checkId: "check_mentions", kind: "contains", value: "migration" };

test("suite preflight reports an unsupported schema before plan creation", () => {
  const project = suiteProject([{ ...schemaCheckJson, schema: { type: "string", pattern: "^a" } }]);
  const diagnostics = evaluationSuitePreflight(project, "evaluation-suite_topics", project.defaults.conversationRevisionId);
  assert.deepEqual(diagnostics.map(({ code }) => code), ["unsupported-schema"]);
  assert.match(diagnostics[0].message, /Migrations.*Pattern constraints are unsupported/);
  assert.throws(() => planFor(project), (error: unknown) => error instanceof EvaluationSetupError);
});

test("new plans record vocabulary 4, and a vocabulary 3 plan rejects v4 constructs instead of reinterpreting them", () => {
  const plan = planFor(suiteProject([schemaCheckJson]));
  assert.equal(plan.checkSchemaVersion, 4);
  const written = JSON.parse(serializeExperimentPlan(plan));
  assert.equal(parseExperimentPlanJson(JSON.stringify(written)).experimentId, plan.experimentId);

  assert.throws(() => parseExperimentPlanJson(JSON.stringify({ ...written, checkSchemaVersion: 3 })), /check vocabulary version 4/);
  const policy = planFor(suiteProject([{ checkId: "check_json", kind: "valid-json", inputPolicy: "first-json-fence" }]));
  assert.throws(
    () => parseExperimentPlanJson(JSON.stringify({ ...JSON.parse(serializeExperimentPlan(policy)), checkSchemaVersion: 3 })),
    /check vocabulary version 4/,
  );

  // A plan written by a v3 build keeps opening, with unchanged meaning.
  const legacy = JSON.parse(serializeExperimentPlan(planFor(suiteProject([containsCheckJson]))));
  assert.equal((parseExperimentPlanJson(JSON.stringify({ ...legacy, checkSchemaVersion: 3 })) as EvaluationExperimentPlanV4).checkSchemaVersion, 3);
  assert.throws(() => parseExperimentPlanJson(JSON.stringify({ ...legacy, checkSchemaVersion: 2 })));
});

test("assessments accept vocabularies 3 and 4 and gate v4 constructs the same way", () => {
  const plan = planFor(suiteProject([containsCheckJson]));
  const assessment: EvaluationAssessmentV1 = {
    schemaVersion: 1,
    assessmentId: "evaluation-assessment_shape",
    experimentId: plan.experimentId,
    name: "Shape",
    createdAt: "2026-10-16T13:00:00.000Z",
    checkSchemaVersion: CHECK_SCHEMA_VERSION,
    scoringPolicy: "strict",
    cases: [{ caseId: "evaluation-case_migrations", checks: [parseCheckDefinition({ ...schemaCheckJson, checkId: "check_mentions" })] }],
  };
  const written = JSON.parse(serializeEvaluationAssessment(assessment, plan));
  assert.equal(parseEvaluationAssessmentJson(JSON.stringify(written), plan).checkSchemaVersion, 4);
  assert.throws(
    () => parseEvaluationAssessmentJson(JSON.stringify({ ...written, checkSchemaVersion: 3 }), plan),
    (error: unknown) => error instanceof EvaluationAssessmentError && /check vocabulary version 4/.test(error.message),
  );
  const legacy = { ...written, checkSchemaVersion: 3, cases: [{ caseId: "evaluation-case_migrations", checks: [containsCheckJson] }] };
  assert.equal(parseEvaluationAssessmentJson(JSON.stringify(legacy), plan).checkSchemaVersion, 3);
  assert.throws(() => parseEvaluationAssessmentJson(JSON.stringify({ ...legacy, checkSchemaVersion: 2 }), plan), EvaluationAssessmentError);
});

test("projects move to v12; a v11 project opens unless it carries a v4 construct", () => {
  assert.equal(PROJECT_SCHEMA_VERSION, 12);
  const current = suiteProject([schemaCheckJson]);
  assert.equal(current.schemaVersion, 12);

  const v11 = { ...suiteProject([containsCheckJson]), schemaVersion: 11 };
  assert.equal(parseProjectFile(v11).schemaVersion, 12);
  assert.throws(() => parseProjectFile({ ...current, schemaVersion: 11 }), /check vocabulary version 4/);
  const policy = suiteProject([{ checkId: "check_json", kind: "valid-json", inputPolicy: "surrounding-fence" }]);
  assert.throws(() => parseProjectFile({ ...policy, schemaVersion: 11 }), /check vocabulary version 4/);
});
