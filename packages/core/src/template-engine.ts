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

export type RenderTemplateTextResult =
  | { ok: true; text: string; occurrences: TemplateVariableOccurrence[] }
  | { ok: false; diagnostics: TemplateDiagnostic[] };

export type RenderTemplateContentResult =
  | {
      ok: true;
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
    }
  | { ok: false; diagnostics: TemplateDiagnostic[] };

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

function renderParsedText(
  parsed: ParsedTemplateText,
  values: Readonly<Record<string, string>>,
): RenderTemplateTextResult {
  const diagnostics: TemplateDiagnostic[] = [...parsed.diagnostics];
  const missing = groupVariables(
    parsed.occurrences.filter(
      ({ name }) => !Object.prototype.hasOwnProperty.call(values, name),
    ),
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
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  return {
    ok: true,
    text: parsed.parts
      .map((part) =>
        part.kind === "text" ? part.text : values[part.occurrence.name]!,
      )
      .join(""),
    occurrences: parsed.occurrences,
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
  const diagnostics = rendered.flatMap((result) =>
    result.ok ? [] : result.diagnostics,
  );
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const texts = rendered.map((result) => {
    if (!result.ok) throw new Error("Unreachable template render result.");
    return result.text;
  });
  return content.kind === "fragment"
    ? {
        ok: true,
        content: { kind: "fragment", text: texts[0]! },
        variables,
      }
    : {
        ok: true,
        content: {
          kind: "messages",
          messages: content.messages.map((message, index) => ({
            role: message.role,
            content: texts[index]!,
          })),
        },
        variables,
      };
}

export function resolveTemplateValues(
  defaults: Readonly<Record<string, string>>,
  useValues: Readonly<Record<string, string>>,
  runOverrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return { ...defaults, ...useValues, ...runOverrides };
}
