import assert from "node:assert/strict";
import test from "node:test";

import { runReadiness } from "../app/run-readiness.client.ts";

const ready = {
  projectOpen: true,
  connectionMapped: true,
  activeProfileName: "Local llama",
  activeProfileEndpoint: "http://127.0.0.1:8080/v1",
  requiredEndpoint: "http://127.0.0.1:8080/v1",
  templateIssues: [],
};

test("a runnable project reports nothing", () => {
  assert.equal(runReadiness(ready), undefined);
  assert.equal(
    runReadiness({
      projectOpen: false,
      connectionMapped: false,
      activeProfileName: "Local llama",
      activeProfileEndpoint: "http://127.0.0.1:8080/v1",
      templateIssues: [],
    }),
    undefined,
    "an ad hoc session has no connection requirement to satisfy",
  );
});

test("an unmapped project names both endpoints and offers the mapping", () => {
  const readiness = runReadiness({
    ...ready,
    connectionMapped: false,
    requiredEndpoint: "https://api.openai.com/v1",
  });

  assert.ok(readiness?.blocked);
  assert.deepEqual(readiness.facts, [
    { label: "Project expects", value: "https://api.openai.com/v1" },
    { label: 'Profile "Local llama"', value: "http://127.0.0.1:8080/v1" },
  ]);
  assert.deepEqual(
    readiness.actions.map(({ kind }) => kind),
    ["map-profile", "open-connections"],
  );
  // The mismatch is the surprising part of this state, so it is said before
  // the user maps a profile, not after the request has gone somewhere else.
  assert.match(readiness.detail, /calls a different endpoint than this project declares/);
  // The rule behind it is held back so the line saying what to do stays first.
  assert.match(readiness.explanation ?? "", /never carries a credential/);
});

test("an unmapped project with a matching endpoint does not warn about a mismatch", () => {
  const readiness = runReadiness({ ...ready, connectionMapped: false });

  assert.ok(readiness?.blocked);
  assert.doesNotMatch(readiness.detail, /different endpoint/);
  assert.equal(readiness.detail, "Choose the local profile it should run against.");
});

test("an untitled profile is still named in the offered action", () => {
  const readiness = runReadiness({
    ...ready,
    connectionMapped: false,
    activeProfileName: "   ",
  });

  assert.equal(readiness?.actions[0]?.label, 'Use "Untitled profile"');
});

test("a missing connection outranks unresolved templates", () => {
  const readiness = runReadiness({
    ...ready,
    connectionMapped: false,
    templateResolutionError: "The pinned revision is missing.",
    templateIssues: [{ templateUseId: "template-use_a", variableName: "topic" }],
  });

  assert.match(readiness?.headline ?? "", /not connected to a local profile/);
});

test("a template resolution failure carries the underlying message", () => {
  const readiness = runReadiness({
    ...ready,
    templateResolutionError: "The pinned revision is missing.",
  });

  assert.ok(readiness?.blocked);
  assert.equal(readiness.detail, "The pinned revision is missing.");
  assert.equal(readiness.summary, "The pinned revision is missing.");
});

test("a variable used in several messages is counted once", () => {
  // Resolution reports one diagnostic per message the variable appears in.
  const readiness = runReadiness({
    ...ready,
    templateIssues: [
      { templateUseId: "template-use_a", variableName: "topic" },
      { templateUseId: "template-use_a", variableName: "audience" },
      { templateUseId: "template-use_a", variableName: "topic" },
    ],
  });

  assert.equal(readiness?.headline, "2 template variables still need a value");
});

test("the same variable name in two uses is two values to supply", () => {
  const readiness = runReadiness({
    ...ready,
    templateIssues: [
      { templateUseId: "template-use_a", variableName: "topic" },
      { templateUseId: "template-use_b", variableName: "topic" },
    ],
  });

  assert.equal(readiness?.headline, "2 template variables still need a value");
});

test("one unresolved variable reads in the singular", () => {
  assert.equal(
    runReadiness({
      ...ready,
      templateIssues: [{ templateUseId: "template-use_a", variableName: "topic" }],
    })?.headline,
    "1 template variable still needs a value",
  );
});

test("a diagnostic naming no variable is reported as an issue, not a variable", () => {
  const readiness = runReadiness({
    ...ready,
    templateIssues: [
      { templateUseId: "template-use_a" },
      { templateUseId: "template-use_a", variableName: "topic" },
    ],
  });

  assert.equal(readiness?.headline, "2 template issues block this conversation");
});

test("a mapped but mismatched endpoint advises without blocking the run", () => {
  const readiness = runReadiness({
    ...ready,
    requiredEndpoint: "https://api.openai.com/v1",
  });

  assert.equal(readiness?.blocked, false);
  assert.deepEqual(readiness?.facts, [
    { label: "Project expects", value: "https://api.openai.com/v1" },
    { label: "Requests go to", value: "http://127.0.0.1:8080/v1" },
  ]);
});
