import { z } from "zod";

/**
 * Providers accept a narrow character class for a function name. OpenAI and
 * Anthropic both document `^[a-zA-Z0-9_-]{1,64}$`. A name outside it is
 * rejected at request time by servers that validate, and mangled by servers
 * that don't: a chat template emitting the name into a delimited or
 * grammar-constrained tool-call format can return a truncated name that
 * matches no tool we sent.
 */
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export const TOOL_NAME_REQUIREMENT =
  "Use 1–64 letters, digits, underscores, or dashes — no spaces.";

export function isValidToolName(name: string): boolean {
  return TOOL_NAME_PATTERN.test(name);
}

export const toolNameSchema = z
  .string()
  .regex(TOOL_NAME_PATTERN, TOOL_NAME_REQUIREMENT);
