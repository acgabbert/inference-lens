import assert from "node:assert/strict";
import test from "node:test";

import {
  blockingEnvironmentDiagnostics,
  ENVIRONMENT_LIMITS,
  environmentIssues,
  resolveEnvironment,
} from "../packages/core/src/environment.ts";
import type { ProjectEnvironment } from "../packages/core/src/environment.ts";

function environment(
  entries: Array<[string, string]>,
  name = "Staging",
): ProjectEnvironment {
  return {
    id: `environment_${name.toLowerCase()}`,
    name,
    entries: entries.map(([entryName, value]) => ({ name: entryName, value })),
  };
}

test("resolves derived entries in dependency order, not authored order", () => {
  const resolved = resolveEnvironment(
    environment([
      ["greeting", "Hello {{customer}} from {{region}}"],
      ["region", "{{country}}-west"],
      ["customer", "Acme"],
      ["country", "us"],
    ]),
  );

  assert.deepEqual(resolved.values, {
    greeting: "Hello Acme from us-west",
    region: "us-west",
    customer: "Acme",
    country: "us",
  });
  assert.deepEqual(resolved.diagnostics, []);
  assert.equal(resolved.environmentId, "environment_staging");
  assert.equal(resolved.name, "Staging");
});

test("a resolved value is literal and is not scanned again", () => {
  const resolved = resolveEnvironment(
    environment([
      ["outer", "[{{inner}}]"],
      ["inner", "\\{{customer}}"],
      ["customer", "Acme"],
    ]),
  );

  assert.equal(resolved.values.inner, "{{customer}}");
  assert.equal(resolved.values.outer, "[{{customer}}]");
  assert.deepEqual(resolved.diagnostics, []);
});

test("a missing reference renders as its token with a diagnostic", () => {
  const resolved = resolveEnvironment(
    environment([["greeting", "Hello {{ customer }} and {{customer}}"]]),
  );

  assert.equal(resolved.values.greeting, "Hello {{customer}} and {{customer}}");
  assert.deepEqual(
    resolved.diagnostics.map(({ code, entryName, ...rest }) => ({
      code,
      entryName,
      reference: "reference" in rest ? rest.reference : undefined,
    })),
    [{ code: "missing-environment-reference", entryName: "greeting", reference: "customer" }],
  );
});

test("an invalid token is kept verbatim with a diagnostic", () => {
  const resolved = resolveEnvironment(environment([["greeting", "Hi {{not valid}}"]]));

  assert.equal(resolved.values.greeting, "Hi {{not valid}}");
  assert.deepEqual(
    resolved.diagnostics.map(({ code, entryName }) => ({ code, entryName })),
    [{ code: "invalid-environment-token", entryName: "greeting" }],
  );
});

test("exponential expansion stops at the resolved value limit without building the value", () => {
  // e0 is 10 units; each level doubles, so e14 would be 163,840 units.
  const entries: Array<[string, string]> = [["e0", "0123456789"]];
  for (let level = 1; level <= 40; level += 1) {
    entries.push([`e${level}`, `{{e${level - 1}}}{{e${level - 1}}}`]);
  }

  const started = performance.now();
  const resolved = resolveEnvironment(environment(entries));
  const elapsed = performance.now() - started;

  assert.equal(resolved.values.e13?.length, 81_920);
  assert.equal(resolved.values.e14, undefined, "an over-limit value is never truncated or stored");
  assert.equal(resolved.values.e40, undefined);
  assert.deepEqual(
    resolved.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      entryName: diagnostic.entryName,
      limit: "limit" in diagnostic ? diagnostic.limit : undefined,
    })),
    [{ code: "environment-limit-exceeded", entryName: "e14", limit: ENVIRONMENT_LIMITS.resolvedEntryLength }],
  );
  assert.ok(elapsed < 1_000, `resolution took ${elapsed}ms`);
});

