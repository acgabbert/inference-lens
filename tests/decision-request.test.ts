import { inlineRevision } from "./project-kind-helpers.ts";
import assert from "node:assert/strict";
import test from "node:test";

import type { DecisionInput } from "../packages/core/src/decision.ts";
import {
  activeDecisionRequestRevision as activeRevision,
  prepareDecisionRequestRun,
  resolveDecisionRequest,
  resolveProjectDecisionRequestRevision,
  updateDecisionRequestDraft,
} from "../packages/core/src/decision-request.ts";
import { discoverDecisionVariables } from "../packages/core/src/decision-variables.ts";
import { createDecisionEvaluationSuite } from "../packages/core/src/evaluation-suite-authoring.ts";
import {
  PROJECT_SCHEMA_VERSION,
  createProjectFile,
  parseProjectFile,
  parseProjectJson,
  serializeProjectFile,
} from "../packages/core/src/project.ts";
import type { ProjectFile } from "../packages/core/src/project.ts";
import { resolveProviderCapabilities } from "../packages/core/src/types.ts";

function activeDecisionRequestRevision(project: ProjectFile) {
  const revision = activeRevision(project);
  return revision ? inlineRevision(revision) : undefined;
}

const request = {
  provider: "openai-compatible" as const,
  endpoint: "http://127.0.0.1:44028/v1",
  model: "chat-model",
  messages: [{ role: "user" as const, content: "Hello" }],
  capabilities: resolveProviderCapabilities("openai-compatible"),
};

function project(): ProjectFile {
  return createProjectFile({ name: "Decisions", request, idSuffix: "d", createdAt: "2026-10-24T12:00:00.000Z" });
}

// Question and option order run against the alphabet, so a serializer that
// sorts them is caught.
const ordered: DecisionInput = {
  state: "Ticket: {{ticket}}",
  questions: {
    zeta: { type: "choice", instructions: "Route {{team}}", criteria: { urgent: "Now", later: null } },
    alpha: { type: "score", instructions: { text: "Rate {{ticket}}", keep: 1 }, criteria: ["low", "high"] },
  },
};

const at = { idSuffix: "one", createdAt: "2026-10-24T12:01:00.000Z" };

test("a v12 document opens as the current schema with no decision requests", () => {
  assert.ok(PROJECT_SCHEMA_VERSION >= 13);
  const v12 = { ...project(), schemaVersion: 12 } as Record<string, unknown>;
  delete v12.decisionRequests;
  delete v12.decisionRequestRevisions;
  const opened = parseProjectFile(v12);
  assert.equal(opened.schemaVersion, PROJECT_SCHEMA_VERSION);
  assert.deepEqual(opened.decisionRequests, []);
  assert.deepEqual(opened.decisionRequestRevisions, []);
  assert.equal(opened.defaults.decisionRequestRevisionId, undefined);
});

test("a v12 document that already names decision requests is refused", () => {
  const v12 = { ...updateDecisionRequestDraft(project(), { decision: ordered, values: {}, branch: false, ...at }), schemaVersion: 12 };
  assert.throws(() => parseProjectFile(v12), /Invalid Inference Lens project/);
});

test("the first decision edit creates a request and points the project at it", () => {
  const next = updateDecisionRequestDraft(project(), { decision: ordered, values: { ticket: "#4", team: "ops" }, branch: false, ...at });
  assert.deepEqual(next.decisionRequests, [{ id: "decision-request_one", name: "Decision request" }]);
  assert.equal(next.defaults.decisionRequestRevisionId, "decision-revision_one");
  const revision = activeDecisionRequestRevision(next);
  assert.equal(revision?.decisionRequestId, "decision-request_one");
  assert.equal(revision?.parentRevisionId, undefined);
  assert.deepEqual(revision?.values, { ticket: "#4", team: "ops" });
});

