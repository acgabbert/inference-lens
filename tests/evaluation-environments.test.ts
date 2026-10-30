import assert from "node:assert/strict";
import test from "node:test";

import { createRepeatedExperimentPlan } from "../packages/runner/src/repeated-start.ts";
import type { ProjectEnvironment } from "../packages/core/src/environment.ts";
import { createEvaluationExperimentPlan, EvaluationSetupError } from "../packages/core/src/evaluation-execution.ts";
import { evaluationSuitePreflight } from "../packages/core/src/evaluation-suites.ts";
import type { ChatEvaluationSuite } from "../packages/core/src/evaluation-suites.ts";
import {
  EXPERIMENT_SCHEMA_VERSION,
  materializeExperimentCellInput,
  parseExperimentPlanFile,
  parseExperimentPlanJson,
  serializeExperimentPlan,
} from "../packages/core/src/experiment.ts";
import type { EvaluationExperimentPlan } from "../packages/core/src/experiment.ts";
import {
  createProjectFile,
  createPromptTemplate,
  insertPromptTemplateUse,
  parseProjectFile,
} from "../packages/core/src/project.ts";
import type { ProjectFile } from "../packages/core/src/project.ts";
import { OPENAI_COMPATIBLE_CAPABILITIES } from "../packages/core/src/types.ts";

const staging: ProjectEnvironment = {
  id: "environment_staging",
  name: "Staging",
  entries: [{ name: "customer", value: "Acme" }, { name: "region", value: "us-west" }],
};
const production: ProjectEnvironment = {
  id: "environment_production",
  name: "Production",
  entries: [{ name: "customer", value: "Globex" }, { name: "region", value: "eu-central" }],
};

function project(
  variants: ChatEvaluationSuite["variants"],
  environmentId?: ProjectEnvironment["id"],
  extraDefaults: Record<string, string> = {},
): ProjectFile {
  let value = createProjectFile({
    name: "Evaluation environments",
    idSuffix: "evaluation-environments",
    createdAt: "2026-10-29T12:00:00.000Z",
    request: {
      provider: "openai-compatible",
      endpoint: "https://provider.example.test/v1",
      model: "authored-model",
      messages: [],
    },
  });
  value = createPromptTemplate(value, {
    name: "Ticket",
    messages: [{ role: "user", content: "{{customer}} in {{region}}: {{ticket}}" }],
    variableDefaults: { region: "default-region", ...extraDefaults },
    idSuffix: "ticket",
    revisionIdSuffix: "ticket-1",
    createdAt: "2026-10-29T12:00:01.000Z",
  });
  const revisionId = value.defaults.conversationRevisionId;
  value = insertPromptTemplateUse(value, {
    conversationRevisionId: revisionId,
    templateId: "template_ticket",
    idSuffix: "ticket",
    outputMessageIdSuffixes: ["ticket"],
  });
  return parseProjectFile({
    ...value,
    environments: [staging, production],
    evaluationSuites: [{
      id: "evaluation-suite_tickets",
      name: "Tickets",
      input: { kind: "conversation-revision", conversationRevisionId: revisionId },
      execution: {
        target: { ...value.defaults.target },
        responseMode: "buffered",
        options: {},
        repetitions: 1,
        toolIds: [],
        ...(environmentId ? { environmentId } : {}),
      },
      variants,
      inputBindings: [{
        id: "evaluation-input_ticket",
        name: "Ticket",
        target: { kind: "template-variable", templateUseId: "template-use_ticket", variableName: "ticket" },
      }],
      cases: [{
        id: "evaluation-case_refund",
        name: "Refund",
        values: { "evaluation-input_ticket": "refund request" },
        checks: [{ checkId: "check_refund", kind: "contains", value: "refund", caseSensitive: false }],
      }],
    }],
  });
}

const variants: ChatEvaluationSuite["variants"] = [
  { id: "evaluation-variant_staging-a", name: "Staging A", overrides: {} },
  { id: "evaluation-variant_staging-b", name: "Staging B", overrides: { target: { model: "other-model" } } },
  { id: "evaluation-variant_production", name: "Production", overrides: { environmentId: "environment_production" } },
];

