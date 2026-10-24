import type { DecisionInput, DecisionQuestion, DecisionQuestionType } from "../../packages/core/src/decision";
import type { JsonObject, JsonValue } from "../../packages/core/src/run-kernel/types";

/**
 * The decision editor's draft (D18). It is application-local: incomplete rows,
 * raw JSON text, row identities, and options kept across type changes (U4)
 * live here and never reach `DecisionInput`, the project, or a trace.
 *
 * Every function is pure and returns a new draft; the hook only holds it.
 */

/**
 * A form field. Strings are edited as text; any other JSON value is kept as
 * that value, so a round trip never stringifies it (U3, D18). The form shows
 * such a value and leaves editing it to the JSON view.
 */
export type DraftValue =
  | { kind: "text"; text: string }
  | { kind: "json"; value: JsonValue };

/**
 * One option row. A choice question reads the label and description; a score
 * question reads the label as that level's criterion and keeps the description
 * for a change back (U4); a noul question keeps both.
 */
export interface DecisionOptionRow {
  rowId: string;
  label: DraftValue;
  /** `null` is "no description", which a choice option sends as `null`. */
  description: DraftValue | null;
}

export interface DecisionQuestionRow {
  /** Editor identity; never sent. Authored ids are separate (D18). */
  rowId: string;
  id: string;
  type: DecisionQuestionType;
  instructions: DraftValue;
  /** Kept in authored order whatever the type, so a type change is reversible. */
  options: DecisionOptionRow[];
  noul: { enabled: boolean; true: DraftValue; false: DraftValue };
}

export interface DecisionDraft {
  view: "form" | "json";
  /** Only state gets its own text/JSON toggle (U3). The text is never rewritten by it. */
  state: { mode: "text" | "json"; text: string };
  questions: DecisionQuestionRow[];
  /** The whole-input JSON view. Its text is the source of truth while it is shown. */
  json: { text: string; error?: string };
}

export interface DecisionDraftProblem {
  /** Readable: "State", "JSON", "Question 2 (intent)", "Question 2 (intent) · option 3". */
  location: string;
  message: string;
}

export type NewRowId = () => string;

export function defaultRowId(): string {
  return globalThis.crypto.randomUUID();
}

const emptyText: DraftValue = { kind: "text", text: "" };

function draftValue(value: JsonValue): DraftValue {
  return typeof value === "string" ? { kind: "text", text: value } : { kind: "json", value };
}

function jsonValue(value: DraftValue): JsonValue {
  return value.kind === "text" ? value.text : value.value;
}

