import assert from "node:assert/strict";

import {
  executeSafeRegex,
  validateSafeRegex,
} from "../packages/core/src/safe-regex.ts";

const ordinary = executeSafeRegex(
  { syntax: "re2", pattern: "^line", flags: "im" },
  "first\nLine two",
);
assert.equal(ordinary.status, "matched");
assert.equal(
  validateSafeRegex({ syntax: "re2", pattern: "(?=unsafe)" })?.code,
  "lookahead",
);

const adversarial = executeSafeRegex(
  { syntax: "re2", pattern: "(a+)+$" },
  `${"a".repeat(100_000)}!`,
);
assert.deepEqual(adversarial, { status: "not-matched" });

console.log("Safe Regex v1 Node runtime probe passed.");
