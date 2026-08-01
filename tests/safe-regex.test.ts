import assert from "node:assert/strict";
import test from "node:test";

import {
  CHECK_SCHEMA_VERSION,
  evaluateCheck,
  parseCheckDefinition,
} from "../packages/core/src/checks.ts";
import {
  executeSafeRegex,
  MAX_SAFE_REGEX_INPUT_LENGTH,
  MAX_SAFE_REGEX_PATTERN_LENGTH,
  validateSafeRegex,
} from "../packages/core/src/safe-regex.ts";
import type { SafeRegexDefinition } from "../packages/core/src/safe-regex.ts";

const definition = (
  pattern: string,
  flags?: string,
): SafeRegexDefinition => ({
  syntax: "re2",
  pattern,
  ...(flags === undefined ? {} : { flags }),
});

function matchedText(pattern: string, input: string, flags?: string): string | undefined {
  const result = executeSafeRegex(definition(pattern, flags), input);
  assert.ok(
    result.status === "matched" || result.status === "not-matched",
    JSON.stringify(result),
  );
  return result.status === "matched" ? result.match.text : undefined;
}

test("Safe Regex v1 is check vocabulary version 2 with an explicit dialect", () => {
  assert.equal(CHECK_SCHEMA_VERSION, 2);
  assert.deepEqual(
    parseCheckDefinition({
      checkId: "check_safe_regex",
      kind: "regex",
      syntax: "re2",
      pattern: "answer",
    }),
    {
      checkId: "check_safe_regex",
      kind: "regex",
      syntax: "re2",
      pattern: "answer",
    },
  );
  assert.throws(
    () =>
      parseCheckDefinition({
        checkId: "check_missing_dialect",
        kind: "regex",
        pattern: "answer",
      }),
    /Safe regex syntax must be re2/,
  );
  assert.throws(
    () =>
      parseCheckDefinition({
        checkId: "check_wrong_dialect",
        kind: "regex",
        syntax: "javascript",
        pattern: "answer",
      }),
    /Safe regex syntax must be re2/,
  );
});

test("conforms on ordinary RE2 search syntax", () => {
  const cases: Array<{
    name: string;
    pattern: string;
    input: string;
    match: string | undefined;
  }> = [
    { name: "literal search", pattern: "answer", input: "The answer is 42.", match: "answer" },
    { name: "anchors", pattern: "^answer$", input: "answer", match: "answer" },
    { name: "alternation", pattern: "red|blue", input: "deep blue", match: "blue" },
    { name: "character class", pattern: "[0-9]+", input: "item 42", match: "42" },
    { name: "capturing group", pattern: "(ab)+", input: "zababz", match: "abab" },
    { name: "non-capturing group", pattern: "(?:ab)+", input: "zababz", match: "abab" },
    { name: "greedy repetition", pattern: "a+", input: "aaaa", match: "aaaa" },
    { name: "lazy repetition", pattern: "a+?", input: "aaaa", match: "a" },
    { name: "missing search", pattern: "green", input: "deep blue", match: undefined },
  ];

  for (const fixture of cases) {
    assert.equal(
      matchedText(fixture.pattern, fixture.input),
      fixture.match,
      fixture.name,
    );
  }
});

test("supports only the agreed flags and always uses Unicode semantics", () => {
  assert.equal(matchedText("answer", "ANSWER", "i"), "ANSWER");
  assert.equal(matchedText("^second$", "first\nsecond", "m"), "second");
  assert.equal(matchedText("first.second", "first\nsecond", "s"), "first\nsecond");
  assert.equal(matchedText("^.$", "👋"), "👋");

  for (const flags of ["g", "u", "ii", "x"]) {
    assert.match(
      validateSafeRegex(definition("answer", flags))?.message ?? "",
      /unique subset of ims/,
      flags,
    );
  }
});

