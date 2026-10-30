import assert from "node:assert/strict";
import test from "node:test";

import {
  environmentReferences,
  removeProjectEnvironment,
  setProjectDefaultEnvironment,
  setProjectEnvironment,
} from "../packages/core/src/environment.ts";
import type { ProjectEnvironment } from "../packages/core/src/environment.ts";
import { resolveEvaluationVariant } from "../packages/core/src/evaluation-suites.ts";
import type { ChatEvaluationSuite } from "../packages/core/src/evaluation-suites.ts";
import {
  createProjectFile,
  parseProjectFile,
  parseProjectJson,
  PROJECT_SCHEMA_VERSION,
  ProjectValidationError,
  serializeProjectFile,
} from "../packages/core/src/project.ts";
import type { ProjectFile } from "../packages/core/src/project.ts";
import { resolveProviderCapabilities } from "../packages/core/src/types.ts";

const request = {
  provider: "openai-compatible" as const,
  endpoint: "https://api.example.com/v1",
  model: "example-model",
  messages: [{ role: "user" as const, content: "Hello" }],
  capabilities: resolveProviderCapabilities("openai-compatible", {}),
};

const staging: ProjectEnvironment = {
  id: "environment_staging",
  name: "Staging",
  entries: [
    { name: "customer", value: "Acme" },
    { name: "greeting", value: "Hello {{customer}}" },
  ],
};

function baseProject(): ProjectFile {
  return createProjectFile({
    name: "Environments",
    request,
    idSuffix: "environments",
    createdAt: "2026-10-29T12:00:00.000Z",
  });
}

function suite(project: ProjectFile, overrides: Partial<ChatEvaluationSuite["execution"]> = {}): ChatEvaluationSuite {
  return {
    id: "evaluation-suite_greetings",
    name: "Greetings",
    input: { kind: "conversation-revision", conversationRevisionId: project.defaults.conversationRevisionId },
    execution: {
      target: structuredClone(project.defaults.target),
      responseMode: "buffered",
      options: {},
      repetitions: 1,
      toolIds: [],
      ...overrides,
    },
    variants: [
      { id: "evaluation-variant_base", name: "Base", overrides: {} },
      { id: "evaluation-variant_bare", name: "No environment", overrides: { environmentId: null } },
    ],
    inputBindings: [],
    cases: [],
  };
}

function rejection(run: () => unknown): Array<{ path: string; message: string }> {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ProjectValidationError, String(error));
    return error.issues.map(({ path, message }) => ({ path: path.join("."), message }));
  }
  assert.fail("Expected the project to be rejected.");
}

test("the active project format is v18 and new projects have no environments", () => {
  const project = baseProject();

  assert.equal(PROJECT_SCHEMA_VERSION, 18);
  assert.equal(project.schemaVersion, 18);
  assert.deepEqual(project.environments, []);
  assert.equal(project.defaults.environmentId, undefined);
});

test("a v15 project opens as v18 with no environments", () => {
  const v15: Record<string, unknown> = { ...baseProject(), schemaVersion: 15 };
  delete v15.environments;

  const opened = parseProjectFile(v15);

  assert.equal(opened.schemaVersion, 18);
  assert.deepEqual(opened.environments, []);
});

test("a v15 document that already carries environments is rejected, not reinterpreted", () => {
  const issues = rejection(() => parseProjectFile({ ...baseProject(), schemaVersion: 15, environments: [staging] }));

  assert.deepEqual(issues, [{
    path: "environments",
    message: "Environments require project schema v16; this document declares v15.",
  }]);
});

test("a newer project version is refused as newer, not as malformed", () => {
  const issues = rejection(() => parseProjectFile({ ...baseProject(), schemaVersion: 19 }));

  assert.equal(issues[0]?.path, "schemaVersion");
  assert.match(issues[0]!.message, /saved by a newer Inference Lens/);
});

test("environments, the default and suite selections round-trip", () => {
  const project = baseProject();
  const authored = parseProjectFile({
    ...project,
    environments: [staging],
    defaults: { ...project.defaults, environmentId: staging.id },
    evaluationSuites: [suite(project, { environmentId: staging.id })],
  });

  const reopened = parseProjectJson(serializeProjectFile(authored));

  assert.deepEqual(reopened.environments, [staging]);
  assert.equal(reopened.defaults.environmentId, "environment_staging");
  const reopenedSuite = reopened.evaluationSuites[0] as ChatEvaluationSuite;
  assert.equal(reopenedSuite.execution.environmentId, "environment_staging");
  assert.equal(reopenedSuite.variants[1]!.overrides.environmentId, null);
});

