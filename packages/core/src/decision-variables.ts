import type { DecisionInput } from "./decision.ts";
import type { JsonValue } from "./run-kernel/types.ts";
import { renderTemplateText } from "./template-engine.ts";
import type { TemplateDiagnostic } from "./template-engine.ts";

/**
 * Native template variables in a decision request (D40). They may appear in
 * string values anywhere in `state` and in each question's `instructions`,
 * never in object keys or criteria: a choice option's label is its key, and a
 * criterion names what an answer means.
 */

/** Where in a decision request a string value sits. */
export type DecisionVariableField =
  | { kind: "state" }
  | { kind: "instructions"; questionId: string };

export interface DecisionTemplateDiagnostic {
  field: DecisionVariableField;
  diagnostic: TemplateDiagnostic;
}

export interface RenderedDecisionInput {
  decision: DecisionInput;
  /** Every variable used, in first-use order. */
  variables: string[];
  /** Per field, as the template engine reports them. */
  diagnostics: DecisionTemplateDiagnostic[];
}

function renderValue(
  value: JsonValue,
  values: Readonly<Record<string, string>>,
  field: DecisionVariableField,
  variables: Set<string>,
  diagnostics: DecisionTemplateDiagnostic[],
): JsonValue {
  if (typeof value === "string") {
    const rendered = renderTemplateText(value, values);
    rendered.occurrences.forEach(({ name }) => variables.add(name));
    diagnostics.push(...rendered.diagnostics.map((diagnostic) => ({ field, diagnostic })));
    return rendered.text;
  }
  if (Array.isArray(value)) {
    return value.map((item) => renderValue(item, values, field, variables, diagnostics));
  }
  if (value === null || typeof value !== "object") return value;
  // Keys are copied as written, in authored order; only values render.
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, renderValue(item, values, field, variables, diagnostics)]),
  );
}

/**
 * Renders every variable-bearing value with `values`. Like the template engine,
 * it always produces a request: an unfilled variable stays as its own token,
 * and the caller applies its own policy to the diagnostics.
 */
export function renderDecisionInput(
  input: DecisionInput,
  values: Readonly<Record<string, string>>,
): RenderedDecisionInput {
  const variables = new Set<string>();
  const diagnostics: DecisionTemplateDiagnostic[] = [];
  const state = renderValue(input.state, values, { kind: "state" }, variables, diagnostics) as DecisionInput["state"];
  const questions = Object.fromEntries(
    Object.entries(input.questions).map(([questionId, question]) => [
      questionId,
      {
        ...question,
        instructions: renderValue(question.instructions, values, { kind: "instructions", questionId }, variables, diagnostics),
      },
    ]),
  ) as DecisionInput["questions"];
  return { decision: { state, questions }, variables: [...variables], diagnostics };
}

/** The variables a request uses, and any token that is not a valid variable. */
export function discoverDecisionVariables(input: DecisionInput): {
  variables: string[];
  diagnostics: DecisionTemplateDiagnostic[];
} {
  // Rendering with every variable filled leaves only the token diagnostics.
  const { variables } = renderDecisionInput(input, {});
  const filled = Object.fromEntries(variables.map((name) => [name, ""]));
  return { variables, diagnostics: renderDecisionInput(input, filled).diagnostics };
}