test("the whole resolved environment is limited, not only each entry", () => {
  const large = "x".repeat(ENVIRONMENT_LIMITS.authoredEntryValueLength);
  const entries: Array<[string, string]> = Array.from({ length: 20 }, (_, index) => [
    `entry${index}`,
    large,
  ]);

  const resolved = resolveEnvironment(environment(entries));

  // 15 × 65,536 = 983,040 fits; the 16th crosses 1,000,000.
  assert.equal(Object.keys(resolved.values).length, 15);
  assert.deepEqual(
    resolved.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      entryName: diagnostic.entryName,
      limit: "limit" in diagnostic ? diagnostic.limit : undefined,
    })),
    [{ code: "environment-limit-exceeded", entryName: "entry15", limit: ENVIRONMENT_LIMITS.resolvedEnvironmentLength }],
  );
});

test("validation rejects cycles, bad names, duplicates and secret-like entries", () => {
  const issues = environmentIssues([
    environment([
      ["a", "{{b}}"],
      ["b", "{{c}}"],
      ["c", "{{a}}"],
      ["self", "{{self}}"],
      ["fine", "{{a}}"],
    ]),
    environment(
      [
        ["dup", "1"],
        ["dup", "2"],
        ["not-valid", "x"],
        ["api_key", "x"],
      ],
      " staging ",
    ),
    { id: "environment_blank", name: "  ", entries: [] },
  ]);

  assert.deepEqual(
    issues.map(({ path }) => path),
    [
      [0, "entries", 0, "value"],
      [0, "entries", 3, "value"],
      [1, "name"],
      [1, "entries", 1, "name"],
      [1, "entries", 2, "name"],
      [1, "entries", 3, "name"],
      [2, "name"],
    ],
  );
  assert.match(issues[0]!.message, /a → b → c → a/);
  assert.match(issues[1]!.message, /self → self/);
});

test("validation enforces the authored limits", () => {
  const tooMany = environment(
    Array.from({ length: ENVIRONMENT_LIMITS.entriesPerEnvironment + 1 }, (_, index) => [`e${index}`, ""]),
  );
  const tooLong = environment([["big", "x".repeat(ENVIRONMENT_LIMITS.authoredEntryValueLength + 1)]], "Long");
  const environments = Array.from({ length: ENVIRONMENT_LIMITS.environmentsPerProject + 1 }, (_, index) =>
    environment([], `Env ${index}`),
  );

  assert.deepEqual(environmentIssues([tooMany]).map(({ path }) => path), [[0, "entries"]]);
  assert.deepEqual(environmentIssues([tooLong]).map(({ path }) => path), [[0, "entries", 0, "value"]]);
  assert.deepEqual(environmentIssues(environments).map(({ path }) => path), [[]]);
  assert.deepEqual(environmentIssues([environment([["fine", "x"]])]), []);
});

test("only diagnostics a consumed entry depends on block a run", () => {
  const source = environment([
    ["greeting", "Hello {{customer}}"],
    ["customer", "{{missingName}}"],
    ["unused", "{{alsoMissing}}"],
    ["plain", "ok"],
  ]);
  const resolved = resolveEnvironment(source);

  assert.equal(resolved.diagnostics.length, 2);
  assert.deepEqual(
    blockingEnvironmentDiagnostics(source, resolved, ["greeting"]).map(({ entryName }) => entryName),
    ["customer"],
  );
  assert.deepEqual(blockingEnvironmentDiagnostics(source, resolved, ["plain"]), []);
});

test("a limit diagnostic blocks every run", () => {
  const entries: Array<[string, string]> = [["plain", "ok"], ["e0", "0123456789"]];
  for (let level = 1; level <= 20; level += 1) {
    entries.push([`e${level}`, `{{e${level - 1}}}{{e${level - 1}}}`]);
  }
  const source = environment(entries);
  const resolved = resolveEnvironment(source);

  assert.deepEqual(
    blockingEnvironmentDiagnostics(source, resolved, ["plain"]).map(({ code }) => code),
    ["environment-limit-exceeded"],
  );
});