test("supports RE2 inline modifiers inside patterns", () => {
  assert.equal(matchedText("(?i)answer", "ANSWER"), "ANSWER");
  assert.equal(matchedText("(?s)a.b", "a\nb"), "a\nb");
  assert.equal(matchedText("(?U)a+", "aaaa"), "a");
  assert.equal(matchedText("(?i:answer)", "ANSWER"), "ANSWER");
  assert.equal(matchedText("(?i)ANSWER(?-i:case)", "answercase"), "answercase");
});

test("rejects lookaround and backreferences with actionable diagnostics", () => {
  const cases = [
    ["answer(?=!)", /does not support lookahead/],
    ["answer(?!s)", /does not support lookahead/],
    ["(?<=the )answer", /does not support lookbehind/],
    ["(?<!wrong )answer", /does not support lookbehind/],
    ["(answer)\\1", /does not support backreferences/],
    ["(?P<word>answer)\\k<word>", /does not support backreferences/],
  ] as const;

  for (const [pattern, message] of cases) {
    assert.match(validateSafeRegex(definition(pattern))?.message ?? "", message);
    assert.throws(
      () =>
        parseCheckDefinition({
          checkId: "check_unsupported",
          kind: "regex",
          syntax: "re2",
          pattern,
        }),
      message,
    );
  }
});

test("does not mistake escaped text or character-class contents for constructs", () => {
  assert.equal(validateSafeRegex(definition(String.raw`\\1`)), undefined);
  assert.equal(validateSafeRegex(definition(String.raw`[(?=]`)), undefined);
});

test("enforces authored-pattern and checkable-output limits", () => {
  assert.equal(
    validateSafeRegex(definition("a".repeat(MAX_SAFE_REGEX_PATTERN_LENGTH))),
    undefined,
  );
  assert.match(
    validateSafeRegex(
      definition("a".repeat(MAX_SAFE_REGEX_PATTERN_LENGTH + 1)),
    )?.message ?? "",
    new RegExp(String(MAX_SAFE_REGEX_PATTERN_LENGTH)),
  );
  assert.throws(
    () =>
      parseCheckDefinition({
        checkId: "check_empty_pattern",
        kind: "regex",
        syntax: "re2",
        pattern: "",
      }),
    /must not be empty/,
  );
  assert.throws(
    () =>
      parseCheckDefinition({
        checkId: "check_large_pattern",
        kind: "regex",
        syntax: "re2",
        pattern: "a".repeat(MAX_SAFE_REGEX_PATTERN_LENGTH + 1),
      }),
    /at most 4096 UTF-16 code units/,
  );

  const atLimit = executeSafeRegex(
    definition("z$"),
    `${"a".repeat(MAX_SAFE_REGEX_INPUT_LENGTH - 1)}z`,
  );
  assert.equal(atLimit.status, "matched");

  const overLimit = executeSafeRegex(
    definition("z$"),
    `${"a".repeat(MAX_SAFE_REGEX_INPUT_LENGTH)}z`,
  );
  assert.deepEqual(overLimit, {
    status: "input-too-large",
    limit: MAX_SAFE_REGEX_INPUT_LENGTH,
    actual: MAX_SAFE_REGEX_INPUT_LENGTH + 1,
  });

  const outcome = evaluateCheck(
    parseCheckDefinition({
      checkId: "check_output_bound",
      kind: "regex",
      syntax: "re2",
      pattern: "z$",
    }),
    { output: `${"a".repeat(MAX_SAFE_REGEX_INPUT_LENGTH)}z` },
  );
  assert.equal(outcome.status, "not-evaluated");
  assert.match(
    outcome.status === "not-evaluated" ? outcome.reason : "",
    /Safe regex checks support at most 1000000/,
  );
});

test(
  "completes a catastrophic-backtracking fixture within the bounded test budget",
  { timeout: 2_000 },
  () => {
    const input = `${"a".repeat(100_000)}!`;
    const result = executeSafeRegex(definition("(a+)+$"), input);
    assert.deepEqual(result, { status: "not-matched" });
  },
);
