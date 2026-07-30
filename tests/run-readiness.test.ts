import assert from "node:assert/strict";
import test from "node:test";

import {
  runEmptyStatePresentation,
  runReadiness,
} from "../app/run-readiness.client.ts";

const ready = {
  projectOpen: true,
  connectionMapped: true,
  activeProfileName: "Local llama",
  activeProfileEndpoint: "http://127.0.0.1:8080/v1",
  activeProfileModel: "qwen3-8b",
  requiredEndpoint: "http://127.0.0.1:8080/v1",
  activeConnectionRequirementId: "connection_local",
  selectedToolCount: 0,
  toolsEnabled: true,
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
      activeProfileModel: "qwen3-8b",
      selectedToolCount: 0,
      toolsEnabled: true,
      templateIssues: [],
    }),
    undefined,
    "an ad hoc session has no connection requirement to satisfy",
  );
});

test("a profile with no endpoint sends the user to enter one", () => {
  const readiness = runReadiness({ ...ready, activeProfileEndpoint: "  " });
  assert.equal(readiness?.blocked, true);
  assert.match(readiness?.headline ?? "", /no endpoint configured/);
  assert.deepEqual(
    readiness?.actions.map(({ kind }) => kind),
    ["open-connections"],
  );
  assert.deepEqual(readiness?.actions[0]?.destination, {
    surface: "connections",
    control: "endpoint",
  });
});

test("a missing endpoint outranks a missing model", () => {
  const readiness = runReadiness({
    ...ready,
    activeProfileEndpoint: "",
    activeProfileModel: "",
  });
  assert.match(readiness?.headline ?? "", /no endpoint configured/);
});

test("a profile with no model sends the user to the picker", () => {
  const readiness = runReadiness({ ...ready, activeProfileModel: "  " });
  assert.equal(readiness?.blocked, true);
  assert.match(readiness?.headline ?? "", /no model selected/);
  assert.deepEqual(
    readiness?.actions.map(({ kind }) => kind),
    ["open-connections"],
  );
});

test("an unmapped project outranks a missing model", () => {
  // Both are true of a freshly prefilled server-default profile, and only one
  // of them is the first thing to do about it.
  const readiness = runReadiness({
    ...ready,
    connectionMapped: false,
    activeProfileModel: "",
  });
  assert.match(readiness?.headline ?? "", /not connected to a local profile/);
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

  assert.equal(readiness?.actions[0]?.label, 'Map "Untitled profile"');
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

test("a template blocker names the exact variable to focus", () => {
  const readiness = runReadiness({
    ...ready,
    templateIssues: [{ templateUseId: "template-use_a", variableName: "topic" }],
  });

  assert.deepEqual(readiness?.actions[0]?.destination, {
    surface: "request",
    tab: "messages",
    control: "template-variable",
    entityId: "template-use_a",
    fieldName: "topic",
  });
});

test("the idle response derives its next action from readiness", () => {
  const blocked = runReadiness({ ...ready, activeProfileModel: "" });
  assert.deepEqual(runEmptyStatePresentation(blocked), {
    headline: "Choose a model",
    detail: 'Choose one in Connections — the picker lists what this provider serves.',
    action: blocked?.actions[0],
  });
  assert.deepEqual(runEmptyStatePresentation(undefined), {
    headline: "Ready when you are",
    detail: "Run the request to see its response here.",
  });
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

test("selected tools block a profile that cannot send them", () => {
  const readiness = runReadiness({
    ...ready,
    selectedToolCount: 2,
    toolsEnabled: false,
  });

  assert.equal(readiness?.blocked, true);
  assert.equal(readiness?.headline, "2 selected tools cannot be sent");
  assert.deepEqual(
    readiness?.actions.map(({ kind }) => kind),
    ["open-connections", "review-tools"],
  );
});

test("a differing template model is advisory and keeps the run target authoritative", () => {
  const readiness = runReadiness({
    ...ready,
    templateTargets: [
      {
        templateName: "Classifier",
        connectionRequirementId: "connection_local",
        connectionRequirementName: "Local",
        model: "qwen3-14b",
      },
    ],
  });

  assert.equal(readiness?.blocked, false);
  assert.match(readiness?.headline ?? "", /recommends another model/);
  assert.match(readiness?.detail ?? "", /run will use qwen3-8b/i);
  assert.deepEqual(
    readiness?.actions.map(({ kind }) => kind),
    ["open-connections", "edit-template"],
  );
});

test("conflicting template recommendations are visible without guessing a winner", () => {
  const readiness = runReadiness({
    ...ready,
    templateTargets: [
      {
        templateName: "Planner",
        connectionRequirementId: "connection_local",
        connectionRequirementName: "Local",
        model: "qwen3-14b",
      },
      {
        templateName: "Writer",
        connectionRequirementId: "connection_local",
        connectionRequirementName: "Local",
        model: "llama-4",
      },
    ],
  });

  assert.equal(readiness?.blocked, false);
  assert.match(readiness?.headline ?? "", /different run targets/);
  assert.deepEqual(
    readiness?.facts.map(({ value }) => value),
    ["Local · qwen3-14b", "Local · llama-4"],
  );
  assert.equal(readiness?.actions[0]?.kind, "edit-template");
});

test("tool capability block outranks an endpoint advisory", () => {
  const readiness = runReadiness({
    ...ready,
    requiredEndpoint: "https://api.openai.com/v1",
    selectedToolCount: 1,
    toolsEnabled: false,
  });

  assert.equal(readiness?.headline, "1 selected tool cannot be sent");
  assert.equal(readiness?.blocked, true);
});