test("serialization keeps question and option order, and reopens the same request", () => {
  const saved = serializeProjectFile(updateDecisionRequestDraft(project(), { decision: ordered, values: {}, branch: false, ...at }));
  const reopened = activeDecisionRequestRevision(parseProjectJson(saved))!;
  assert.deepEqual(Object.keys(reopened.decision.questions), ["zeta", "alpha"]);
  const zeta = reopened.decision.questions.zeta!;
  assert.equal(zeta.type, "choice");
  assert.deepEqual(Object.keys(zeta.type === "choice" ? zeta.criteria : {}), ["urgent", "later"]);
  assert.deepEqual(Object.keys((reopened.decision.questions.alpha!.instructions as Record<string, unknown>)), ["text", "keep"]);
});

test("an unfrozen revision is edited in place; a frozen one branches", () => {
  const first = updateDecisionRequestDraft(project(), { decision: ordered, values: {}, branch: false, ...at });
  const changed: DecisionInput = { ...ordered, state: "Ticket {{ticket}} again" };

  const inPlace = updateDecisionRequestDraft(first, { decision: changed, values: {}, branch: false, idSuffix: "two", createdAt: at.createdAt });
  assert.equal(inPlace.decisionRequestRevisions.length, 1);
  assert.equal(activeDecisionRequestRevision(inPlace)?.decision.state, "Ticket {{ticket}} again");

  const branched = updateDecisionRequestDraft(first, { decision: changed, values: {}, branch: true, idSuffix: "two", createdAt: at.createdAt });
  assert.equal(branched.decisionRequestRevisions.length, 2);
  assert.equal(branched.defaults.decisionRequestRevisionId, "decision-revision_two");
  const child = activeDecisionRequestRevision(branched)!;
  assert.equal(child.parentRevisionId, "decision-revision_one");
  assert.equal(child.decisionRequestId, "decision-request_one");
  assert.equal(inlineRevision(branched.decisionRequestRevisions[0]!).decision.state, "Ticket: {{ticket}}");
});

test("a revision a suite pins is never edited in place, so the suite keeps what it pinned", () => {
  const first = updateDecisionRequestDraft(project(), { decision: ordered, values: {}, branch: false, ...at });
  const pinned = createDecisionEvaluationSuite(first, {
    decisionRequestRevisionId: "decision-revision_one",
    model: "local-decision",
  }).project;
  const changed: DecisionInput = { ...ordered, state: "Ticket {{ticket}} again" };
  // The editor has not frozen the revision; the suite's pin is what forbids the in-place edit.
  const edited = updateDecisionRequestDraft(pinned, { decision: changed, values: {}, branch: false, idSuffix: "two", createdAt: at.createdAt });
  assert.equal(edited.decisionRequestRevisions.length, 2);
  assert.equal(inlineRevision(edited.decisionRequestRevisions[0]!).decision.state, "Ticket: {{ticket}}");
  assert.equal(activeDecisionRequestRevision(edited)?.id, "decision-revision_two");
  assert.equal(activeDecisionRequestRevision(edited)?.decision.state, "Ticket {{ticket}} again");
});

test("an unchanged draft never branches, whatever its key order", () => {
  const first = updateDecisionRequestDraft(project(), { decision: ordered, values: { team: "a" }, branch: false, ...at });
  const same = updateDecisionRequestDraft(first, { decision: structuredClone(ordered), values: { team: "a" }, branch: true, idSuffix: "two", createdAt: at.createdAt });
  assert.equal(same, first);
  const reordered: DecisionInput = { ...ordered, questions: { alpha: ordered.questions.alpha!, zeta: ordered.questions.zeta! } };
  const moved = updateDecisionRequestDraft(first, { decision: reordered, values: { team: "a" }, branch: true, idSuffix: "two", createdAt: at.createdAt });
  assert.equal(moved.decisionRequestRevisions.length, 2, "reordering questions is a change");
});

test("values for variables the input no longer uses are dropped", () => {
  const next = updateDecisionRequestDraft(project(), {
    decision: { state: "No variables", questions: ordered.questions },
    values: { ticket: "#4", gone: "x" },
    branch: false,
    ...at,
  });
  assert.deepEqual(activeDecisionRequestRevision(next)?.values, { ticket: "#4" });
});