function isBlank(value: DraftValue): boolean {
  return value.kind === "text" && value.text.trim() === "";
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function questionRow(
  id: string,
  question: DecisionQuestion,
  newRowId: NewRowId,
  previous?: DecisionQuestionRow,
): DecisionQuestionRow {
  const rowId = previous?.rowId ?? newRowId();
  const instructions = draftValue(question.instructions);
  switch (question.type) {
    case "choice":
      return {
        rowId, id, type: "choice", instructions,
        options: Object.entries(question.criteria).map(([label, description], index) => ({
          rowId: previous?.options[index]?.rowId ?? newRowId(),
          label: { kind: "text", text: label },
          description: description === null ? null : draftValue(description),
        })),
        noul: previous?.noul ?? { enabled: false, true: emptyText, false: emptyText },
      };
    case "score":
      return {
        rowId, id, type: "score", instructions,
        options: question.criteria.map((level, index) => ({
          rowId: previous?.options[index]?.rowId ?? newRowId(),
          label: draftValue(level),
          // A level has no description slot; one kept from a choice survives.
          description: previous?.options[index]?.description ?? null,
        })),
        noul: previous?.noul ?? { enabled: false, true: emptyText, false: emptyText },
      };
    case "noul":
      return {
        rowId, id, type: "noul", instructions,
        // The wire carries no options for noul; the editor's kept ones remain (U4).
        options: previous?.options ?? [],
        noul: question.criteria
          ? { enabled: true, true: draftValue(question.criteria.true), false: draftValue(question.criteria.false) }
          : { enabled: false, true: previous?.noul.true ?? emptyText, false: previous?.noul.false ?? emptyText },
      };
  }
}

/** A draft holding exactly `input`, matching rows to `previous` by authored id. */
export function decisionDraftFromInput(
  input: DecisionInput,
  newRowId: NewRowId = defaultRowId,
  previous?: readonly DecisionQuestionRow[],
): DecisionDraft {
  return {
    view: "form",
    state: typeof input.state === "string"
      ? { mode: "text", text: input.state }
      : { mode: "json", text: JSON.stringify(input.state, null, 2) },
    questions: Object.entries(input.questions).map(([id, question]) =>
      questionRow(id, question, newRowId, previous?.find((row) => row.id === id)),
    ),
    json: { text: "" },
  };
}

export function createDecisionDraft(newRowId: NewRowId = defaultRowId): DecisionDraft {
  return decisionDraftFromInput(
    {
      state: "",
      questions: {
        intent: {
          type: "choice",
          instructions: "",
          criteria: { yes: null, no: null },
        },
      },
    },
    newRowId,
  );
}

function questionLocation(row: DecisionQuestionRow, index: number): string {
  return `Question ${index + 1}${row.id.trim() ? ` (${row.id})` : ""}`;
}

/** The question as it is sent, or the problems that stop it being sent. */
function questionFromRow(
  row: DecisionQuestionRow,
  location: string,
  problems: DecisionDraftProblem[],
): DecisionQuestion | undefined {
  const before = problems.length;
  if (isBlank(row.instructions)) problems.push({ location, message: "Instructions are empty." });
  const instructions = jsonValue(row.instructions);
  switch (row.type) {
    case "choice": {
      if (row.options.length === 0) problems.push({ location, message: "Add at least one option." });
      const criteria: Record<string, JsonValue | null> = {};
      const seen = new Set<string>();
      row.options.forEach((option, index) => {
        const where = `${location} · option ${index + 1}`;
        if (option.label.kind !== "text") {
          problems.push({ location: where, message: "A choice option's label must be text. Edit it in the JSON view." });
          return;
        }
        const label = option.label.text;
        if (label.trim() === "") problems.push({ location: where, message: "The option label is empty." });
        else if (seen.has(label)) problems.push({ location: where, message: `Another option is already labelled “${label}”.` });
        seen.add(label);
        criteria[label] = option.description === null ? null : jsonValue(option.description);
      });
      return problems.length === before ? { type: "choice", instructions, criteria } : undefined;
    }
    case "score": {
      if (row.options.length === 0) problems.push({ location, message: "Add at least one level." });
      row.options.forEach((option, index) => {
        if (isBlank(option.label)) problems.push({ location: `${location} · level ${index}`, message: "The level is empty." });
      });
      return problems.length === before
        ? { type: "score", instructions, criteria: row.options.map(({ label }) => jsonValue(label)) }
        : undefined;
    }
    case "noul": {
      if (row.noul.enabled) {
        if (isBlank(row.noul.true)) problems.push({ location, message: "The true criterion is empty." });
        if (isBlank(row.noul.false)) problems.push({ location, message: "The false criterion is empty." });
      }
      if (problems.length !== before) return undefined;
      return row.noul.enabled
        ? { type: "noul", instructions, criteria: { true: jsonValue(row.noul.true), false: jsonValue(row.noul.false) } }
        : { type: "noul", instructions };
    }
  }
}

function stateFromDraft(
  state: DecisionDraft["state"],
  problems: DecisionDraftProblem[],
): DecisionInput["state"] | undefined {
  if (state.mode === "text") {
    if (state.text.trim() === "") problems.push({ location: "State", message: "State is empty." });
    return state.text;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(state.text);
  } catch (error) {
    problems.push({ location: "State", message: `State is not valid JSON: ${error instanceof Error ? error.message : String(error)}` });
    return undefined;
  }
  if (typeof parsed === "string" || Array.isArray(parsed) || isJsonObject(parsed)) return parsed as DecisionInput["state"];
  problems.push({ location: "State", message: "JSON state must be an object, an array, or a string." });
  return undefined;
}

function validateForm(draft: DecisionDraft): { input: DecisionInput } | { problems: DecisionDraftProblem[] } {
  const problems: DecisionDraftProblem[] = [];
  const state = stateFromDraft(draft.state, problems);
  if (draft.questions.length === 0) problems.push({ location: "Questions", message: "Add at least one question." });
  const questions: Record<string, DecisionQuestion> = {};
  const seen = new Set<string>();
  draft.questions.forEach((row, index) => {
    const location = questionLocation(row, index);
    if (row.id.trim() === "") problems.push({ location, message: "The question id is empty." });
    else if (seen.has(row.id)) problems.push({ location, message: `Another question id is already “${row.id}”.` });
    seen.add(row.id);
    const question = questionFromRow(row, location, problems);
    if (question) questions[row.id] = question;
  });
  return problems.length > 0 || state === undefined
    ? { problems }
    : { input: { state, questions } };
}

function jsonProblem(message: string): { problems: DecisionDraftProblem[] } {
  return { problems: [{ location: "JSON", message }] };
}

const QUESTION_KEYS = new Set(["type", "instructions", "criteria"]);

/**
 * Reads the JSON view's text as the shape of a `DecisionInput`, refusing
 * anything the form could not hold without loss. Content (empty labels,
 * duplicate keys) is left to the same validation the form uses.
 */
function parseJsonView(text: string): { input: DecisionInput } | { problems: DecisionDraftProblem[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return jsonProblem(`Not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isJsonObject(parsed)) return jsonProblem("The input must be an object with state and questions.");
  const extra = Object.keys(parsed).filter((key) => key !== "state" && key !== "questions");
  if (extra.length > 0) return jsonProblem(`Unsupported top-level ${extra.length === 1 ? "field" : "fields"}: ${extra.join(", ")}. The connection and model are chosen separately.`);
  const { state, questions } = parsed;
  if (typeof state !== "string" && !Array.isArray(state) && !isJsonObject(state)) {
    return jsonProblem("state must be a string, an object, or an array.");
  }
  if (!isJsonObject(questions)) return jsonProblem("questions must be an object keyed by question id.");
  for (const [id, question] of Object.entries(questions)) {
    const where = `questions.${id}`;
    if (!isJsonObject(question)) return jsonProblem(`${where} must be an object.`);
    const unknown = Object.keys(question).filter((key) => !QUESTION_KEYS.has(key));
    if (unknown.length > 0) return jsonProblem(`${where} has unsupported ${unknown.length === 1 ? "field" : "fields"}: ${unknown.join(", ")}.`);
    if (question.instructions === undefined) return jsonProblem(`${where}.instructions is missing.`);
    switch (question.type) {
      case "choice":
        if (!isJsonObject(question.criteria)) return jsonProblem(`${where}.criteria must map each option label to its description or null.`);
        break;
      case "score":
        if (!Array.isArray(question.criteria)) return jsonProblem(`${where}.criteria must list the levels from low to high.`);
        break;
      case "noul":
        if (question.criteria !== undefined) {
          const criteria = question.criteria;
          if (
            !isJsonObject(criteria) ||
            criteria.true === undefined ||
            criteria.false === undefined ||
            Object.keys(criteria).some((key) => key !== "true" && key !== "false")
          ) return jsonProblem(`${where}.criteria must have exactly true and false.`);
        }
        break;
      default:
        return jsonProblem(`${where}.type must be choice, score, or noul.`);
    }
  }
  return { input: { state, questions } as DecisionInput };
}

/**
 * The executable input derived from the draft as it is now (D18). Invalid or
 * incomplete input returns problems; there is no last-valid fallback.
 */
export function validateDecisionDraft(
  draft: DecisionDraft,
): { input: DecisionInput } | { problems: DecisionDraftProblem[] } {
  if (draft.view === "form") return validateForm(draft);
  const parsed = parseJsonView(draft.json.text);
  if ("problems" in parsed) return parsed;
  // The same rules as the form, so both views refuse the same inputs.
  return validateForm(decisionDraftFromInput(parsed.input, () => "", draft.questions));
}

/**
 * Form → JSON. Values are kept as they are; incomplete rows come across as
 * they stand. Only a form whose keys collide is refused, since one JSON
 * object cannot hold both.
 */
export function showDecisionJsonView(
  draft: DecisionDraft,
): { draft: DecisionDraft } | { problems: DecisionDraftProblem[] } {
  if (draft.view === "json") return { draft };
  const problems: DecisionDraftProblem[] = [];
  let state: JsonValue = draft.state.text;
  if (draft.state.mode === "json") {
    try {
      state = JSON.parse(draft.state.text) as JsonValue;
    } catch (error) {
      problems.push({ location: "State", message: `State is not valid JSON: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  const questions: JsonObject = {};
  draft.questions.forEach((row, index) => {
    const location = questionLocation(row, index);
    if (row.id in questions) {
      problems.push({ location, message: `Another question id is already “${row.id}”.` });
      return;
    }
    const instructions = jsonValue(row.instructions);
    if (row.type === "choice") {
      const criteria: JsonObject = {};
      for (const [optionIndex, option] of row.options.entries()) {
        const label = option.label.kind === "text" ? option.label.text : JSON.stringify(option.label.value);
        if (label in criteria) {
          problems.push({ location: `${location} · option ${optionIndex + 1}`, message: `Another option is already labelled “${label}”.` });
        }
        criteria[label] = option.description === null ? null : jsonValue(option.description);
      }
      questions[row.id] = { type: "choice", instructions, criteria };
    } else if (row.type === "score") {
      questions[row.id] = { type: "score", instructions, criteria: row.options.map(({ label }) => jsonValue(label)) };
    } else {
      questions[row.id] = row.noul.enabled
        ? { type: "noul", instructions, criteria: { true: jsonValue(row.noul.true), false: jsonValue(row.noul.false) } }
        : { type: "noul", instructions };
    }
  });
  if (problems.length > 0) return { problems };
  return { draft: { ...draft, view: "json", json: { text: JSON.stringify({ state, questions }, null, 2) } } };
}

/**
 * JSON → form. Blocked, keeping the text and its error, when the text does not
 * parse or holds something the form cannot represent (D18).
 */
export function showDecisionFormView(
  draft: DecisionDraft,
  newRowId: NewRowId = defaultRowId,
): { draft: DecisionDraft } | { problems: DecisionDraftProblem[]; draft: DecisionDraft } {
  if (draft.view === "form") return { draft };
  const parsed = parseJsonView(draft.json.text);
  if ("problems" in parsed) {
    return { problems: parsed.problems, draft: { ...draft, json: { text: draft.json.text, error: parsed.problems[0]!.message } } };
  }
  return { draft: decisionDraftFromInput(parsed.input, newRowId, draft.questions) };
}

export function setDecisionJsonText(draft: DecisionDraft, text: string): DecisionDraft {
  return { ...draft, json: { text } };
}

function mapRow(
  draft: DecisionDraft,
  rowId: string,
  update: (row: DecisionQuestionRow) => DecisionQuestionRow,
): DecisionDraft {
  return { ...draft, questions: draft.questions.map((row) => (row.rowId === rowId ? update(row) : row)) };
}

function unusedId(draft: DecisionDraft): string {
  const taken = new Set(draft.questions.map(({ id }) => id));
  let index = draft.questions.length + 1;
  while (taken.has(`question_${index}`)) index += 1;
  return `question_${index}`;
}

export function addDecisionQuestion(draft: DecisionDraft, newRowId: NewRowId = defaultRowId): DecisionDraft {
  return {
    ...draft,
    questions: [
      ...draft.questions,
      {
        rowId: newRowId(),
        id: unusedId(draft),
        type: "choice",
        instructions: emptyText,
        options: [],
        noul: { enabled: false, true: emptyText, false: emptyText },
      },
    ],
  };
}

export function removeDecisionQuestion(draft: DecisionDraft, rowId: string): DecisionDraft {
  return { ...draft, questions: draft.questions.filter((row) => row.rowId !== rowId) };
}

export function moveDecisionQuestion(draft: DecisionDraft, rowId: string, toIndex: number): DecisionDraft {
  const from = draft.questions.findIndex((row) => row.rowId === rowId);
  if (from < 0 || toIndex < 0 || toIndex >= draft.questions.length) return draft;
  const questions = [...draft.questions];
  const [row] = questions.splice(from, 1);
  questions.splice(toIndex, 0, row!);
  return { ...draft, questions };
}

export function updateDecisionQuestion(
  draft: DecisionDraft,
  rowId: string,
  patch: Partial<Pick<DecisionQuestionRow, "id" | "instructions" | "noul">>,
): DecisionDraft {
  return mapRow(draft, rowId, (row) => ({ ...row, ...patch }));
}

/** Options stay in authored order and are kept across every type (U4). */
export function changeDecisionQuestionType(
  draft: DecisionDraft,
  rowId: string,
  type: DecisionQuestionType,
): DecisionDraft {
  return mapRow(draft, rowId, (row) => ({ ...row, type }));
}

export function addDecisionOption(draft: DecisionDraft, rowId: string, newRowId: NewRowId = defaultRowId): DecisionDraft {
  return mapRow(draft, rowId, (row) => ({
    ...row,
    options: [...row.options, { rowId: newRowId(), label: emptyText, description: null }],
  }));
}

export function updateDecisionOption(
  draft: DecisionDraft,
  rowId: string,
  optionRowId: string,
  patch: Partial<Pick<DecisionOptionRow, "label" | "description">>,
): DecisionDraft {
  return mapRow(draft, rowId, (row) => ({
    ...row,
    options: row.options.map((option) => (option.rowId === optionRowId ? { ...option, ...patch } : option)),
  }));
}

export function removeDecisionOption(draft: DecisionDraft, rowId: string, optionRowId: string): DecisionDraft {
  return mapRow(draft, rowId, (row) => ({ ...row, options: row.options.filter((option) => option.rowId !== optionRowId) }));
}

export function moveDecisionOption(draft: DecisionDraft, rowId: string, optionRowId: string, toIndex: number): DecisionDraft {
  return mapRow(draft, rowId, (row) => {
    const from = row.options.findIndex((option) => option.rowId === optionRowId);
    if (from < 0 || toIndex < 0 || toIndex >= row.options.length) return row;
    const options = [...row.options];
    const [option] = options.splice(from, 1);
    options.splice(toIndex, 0, option!);
    return { ...row, options };
  });
}
