import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  addDecisionOption,
  addDecisionQuestion,
  changeDecisionQuestionType,
  createDecisionDraft,
  decisionDraftFromInput,
  moveDecisionQuestion,
  setDecisionJsonText,
  showDecisionFormView,
  showDecisionJsonView,
  updateDecisionOption,
  updateDecisionQuestion,
  validateDecisionDraft,
} from "../app/decisions/decision-draft.ts";
import type { DecisionDraft } from "../app/decisions/decision-draft.ts";
import type { DecisionInput } from "../packages/core/src/decision.ts";

function captured(): DecisionInput {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/system-one/llamacpp-all-types.json", import.meta.url), "utf8"),
  );
  const { state, questions } = fixture.request;
  return { state, questions };
}

function rowIds(): () => string {
  let next = 0;
  return () => `row_${++next}`;
}

function valid(draft: DecisionDraft): DecisionInput {
  const result = validateDecisionDraft(draft);
  assert.ok("input" in result, `expected a valid draft, got ${JSON.stringify(result)}`);
  return result.input;
}

test("a captured input with JSON-valued fields survives the form unchanged", () => {
  const input = captured();
  const draft = decisionDraftFromInput(input, rowIds());
  const derived = valid(draft);
  assert.deepEqual(derived, input);
  // Key order is authored order; deepEqual does not check it.
  assert.equal(JSON.stringify(derived), JSON.stringify(input));
});

test("form → JSON → form keeps objects, arrays, and null as values", () => {
  const input = captured();
  const draft = decisionDraftFromInput(input, rowIds());
  const json = showDecisionJsonView(draft);
  assert.ok("draft" in json);
  assert.equal(json.draft.view, "json");
  assert.deepEqual(JSON.parse(json.draft.json.text), input);
  const form = showDecisionFormView(json.draft, rowIds());
  assert.ok("draft" in form);
  assert.equal(JSON.stringify(valid(form.draft)), JSON.stringify(input));
  // Row identity follows the authored id across the round trip.
  assert.deepEqual(
    form.draft.questions.map(({ rowId }) => rowId),
    draft.questions.map(({ rowId }) => rowId),
  );
});

test("JSON view derives the input from its text, and invalid JSON blocks Run", () => {
  const draft = decisionDraftFromInput(captured(), rowIds());
  const json = showDecisionJsonView(draft);
  assert.ok("draft" in json);
  const broken = setDecisionJsonText(json.draft, '{"state": "x", "questions": {');
  const result = validateDecisionDraft(broken);
  assert.ok("problems" in result);
  assert.equal(result.problems[0]!.location, "JSON");
  assert.match(result.problems[0]!.message, /JSON/);
  // It never runs a silently retained last-valid version.
  assert.ok(!("input" in result));
});

test("invalid JSON blocks switching to the form and is kept with its error", () => {
  const draft = decisionDraftFromInput(captured(), rowIds());
  const json = showDecisionJsonView(draft);
  assert.ok("draft" in json);
  const text = '{"state": "x", "questions": {';
  const broken = setDecisionJsonText(json.draft, text);
  const form = showDecisionFormView(broken, rowIds());
  assert.ok("problems" in form);
  assert.equal(form.draft.view, "json");
  assert.equal(form.draft.json.text, text);
  assert.ok(form.draft.json.error);
});

test("JSON a form cannot represent losslessly blocks switching to the form", () => {
  const draft = createDecisionDraft(rowIds());
  const json = showDecisionJsonView(draft);
  assert.ok("draft" in json);
  for (const text of [
    '{"state": "x", "questions": {"q": {"type": "box", "instructions": "i", "criteria": {}}}}',
    '{"state": "x", "questions": {"q": {"type": "noul", "instructions": "i", "extra": 1}}}',
    '{"state": "x", "questions": {}, "model": "m"}',
    '{"state": 3, "questions": {}}',
  ]) {
    const result = showDecisionFormView(setDecisionJsonText(json.draft, text), rowIds());
    assert.ok("problems" in result, text);
    assert.equal(result.draft.json.text, text);
  }
});

test("an incomplete form names what is missing and blocks Run", () => {
  const ids = rowIds();
  let draft = createDecisionDraft(ids);
  draft = { ...draft, state: { mode: "text", text: "  " } };
  draft = addDecisionQuestion(draft, ids);
  const row = draft.questions.at(-1)!;
  draft = updateDecisionQuestion(draft, row.rowId, { id: "" });
  const result = validateDecisionDraft(draft);
  assert.ok("problems" in result);
  const locations = result.problems.map(({ location }) => location);
  assert.ok(locations.includes("State"));
  assert.ok(result.problems.some(({ message }) => /id/i.test(message)));
});

test("duplicate question ids and option labels are refused", () => {
  const ids = rowIds();
  let draft = decisionDraftFromInput(captured(), ids);
  const [first, second] = draft.questions;
  draft = updateDecisionQuestion(draft, second!.rowId, { id: first!.id });
  draft = updateDecisionOption(draft, first!.rowId, first!.options[1]!.rowId, {
    label: { kind: "text", text: "billing" },
  });
  const result = validateDecisionDraft(draft);
  assert.ok("problems" in result);
  assert.ok(result.problems.some(({ message }) => /question id/i.test(message)));
  assert.ok(result.problems.some(({ message }) => /option/i.test(message) && /billing/.test(message)));
  // A form with duplicate keys cannot become one JSON object either.
  assert.ok("problems" in showDecisionJsonView(draft));
});

