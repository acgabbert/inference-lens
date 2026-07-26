import type { PromptTemplateContent } from "./project.ts";

export const TEMPLATE_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type TemplateContentLocation =
  | { kind: "fragment" }
  | {
      kind: "message";
      messageIndex: number;
      role: "system" | "user" | "assistant";
    };

export interface TemplateVariableOccurrence {
  name: string;
  location: TemplateContentLocation;
  start: number;
  end: number;
}

export interface TemplateVariable {
  name: string;
  occurrences: TemplateVariableOccurrence[];
}

export interface InvalidTemplateTokenDiagnostic {
  code: "invalid-template-token";
  token: string;
  location: TemplateContentLocation;
  start: number;
  end: number;
  message: string;
}

export interface MissingTemplateVariableDiagnostic {
  code: "missing-template-variable";
  name: string;
  occurrences: TemplateVariableOccurrence[];
  message: string;
}

export type TemplateDiagnostic =
  | InvalidTemplateTokenDiagnostic
  | MissingTemplateVariableDiagnostic;

type ParsedTemplatePart =
  | { kind: "text"; text: string }
  | {
      kind: "variable";
      occurrence: TemplateVariableOccurrence;
    };

interface ParsedTemplateText {
  parts: ParsedTemplatePart[];
  occurrences: TemplateVariableOccurrence[];
  diagnostics: InvalidTemplateTokenDiagnostic[];
}

export interface DiscoveredTemplateVariables {
  variables: TemplateVariable[];
  diagnostics: InvalidTemplateTokenDiagnostic[];
}

/**
 * Rendering always produces text. An unresolved token is not an error the
 * engine can decide on its own: a project being authored may legitimately hold
 * a variable that a run supplies later. Callers apply their own policy to the
 * returned diagnostics instead of choosing between text and a failure.
 */
export interface RenderTemplateTextResult {
  text: string;
  occurrences: TemplateVariableOccurrence[];
  diagnostics: TemplateDiagnostic[];
}

export interface RenderTemplateContentResult {
  content:
    | { kind: "fragment"; text: string }
    | {
        kind: "messages";
        messages: Array<{
          role: "system" | "user" | "assistant";
          content: string;
        }>;
      };
  variables: TemplateVariable[];
  diagnostics: TemplateDiagnostic[];
}

function appendText(parts: ParsedTemplatePart[], text: string): void {
  if (!text) return;
  const previous = parts.at(-1);
  if (previous?.kind === "text") previous.text += text;
  else parts.push({ kind: "text", text });
}

function parseTemplateText(
  text: string,
  location: TemplateContentLocation,
): ParsedTemplateText {
  const parts: ParsedTemplatePart[] = [];
  const occurrences: TemplateVariableOccurrence[] = [];
  const diagnostics: InvalidTemplateTokenDiagnostic[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    if (text.startsWith("\\{{", cursor)) {
      appendText(parts, "{{");
      cursor += 3;
      continue;
    }

    if (!text.startsWith("{{", cursor)) {
      appendText(parts, text[cursor]!);
      cursor += 1;
      continue;
    }

    const close = text.indexOf("}}", cursor + 2);
    if (close < 0) {
      appendText(parts, text.slice(cursor));
      break;
    }

    const end = close + 2;
    const token = text.slice(cursor, end);
    const name = text.slice(cursor + 2, close);
    if (!TEMPLATE_VARIABLE_NAME_PATTERN.test(name)) {
      diagnostics.push({
        code: "invalid-template-token",
        token,
        location,
        start: cursor,
        end,
        message: `Invalid template token "${token}".`,
      });
      appendText(parts, token);
      cursor = end;
      continue;
    }

    const occurrence: TemplateVariableOccurrence = {
      name,
      location,
      start: cursor,
      end,
    };
    occurrences.push(occurrence);
    parts.push({ kind: "variable", occurrence });
    cursor = end;
  }

  return { parts, occurrences, diagnostics };
}

function groupVariables(
  occurrences: TemplateVariableOccurrence[],
): TemplateVariable[] {
  const grouped = new Map<string, TemplateVariableOccurrence[]>();
  for (const occurrence of occurrences) {
    const existing = grouped.get(occurrence.name);
    if (existing) existing.push(occurrence);
    else grouped.set(occurrence.name, [occurrence]);
  }
  return [...grouped].map(([name, variableOccurrences]) => ({
    name,
    occurrences: variableOccurrences,
  }));
}

function parsedContent(content: PromptTemplateContent): ParsedTemplateText[] {
  if (content.kind === "fragment") {
    return [parseTemplateText(content.text, { kind: "fragment" })];
  }
  return content.messages.map((message, messageIndex) =>
    parseTemplateText(message.content, {
      kind: "message",
      messageIndex,
      role: message.role,
    }),
  );
}

export function discoverTemplateVariables(
  content: PromptTemplateContent,
): DiscoveredTemplateVariables {
  const parsed = parsedContent(content);
  return {
    variables: groupVariables(parsed.flatMap(({ occurrences }) => occurrences)),
    diagnostics: parsed.flatMap(({ diagnostics }) => diagnostics),
  };
}

function hasValue(
  values: Readonly<Record<string, string>>,
  name: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(values, name);
}

function renderParsedText(
  parsed: ParsedTemplateText,
  values: Readonly<Record<string, string>>,
): RenderTemplateTextResult {
  const diagnostics: TemplateDiagnostic[] = [...parsed.diagnostics];
  const missing = groupVariables(
    parsed.occurrences.filter(({ name }) => !hasValue(values, name)),
  );
  diagnostics.push(
    ...missing.map(
      ({ name, occurrences }): MissingTemplateVariableDiagnostic => ({
        code: "missing-template-variable",
        name,
        occurrences,
        message: `Template variable "${name}" has no value.`,
      }),
    ),
  );
  return {
    // An unresolved variable renders as its own token so the gap stays visible
    // in the composer and in the provider request, instead of collapsing to the
    // empty string that an intentionally blank value already produces.
    text: parsed.parts
      .map((part) => {
        if (part.kind === "text") return part.text;
        const { name } = part.occurrence;
        return hasValue(values, name) ? values[name]! : `{{${name}}}`;
      })
      .join(""),
    occurrences: parsed.occurrences,
    diagnostics,
  };
}

export function renderTemplateText(
  text: string,
  values: Readonly<Record<string, string>>,
  location: TemplateContentLocation = { kind: "fragment" },
): RenderTemplateTextResult {
  return renderParsedText(parseTemplateText(text, location), values);
}

export function renderTemplateContent(
  content: PromptTemplateContent,
  values: Readonly<Record<string, string>>,
): RenderTemplateContentResult {
  const parsed = parsedContent(content);
  const variables = groupVariables(
    parsed.flatMap(({ occurrences }) => occurrences),
  );
  const rendered = parsed.map((item) => renderParsedText(item, values));
  const diagnostics = rendered.flatMap(({ diagnostics: item }) => item);
  return content.kind === "fragment"
    ? {
        content: { kind: "fragment", text: rendered[0]!.text },
        variables,
        diagnostics,
      }
    : {
        content: {
          kind: "messages",
          messages: content.messages.map((message, index) => ({
            role: message.role,
            content: rendered[index]!.text,
          })),
        },
        variables,
        diagnostics,
      };
}

export function resolveTemplateValues(
  defaults: Readonly<Record<string, string>>,
  useValues: Readonly<Record<string, string>>,
  runOverrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return { ...defaults, ...useValues, ...runOverrides };
}