function plan(source: ProjectFile): EvaluationExperimentPlan {
  let suffix = 0;
  return createEvaluationExperimentPlan({
    project: source,
    suiteId: "evaluation-suite_tickets",
    selectedCaseIds: ["evaluation-case_refund"],
    createdAt: "2026-10-29T12:10:00.000Z",
    createSuffix: () => `environments-${++suffix}`,
    runtimeTarget: {
      profileId: "profile_confirmed",
      protocol: "openai-compatible-chat-completions",
      endpoint: "https://confirmed.example.test/v1",
      capabilities: OPENAI_COMPATIBLE_CAPABILITIES,
    },
  });
}

function sentText(evaluation: EvaluationExperimentPlan, variantId: string): string {
  const cell = evaluation.cells.find((candidate) => candidate.variantId === variantId)!;
  const input = materializeExperimentCellInput(evaluation, cell.cellId);
  const part = input.messages.at(-1)!.content[0]!;
  return part.type === "text" ? part.text : "";
}

test("a case is rendered once per environment its variants use, and each variant sends its own", () => {
  const evaluation = plan(project(variants, staging.id));

  assert.equal(EXPERIMENT_SCHEMA_VERSION, 7);
  const [evaluationCase] = evaluation.suite.cases;
  assert.deepEqual(
    evaluationCase!.inputs.map(({ environment }) => environment),
    [
      { environmentId: "environment_staging", name: "Staging", consumed: { customer: "Acme", region: "us-west" } },
      { environmentId: "environment_production", name: "Production", consumed: { customer: "Globex", region: "eu-central" } },
    ],
  );
  assert.deepEqual(
    evaluation.suite.variants.map(({ variantId, environmentId }) => [variantId, environmentId]),
    [
      ["evaluation-variant_staging-a", "environment_staging"],
      ["evaluation-variant_staging-b", "environment_staging"],
      ["evaluation-variant_production", "environment_production"],
    ],
  );
  assert.equal(sentText(evaluation, "evaluation-variant_staging-a"), "Acme in us-west: refund request");
  assert.equal(sentText(evaluation, "evaluation-variant_staging-b"), "Acme in us-west: refund request");
  assert.equal(sentText(evaluation, "evaluation-variant_production"), "Globex in eu-central: refund request");

  const cell = evaluation.cells.find(({ variantId }) => variantId === "evaluation-variant_production")!;
  const input = materializeExperimentCellInput(evaluation, cell.cellId);
  assert.equal(input.environment?.environmentId, "environment_production");
  assert.equal(Object.hasOwn(input, "environmentId"), false);
  assert.deepEqual(input.templateResolutions[0]!.valueSources, {
    region: "environment",
    customer: "environment",
    ticket: "case",
  });
});

test("a variant that clears the environment renders without one, or the plan is refused", () => {
  // `customer` has no default, so the bare variant cannot render: the plan is
  // refused before any request rather than sending a visible token.
  assert.throws(
    () => plan(project([
      { id: "evaluation-variant_staging", name: "Staging", overrides: {} },
      { id: "evaluation-variant_bare", name: "Bare", overrides: { environmentId: null } },
    ], staging.id)),
    (error: unknown) => error instanceof EvaluationSetupError && /configuration "Bare"/.test(error.message),
  );

  const evaluation = plan(project([
    { id: "evaluation-variant_staging", name: "Staging", overrides: {} },
    { id: "evaluation-variant_bare", name: "Bare", overrides: { environmentId: null } },
  ], staging.id, { customer: "Default Co" }));
  assert.equal(sentText(evaluation, "evaluation-variant_bare"), "Default Co in default-region: refund request");
  assert.equal(evaluation.suite.variants[1]!.environmentId, undefined);
  assert.deepEqual(evaluation.suite.cases[0]!.inputs.map(({ environment }) => environment?.environmentId), [
    "environment_staging",
    undefined,
  ]);
});

