export type N8nMappingNameSource =
  | "direct-reference"
  | "single-dependency"
  | "surrounding-label"
  | "fallback";

export interface N8nExpressionIdentity {
  key: string;
  directReference?: { canonical: string; terminal: string };
}

const identifier = "[A-Za-z_][A-Za-z0-9_]*";
const directReference = new RegExp(
  `^\\s*(\\$json)((?:(?:\\.${identifier})|(?:\\[\\s*["']${identifier}["']\\s*\\]))*)\\s*$`,
);
const pathSegment = new RegExp(
  `(?:\\.(${identifier})|\\[\\s*["'](${identifier})["']\\s*\\])`,
  "g",
);

function expressionBody(expression: string): string {
  return expression.startsWith("{{") && expression.endsWith("}}")
    ? expression.slice(2, -2)
    : expression;
}

function referenceAt(value: string, start: number): { end: number; canonical: string; terminal: string } | undefined {
  const jsonRoot = value.slice(start, start + 5) === "$json";
  const nodeRoot = /^\$\(\s*(["'])([^"']+)\1\s*\)\.item\.json/.exec(
    value.slice(start),
  );
  if (!jsonRoot && !nodeRoot) return undefined;
  let end = start + (jsonRoot ? 5 : nodeRoot![0].length);
  while (end < value.length) {
    const rest = value.slice(end);
    const dot = new RegExp(`^\\.(${identifier})`).exec(rest);
    const bracket = new RegExp(`^\\[\\s*["'](${identifier})["']\\s*\\]`).exec(rest);
    const match = dot ?? bracket;
    if (!match) break;
    // A property immediately invoked as a method is part of the expression's
    // computation, not a data-path terminal. Keeping the preceding path lets
    // `$json.topic.toUpperCase()` recommend `topic`, never `toUpperCase`.
    if (dot && rest[match[0].length] === "(") break;
    end += match[0].length;
  }
  const raw = value.slice(start, end);
  const segments = Array.from(raw.matchAll(pathSegment)).map((match) => match[1] ?? match[2]!);
  if (segments.length === 0) return undefined;
  const root = jsonRoot ? "$json" : `$(${JSON.stringify(nodeRoot![2])}).item.json`;
  return { end, canonical: `${root}.${segments.join(".")}`, terminal: segments.at(-1)! };
}

export function n8nExpressionIdentity(expression: string): N8nExpressionIdentity {
  const body = expressionBody(expression);
  const direct = directReference.exec(body) || /^\s*\$\(\s*["'][^"']+["']\s*\)\.item\.json/.exec(body);
  if (direct) {
    const reference = referenceAt(body, body.indexOf("$"));
    if (reference && reference.end === body.trimEnd().length) {
      return { key: `reference:${reference.canonical}`, directReference: reference };
    }
  }
  return { key: `verbatim:${expression}` };
}

/** Returns a safe lexical recommendation; it never evaluates the expression. */
export function suggestN8nExpressionName(
  expression: string,
  isSensitive: (name: string) => boolean,
): { name?: string; source: N8nMappingNameSource; identity: N8nExpressionIdentity } {
  const identity = n8nExpressionIdentity(expression);
  if (identity.directReference && !isSensitive(identity.directReference.terminal)) {
    return { name: identity.directReference.terminal, source: "direct-reference", identity };
  }
  const body = expressionBody(expression);
  const dependencies = new Map<string, string>();
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== "$") continue;
    const reference = referenceAt(body, index);
    if (!reference) continue;
    dependencies.set(reference.canonical, reference.terminal);
    index = reference.end - 1;
  }
  if (dependencies.size === 1) {
    const terminal = dependencies.values().next().value as string;
    if (!isSensitive(terminal)) return { name: terminal, source: "single-dependency", identity };
  }
  return { source: "fallback", identity };
}

export function allocateN8nVariableName(
  suggested: string | undefined,
  used: Set<string>,
  fallbackIndex: { value: number },
): string {
  const base = suggested ?? `expression_${++fallbackIndex.value}`;
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}_${suffix}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}