test("renaming and reordering keep each row's own state", () => {
  const ids = rowIds();
  let draft = decisionDraftFromInput(captured(), ids);
  const intent = draft.questions[0]!;
  draft = updateDecisionQuestion(draft, intent.rowId, { id: "topic" });
  draft = moveDecisionQuestion(draft, intent.rowId, 2);
  assert.deepEqual(draft.questions.map(({ id }) => id), ["severity", "is_spam", "topic"]);
  const moved = draft.questions[2]!;
  assert.equal(moved.rowId, intent.rowId);
  assert.deepEqual(moved.options, intent.options);
  const input = valid(draft);
  assert.deepEqual(Object.keys(input.questions), ["severity", "is_spam", "topic"]);
  assert.deepEqual(input.questions.topic, captured().questions.intent);
});

test("changing a question's type is reversible and keeps options in order", () => {
  const ids = rowIds();
  let draft = decisionDraftFromInput(captured(), ids);
  const intent = draft.questions[0]!;
  draft = changeDecisionQuestionType(draft, intent.rowId, "noul");
  assert.deepEqual(valid(draft).questions.intent, {
    type: "noul",
    instructions: "What is the customer mainly asking about?",
  });
  draft = changeDecisionQuestionType(draft, intent.rowId, "score");
  assert.deepEqual(valid(draft).questions.intent, {
    type: "score",
    instructions: "What is the customer mainly asking about?",
    criteria: ["billing", "bug", "other"],
  });
  draft = changeDecisionQuestionType(draft, intent.rowId, "choice");
  assert.deepEqual(valid(draft).questions.intent, captured().questions.intent);
});

test("a structured level kept on a choice question is refused by the JSON view, not stringified", () => {
  const ids = rowIds();
  const level = { label: "low", note: "cosmetic" };
  let draft = decisionDraftFromInput(
    { state: "s", questions: { q: { type: "score", instructions: "i", criteria: [level, "high"] } } },
    ids,
  );
  const q = draft.questions[0]!;
  draft = changeDecisionQuestionType(draft, q.rowId, "choice");

  const json = showDecisionJsonView(draft);
  assert.ok("problems" in json, `expected the switch to be refused, got ${JSON.stringify(json)}`);
  assert.deepEqual(json.problems, [{
    location: "Question 1 (q) · option 1",
    message: "A choice option's label must be text. Change the question back to score, or remove this option.",
  }]);
  const invalid = validateDecisionDraft(draft);
  assert.ok("problems" in invalid);
  assert.deepEqual(invalid.problems, json.problems);

  // The value was never rewritten, so the type change is still reversible (U4).
  draft = changeDecisionQuestionType(draft, q.rowId, "score");
  assert.deepEqual(valid(draft).questions.q, { type: "score", instructions: "i", criteria: [level, "high"] });
});

test("options kept for a noul question survive JSON view while it stays noul", () => {
  const ids = rowIds();
  let draft = decisionDraftFromInput(captured(), ids);
  const intent = draft.questions[0]!;
  draft = changeDecisionQuestionType(draft, intent.rowId, "noul");
  const json = showDecisionJsonView(draft);
  assert.ok("draft" in json);
  const form = showDecisionFormView(json.draft, ids);
  assert.ok("draft" in form);
  const back = changeDecisionQuestionType(form.draft, intent.rowId, "choice");
  assert.deepEqual(valid(back).questions.intent, captured().questions.intent);
});

test("a new option starts without a description, sent as null", () => {
  const ids = rowIds();
  let draft = createDecisionDraft(ids);
  draft = { ...draft, state: { mode: "text", text: "A ticket." }, questions: [] };
  draft = addDecisionQuestion(draft, ids);
  const row = draft.questions.at(-1)!;
  draft = updateDecisionQuestion(draft, row.rowId, { instructions: { kind: "text", text: "Which?" } });
  draft = addDecisionOption(draft, row.rowId, ids);
  const option = draft.questions.at(-1)!.options.at(-1)!;
  draft = updateDecisionOption(draft, row.rowId, option.rowId, { label: { kind: "text", text: "yes" } });
  const question = valid(draft).questions[row.id];
  assert.equal(question?.type, "choice");
  assert.ok(question?.type === "choice");
  assert.equal(question.criteria.yes, null);
});

test("state keeps its text/JSON mode and refuses JSON that is not a state", () => {
  const ids = rowIds();
  let draft = decisionDraftFromInput(captured(), ids);
  assert.equal(draft.state.mode, "json");
  draft = { ...draft, state: { mode: "json", text: "42" } };
  const result = validateDecisionDraft(draft);
  assert.ok("problems" in result);
  assert.equal(result.problems[0]!.location, "State");
  draft = { ...draft, state: { mode: "text", text: "42" } };
  assert.equal(valid(draft).state, "42");
});
