import assert from "node:assert/strict";
import test from "node:test";

import type { ProjectEnvironment } from "../packages/core/src/environment.ts";
import {
  environmentDraftIssues,
  environmentDraftPreview,
  newEnvironmentName,
} from "../app/environments/environment-draft.ts";

const staging: ProjectEnvironment = {
  id: "environment_staging",
  name: "Staging",
  entries: [
    { name: "customer", value: "Acme" },
    { name: "greeting", value: "Hello {{customer}}" },
  ],
};

test("a draft's issues are located by field, ignoring the saved copy of itself", () => {
  const draft: ProjectEnvironment = {
    ...staging,
    name: "production",
    entries: [
      { name: "customer", value: "{{greeting}}" },
      { name: "greeting", value: "Hello {{customer}}" },
      { name: "api_key", value: "x" },
    ],
  };
  const production = { id: "environment_production" as const, name: "Production", entries: [] };
  const issues = environmentDraftIssues([staging, production], draft);
  assert.equal(issues.name, 'Another environment is already named "production".');
  assert.match(issues.entries[2]?.name ?? "", /secret-like/);
  assert.match(issues.entries[0]?.value ?? "", /cycle: customer → greeting → customer/);
  assert.equal(issues.count, 3);
  assert.equal(environmentDraftIssues([staging], staging).count, 0);
});

test("the preview resolves a valid draft and holds off while it has issues", () => {
  const preview = environmentDraftPreview({
    ...staging,
    entries: [...staging.entries, { name: "farewell", value: "Bye {{nobody}}" }],
  });
  assert.deepEqual(preview?.values, {
    customer: "Acme",
    greeting: "Hello Acme",
    farewell: "Bye {{nobody}}",
  });
  assert.deepEqual(preview?.diagnostics.map(({ entryName }) => entryName), ["farewell"]);

  assert.equal(environmentDraftPreview({
    ...staging,
    entries: [{ name: "a", value: "{{b}}" }, { name: "b", value: "{{a}}" }],
  }), undefined);
});

test("a new environment takes the first free numbered name", () => {
  assert.equal(newEnvironmentName([]), "Environment 1");
  assert.equal(newEnvironmentName([{ ...staging, name: "environment 1" }]), "Environment 2");
});
