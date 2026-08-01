import { RE2JS } from "re2js";

/** The serialized dialect identifier for the first safe-regex contract. */
export const SAFE_REGEX_SYNTAX = "re2" as const;

/**
 * Safe Regex v1 bounds work before a pattern reaches the engine. Lengths use
 * JavaScript string (UTF-16 code-unit) semantics so every supported runtime
 * applies the boundary without first allocating an array of code points.
 */
export const MAX_SAFE_REGEX_PATTERN_LENGTH = 4_096;
export const MAX_SAFE_REGEX_INPUT_LENGTH = 1_000_000;

export const SAFE_REGEX_FLAGS = ["i", "m", "s"] as const;

export type SafeRegexSyntax = typeof SAFE_REGEX_SYNTAX;
export type SafeRegexFlag = (typeof SAFE_REGEX_FLAGS)[number];

export interface SafeRegexDefinition {
  syntax: SafeRegexSyntax;
  pattern: string;
  /** A unique subset of `ims`. Unicode semantics are always enabled. */
  flags?: string;
}

export type SafeRegexValidationCode =
  | "unsupported-syntax"
  | "empty-pattern"
  | "pattern-too-large"
  | "unsupported-flags"
  | "lookahead"
  | "lookbehind"
  | "backreference"
  | "invalid-syntax";

export interface SafeRegexValidationIssue {
  code: SafeRegexValidationCode;
  field: "syntax" | "pattern" | "flags";
  message: string;
}

export interface SafeRegexMatch {
  /** Matched text. It is used only to measure evidence and is never persisted. */
  text: string;
  /** UTF-16 offset, matching String.prototype.slice. */
  index: number;
}

export type SafeRegexExecution =
  | { status: "matched"; match: SafeRegexMatch }
  | { status: "not-matched" }
  | { status: "invalid"; issue: SafeRegexValidationIssue }
  | { status: "input-too-large"; limit: number; actual: number };

const allowedFlagSet = new Set<string>(SAFE_REGEX_FLAGS);
const MAX_COMPILED_EXPRESSION_CACHE_SIZE = 256;
const compiledExpressionCache = new Map<string, RE2JS>();

function flagIssue(flags: string): SafeRegexValidationIssue | undefined {
  if (
    Array.from(flags).every((flag) => allowedFlagSet.has(flag)) &&
    new Set(flags).size === flags.length
  ) {
    return undefined;
  }
  return {
    code: "unsupported-flags",
    field: "flags",
    message: `Safe regex flags must be a unique subset of ${SAFE_REGEX_FLAGS.join("")}. Unicode semantics are always enabled.`,
  };
}

/**
 * Identifies constructs for which Safe Regex promises an actionable message.
 * The scan understands escaping and character classes; it does not attempt to
 * parse the whole expression, which remains the selected engine's job.
 */
function unsupportedConstruct(
  pattern: string,
): SafeRegexValidationIssue | undefined {
  let inCharacterClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "\\") {
      const escaped = pattern[index + 1];
      if (!inCharacterClass && escaped && /[1-9]/.test(escaped)) {
        return {
          code: "backreference",
          field: "pattern",
          message:
            "Safe regex does not support backreferences. Use another check for the repeated-value assertion.",
        };
      }
      if (!inCharacterClass && escaped === "k" && pattern[index + 2] === "<") {
        return {
          code: "backreference",
          field: "pattern",
          message:
            "Safe regex does not support backreferences. Use another check for the repeated-value assertion.",
        };
      }
      index += 1;
      continue;
    }
    if (character === "[" && !inCharacterClass) {
      inCharacterClass = true;
      continue;
    }
    if (character === "]" && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }
    if (inCharacterClass || character !== "(" || pattern[index + 1] !== "?") {
      continue;
    }
    const operator = pattern[index + 2];
    if (operator === "=" || operator === "!") {
      return {
        code: "lookahead",
        field: "pattern",
        message:
          "Safe regex does not support lookahead. Express the conditions as multiple checks.",
      };
    }
    if (operator === "<" && ["=", "!"].includes(pattern[index + 3] ?? "")) {
      return {
        code: "lookbehind",
        field: "pattern",
        message:
          "Safe regex does not support lookbehind. Express the conditions as multiple checks.",
      };
    }
  }
  return undefined;
}