test("preflight names the variant whose environment leaves a variable unfilled", () => {
  const source = project([
    { id: "evaluation-variant_staging", name: "Staging", overrides: {} },
    { id: "evaluation-variant_bare", name: "Bare", overrides: { environmentId: null } },
  ], staging.id);

  const diagnostics = evaluationSuitePreflight(
    source,
    "evaluation-suite_tickets",
    source.defaults.conversationRevisionId,
  );

  assert.deepEqual(
    diagnostics.map(({ code, message }) => ({ code, message })),
    [{
      code: "unresolved-template-variable",
      message: 'Case "Refund" cannot resolve template variable "customer" in configuration "Bare": Template variable "customer" has no value.',
    }],
  );
  assert.deepEqual(
    evaluationSuitePreflight(project(variants, staging.id), "evaluation-suite_tickets", source.defaults.conversationRevisionId),
    [],
  );
});

test("a current plan round-trips, and a version 5 plan opens with one input and no environment", () => {
  const evaluation = plan(project(variants, staging.id));
  const serialized = serializeExperimentPlan(evaluation);
  assert.equal(JSON.parse(serialized).schemaVersion, 7);
  assert.deepEqual(parseExperimentPlanJson(serialized), evaluation);

  const bare = plan(project([{ id: "evaluation-variant_only", name: "Only", overrides: {} }], undefined, { customer: "Default Co" }));
  const [{ inputs: [input], ...rest }] = bare.suite.cases as [EvaluationExperimentPlan["suite"]["cases"][number]];
  const legacyInput = {
    ...input!,
    templateResolutions: input!.templateResolutions.map((resolution) => {
      const legacy = { ...resolution };
      delete legacy.valueSources;
      return legacy;
    }),
  };
  const v5 = {
    ...bare,
    schemaVersion: 5,
    suite: { ...bare.suite, cases: [{ ...rest, input: legacyInput }] },
  };

  const opened = parseExperimentPlanFile(v5);
  assert.equal(opened.schemaVersion, 7);
  assert.deepEqual((opened as EvaluationExperimentPlan).suite.cases[0]!.inputs, [legacyInput]);
  assert.throws(
    () => parseExperimentPlanFile({ ...v5, suite: { ...v5.suite, cases: [{ ...rest, input }] } }),
    /valueSources/,
  );
});

test("a version 6 plan gives every variant exactly one input and leaves none unused", () => {
  const evaluation = plan(project(variants, staging.id));
  const value = JSON.parse(serializeExperimentPlan(evaluation));

  const missing = structuredClone(value);
  missing.suite.cases[0].inputs.pop();
  assert.throws(() => parseExperimentPlanFile(missing), /no input for configuration/);

  const orphan = structuredClone(value);
  orphan.suite.variants[2].environmentId = "environment_staging";
  assert.throws(() => parseExperimentPlanFile(orphan), /no configuration uses/);

  const duplicate = structuredClone(value);
  duplicate.suite.cases[0].inputs.push(structuredClone(duplicate.suite.cases[0].inputs[0]));
  assert.throws(() => parseExperimentPlanFile(duplicate), /more than one input/);
});

test("repeated plans reject environment-sourced values whose snapshot is missing", () => {
  const evaluation = plan(project([variants[0]!], staging.id));
  const input = materializeExperimentCellInput(evaluation, evaluation.cells[0]!.cellId);
  // Evaluation materialization also carries configuration display metadata.
  Reflect.deleteProperty(input, "variantId");
  Reflect.deleteProperty(input, "name");
  const repeated = createRepeatedExperimentPlan(input, 1, 1);
  assert.doesNotThrow(() => parseExperimentPlanFile(repeated));
  delete repeated.commonInput.environment;
  assert.throws(() => parseExperimentPlanFile(repeated), /takes "region" from an environment the run did not record/);
});

test("evaluation plans reject environment sources without their snapshot", () => {
  const evaluation = plan(project([variants[0]!], staging.id));
  delete evaluation.suite.variants[0]!.environmentId;
  delete evaluation.suite.cases[0]!.inputs[0]!.environment;
  assert.throws(() => parseExperimentPlanFile(evaluation), /takes "region" from an environment the run did not record/);
});