test("save and reopen preserve absent assignments and explicit empty strings", () => {
  const saved = updateDecisionRequestDraft(project(), {
    decision: ordered, values: { ticket: "" }, branch: false, ...at,
  });
  const reopened = activeDecisionRequestRevision(parseProjectJson(serializeProjectFile(saved)))!;
  assert.deepEqual(reopened.values, { ticket: "" });
  assert.equal(Object.hasOwn(reopened.values, "team"), false);
  const blocked = prepareDecisionRequestRun(reopened.decision, reopened.values);
  assert.equal(blocked.ok, false);
  assert.deepEqual(!blocked.ok && blocked.diagnostics.map(({ name }) => name), ["team"]);
  assert.equal(prepareDecisionRequestRun(reopened.decision, { ...reopened.values, team: "" }).ok, true);
});

test("project resolution returns authored content and source identity, leaving rendering at execution", () => {
  const saved = updateDecisionRequestDraft(project(), {
    decision: ordered, values: { ticket: "#4", team: "ops" }, branch: false, ...at,
  });
  const resolved = resolveProjectDecisionRequestRevision(saved, "decision-revision_one")!;
  assert.deepEqual(resolved.source, {
    kind: "inline",
    decisionRequestId: "decision-request_one",
    decisionRequestRevisionId: "decision-revision_one",
  });
  assert.deepEqual(resolved.decision, ordered);
  assert.deepEqual(resolved.values, { ticket: "#4", team: "ops" });
  assert.deepEqual(resolved.variables, ["ticket", "team"]);
  assert.deepEqual(resolved.diagnostics, []);
  const prepared = prepareDecisionRequestRun(resolved.decision, { ...resolved.values, ticket: "case" });
  assert.equal(prepared.ok && prepared.decision.state, "Ticket: case");
  assert.equal(resolved.decision.state, "Ticket: {{ticket}}");
  assert.deepEqual(Object.keys(resolved.decision.questions), ["zeta", "alpha"]);
  assert.deepEqual(Object.keys(resolved.decision.questions.zeta!.criteria!), ["urgent", "later"]);
});

test("project resolution keeps missing values unresolved and does not mutate a saved revision", () => {
  const saved = updateDecisionRequestDraft(project(), {
    decision: ordered, values: { ticket: "" }, branch: false, ...at,
  });
  const before = serializeProjectFile(saved);
  const resolved = resolveProjectDecisionRequestRevision(saved, "decision-revision_one")!;
  assert.deepEqual(resolved.values, { ticket: "" });
  assert.deepEqual(resolved.diagnostics.map(({ code, name }) => ({ code, name })), [
    { code: "missing-template-variable", name: "team" },
  ]);
  Object.assign(resolved.values, { team: "ops" });
  resolved.decision.questions.zeta!.instructions = "Changed in caller";
  assert.equal(serializeProjectFile(saved), before);
  assert.equal(prepareDecisionRequestRun(resolved.decision, resolved.values).ok, true);
  const again = resolveProjectDecisionRequestRevision(saved, "decision-revision_one")!;
  assert.equal(Object.hasOwn(again.values, "team"), false);
  assert.equal(again.decision.questions.zeta!.instructions, "Route {{team}}");
});

test("project resolution reports malformed and forbidden tokens while preserving escaped literals", () => {
  const decision: DecisionInput = {
    state: { malformed: "{{ not valid }}", forbidden: "{{api_key}}", escaped: "\\{{literal}}" },
    questions: { q: { type: "noul", instructions: "Decide" } },
  };
  const saved = updateDecisionRequestDraft(project(), { decision, values: {}, branch: false, ...at });
  const resolved = resolveProjectDecisionRequestRevision(saved, "decision-revision_one")!;
  assert.deepEqual(resolved.decision, decision);
  assert.deepEqual(resolved.variables, ["api_key"]);
  assert.equal(resolved.diagnostics.length, 2);
  assert.equal(resolved.diagnostics[0]!.code, "invalid-template-token");
  assert.match(resolved.diagnostics[1]!.message, /secret-like/);
  assert.equal(prepareDecisionRequestRun(resolved.decision, resolved.values).ok, false);
});