test("environment content rules are reported at the entry", () => {
  const project = baseProject();
  const issues = rejection(() => parseProjectFile({
    ...project,
    environments: [{
      ...staging,
      entries: [
        { name: "a", value: "{{b}}" },
        { name: "b", value: "{{a}}" },
        { name: "password", value: "x" },
      ],
    }],
  }));

  assert.deepEqual(issues.map(({ path }) => path), [
    "environments.0.entries.2.name",
    "environments.0.entries.0.value",
  ]);
});

test("environment IDs are unique and every selection names an existing environment", () => {
  const project = baseProject();
  const issues = rejection(() => parseProjectFile({
    ...project,
    environments: [staging, { ...staging, name: "Copy" }],
    defaults: { ...project.defaults, environmentId: "environment_missing" },
    evaluationSuites: [{
      ...suite(project, { environmentId: "environment_gone" }),
      variants: [{ id: "evaluation-variant_base", name: "Base", overrides: { environmentId: "environment_other" } }],
    }],
  }));

  assert.deepEqual(issues.map(({ path }) => path), [
    "environments.1",
    "defaults.environmentId",
    "evaluationSuites.0.execution.environmentId",
    "evaluationSuites.0.variants.0.overrides.environmentId",
  ]);
});

test("a variant inherits the suite environment, overrides it, or clears it", () => {
  const project = baseProject();
  const authored = suite(project, { environmentId: staging.id });

  assert.equal(resolveEvaluationVariant(authored, authored.variants[0]!).environmentId, "environment_staging");
  assert.equal(resolveEvaluationVariant(authored, authored.variants[1]!).environmentId, undefined);
  assert.equal(
    resolveEvaluationVariant(authored, {
      id: "evaluation-variant_prod",
      name: "Production",
      overrides: { environmentId: "environment_production" },
    }).environmentId,
    "environment_production",
  );
});

test("setting an environment inserts or replaces it by ID and validates the project", () => {
  let project = setProjectEnvironment(baseProject(), staging);
  project = setProjectEnvironment(project, { ...staging, entries: [{ name: "customer", value: "Globex" }] });

  assert.deepEqual(project.environments, [{ ...staging, entries: [{ name: "customer", value: "Globex" }] }]);
  assert.throws(
    () => setProjectEnvironment(project, { ...staging, entries: [{ name: "x", value: "{{x}}" }] }),
    ProjectValidationError,
  );
});

test("deleting a referenced environment is refused and names what uses it", () => {
  const base = setProjectEnvironment(baseProject(), staging);
  const project = parseProjectFile({
    ...base,
    defaults: { ...base.defaults, environmentId: staging.id },
    evaluationSuites: [{
      ...suite(base, { environmentId: staging.id }),
      variants: [
        { id: "evaluation-variant_base", name: "Base", overrides: {} },
        { id: "evaluation-variant_pinned", name: "Pinned", overrides: { environmentId: staging.id } },
      ],
    }],
  });

  const references = environmentReferences(project, staging.id);
  assert.deepEqual(references, [
    { kind: "project-default" },
    { kind: "evaluation-suite", suiteId: "evaluation-suite_greetings", suiteName: "Greetings" },
    {
      kind: "evaluation-variant",
      suiteId: "evaluation-suite_greetings",
      suiteName: "Greetings",
      variantId: "evaluation-variant_pinned",
      variantName: "Pinned",
    },
  ]);
  assert.deepEqual(removeProjectEnvironment(project, staging.id), { ok: false, references });

  const unreferenced = removeProjectEnvironment(base, staging.id);
  assert.equal(unreferenced.ok, true);
  assert.deepEqual(unreferenced.ok && unreferenced.project.environments, []);
});

test("the project default environment is set, cleared, and must exist", () => {
  const project = setProjectEnvironment(baseProject(), staging);
  const withDefault = setProjectDefaultEnvironment(project, "environment_staging");
  assert.equal(withDefault.defaults.environmentId, "environment_staging");
  assert.equal("environmentId" in setProjectDefaultEnvironment(withDefault, undefined).defaults, false);
  assert.deepEqual(rejection(() => setProjectDefaultEnvironment(project, "environment_missing")), [
    { path: "defaults.environmentId", message: "References an unknown environment." },
  ]);
});