function engineFlags(flags: string): number {
  let compiled = 0;
  if (flags.includes("i")) compiled |= RE2JS.CASE_INSENSITIVE;
  if (flags.includes("m")) compiled |= RE2JS.MULTILINE;
  if (flags.includes("s")) compiled |= RE2JS.DOTALL;
  return compiled;
}

function compiledExpression(pattern: string, flags: string): RE2JS {
  const cacheKey = JSON.stringify([pattern, flags]);
  const cached = compiledExpressionCache.get(cacheKey);
  if (cached) {
    // Refresh insertion order so the bounded cache evicts the least recently
    // used expression rather than a frequently evaluated one.
    compiledExpressionCache.delete(cacheKey);
    compiledExpressionCache.set(cacheKey, cached);
    return cached;
  }

  const expression = RE2JS.compile(pattern, engineFlags(flags));
  compiledExpressionCache.set(cacheKey, expression);
  if (compiledExpressionCache.size > MAX_COMPILED_EXPRESSION_CACHE_SIZE) {
    const oldestKey = compiledExpressionCache.keys().next().value;
    if (oldestKey !== undefined) compiledExpressionCache.delete(oldestKey);
  }
  return expression;
}

function compile(
  definition: SafeRegexDefinition,
): { expression: RE2JS } | { issue: SafeRegexValidationIssue } {
  const { pattern, flags = "" } = definition;
  if (definition.syntax !== SAFE_REGEX_SYNTAX) {
    return {
      issue: {
        code: "unsupported-syntax",
        field: "syntax",
        message: `Safe regex syntax must be ${SAFE_REGEX_SYNTAX}.`,
      },
    };
  }
  if (pattern.length === 0) {
    return {
      issue: {
        code: "empty-pattern",
        field: "pattern",
        message: "Safe regex patterns must not be empty.",
      },
    };
  }
  if (pattern.length > MAX_SAFE_REGEX_PATTERN_LENGTH) {
    return {
      issue: {
        code: "pattern-too-large",
        field: "pattern",
        message: `Safe regex patterns must be at most ${MAX_SAFE_REGEX_PATTERN_LENGTH} UTF-16 code units.`,
      },
    };
  }
  const invalidFlags = flagIssue(flags);
  if (invalidFlags) return { issue: invalidFlags };
  const unsupported = unsupportedConstruct(pattern);
  if (unsupported) return { issue: unsupported };

  try {
    return { expression: compiledExpression(pattern, flags) };
  } catch {
    return {
      issue: {
        code: "invalid-syntax",
        field: "pattern",
        message: "Expected valid RE2-compatible Safe regex syntax.",
      },
    };
  }
}

/** Validates the complete Safe Regex v1 contract. */
export function validateSafeRegex(
  definition: SafeRegexDefinition,
): SafeRegexValidationIssue | undefined {
  const compiled = compile(definition);
  return "issue" in compiled ? compiled.issue : undefined;
}

/**
 * Searches an input with the Safe Regex v1 contract. No JavaScript RegExp
 * fallback is permitted: invalid definitions remain invalid.
 */
export function executeSafeRegex(
  definition: SafeRegexDefinition,
  input: string,
): SafeRegexExecution {
  const compiled = compile(definition);
  if ("issue" in compiled) return { status: "invalid", issue: compiled.issue };
  if (input.length > MAX_SAFE_REGEX_INPUT_LENGTH) {
    return {
      status: "input-too-large",
      limit: MAX_SAFE_REGEX_INPUT_LENGTH,
      actual: input.length,
    };
  }
  const match = compiled.expression.exec(input);
  if (match === null) return { status: "not-matched" };
  const indexedMatch = match as Array<unknown> & { index: number };
  return {
    status: "matched",
    match: { text: String(indexedMatch[0] ?? ""), index: indexedMatch.index },
  };
}