test("project resolution never falls back to the active revision for a missing pin", () => {
  const saved = updateDecisionRequestDraft(project(), { decision: ordered, values: {}, branch: false, ...at });
  assert.equal(resolveProjectDecisionRequestRevision(saved, "decision-revision_missing"), undefined);
});

test("the parser refuses dangling references, stray values, and secret-like values", () => {
  const valid = updateDecisionRequestDraft(project(), { decision: ordered, values: { ticket: "#4" }, branch: false, ...at });
  const revision = inlineRevision(valid.decisionRequestRevisions[0]!);
  const cases: Array<[string, unknown]> = [
    ["missing request", { ...valid, decisionRequests: [] }],
    ["missing default", { ...valid, defaults: { ...valid.defaults, decisionRequestRevisionId: "decision-revision_nope" } }],
    ["missing parent", { ...valid, decisionRequestRevisions: [{ ...revision, parentRevisionId: "decision-revision_nope" }] }],
    ["stray value", { ...valid, decisionRequestRevisions: [{ ...revision, values: { ...revision.values, unused: "x" } }] }],
    ["secret value", { ...valid, decisionRequestRevisions: [{ ...revision, decision: { ...ordered, state: "{{api_key}}" }, values: { api_key: "x" } }] }],
    ["not a decision", { ...valid, decisionRequestRevisions: [{ ...revision, decision: { state: "s", questions: {} } }] }],
    ["request without revisions", { ...valid, decisionRequests: [...valid.decisionRequests, { id: "decision-request_empty", name: "Empty" }] }],
  ];
  for (const [label, document] of cases) {
    assert.throws(() => parseProjectFile(document), /Invalid Inference Lens project/, label);
  }
});

test("variables come from string values in state and instructions, never keys or criteria", () => {
  const input: DecisionInput = {
    state: { "{{key}}": ["{{a}}", { deep: "x {{ b }} y" }, 3, null], plain: "\\{{escaped}}" },
    questions: {
      q: { type: "choice", instructions: ["{{c}}"], criteria: { "{{label}}": "{{criterion}}" } },
      n: { type: "noul", instructions: "{{a}} again", criteria: { true: "{{t}}", false: "f" } },
    },
  };
  const discovered = discoverDecisionVariables(input);
  assert.deepEqual(discovered.variables, ["a", "b", "c"]);
  assert.deepEqual(discovered.diagnostics, []);
});

test("resolution substitutes values and reports every gap", () => {
  const resolved = resolveDecisionRequest(ordered, { ticket: "#4" });
  assert.deepEqual(resolved.decision.questions.alpha!.instructions, { text: "Rate #4", keep: 1 });
  assert.equal(resolved.decision.state, "Ticket: #4");
  assert.equal(resolved.decision.questions.zeta!.instructions, "Route {{team}}");
  assert.deepEqual(resolved.diagnostics.map(({ code }) => code), ["missing-template-variable"]);
  assert.match(resolved.diagnostics[0]!.message, /team/);
  assert.match(resolved.diagnostics[0]!.location, /zeta/);
  assert.deepEqual(Object.keys(resolved.decision.questions), ["zeta", "alpha"]);

  const prepared = prepareDecisionRequestRun(ordered, { ticket: "#4" });
  assert.equal(prepared.ok, false);
  const ready = prepareDecisionRequestRun(ordered, { ticket: "#4", team: "" });
  assert.deepEqual(ready.ok && ready.decision.questions.zeta!.instructions, "Route ");

  const invalid = prepareDecisionRequestRun({ state: "{{ not valid }}", questions: ordered.questions }, { ticket: "", team: "" });
  assert.equal(invalid.ok, false);
  assert.match(!invalid.ok ? invalid.diagnostics[0]!.message : "", /Invalid template token/);

  const secret = resolveDecisionRequest({ state: "{{api_key}}", questions: ordered.questions }, { ticket: "", team: "" });
  assert.match(secret.diagnostics[0]!.message, /secret-like/);
});
