import assert from "node:assert/strict";
import test from "node:test";

import {
  requestFromSettings,
  resolveRequestSettings,
} from "../app/request/resolve-request-settings.ts";
import type { RequestSettingsInput } from "../app/request/resolve-request-settings.ts";
import { createProjectFile } from "../packages/core/src/project.ts";
import type { InferenceProfile } from "../packages/core/src/types.ts";

const active: InferenceProfile = {
  id: "active",
  name: "Active",
  provider: "openai-compatible",
  endpoint: "http://active.test/v1",
  model: "active-model",
  temperature: 0.3,
};
const mapped: InferenceProfile = {
  id: "mapped",
  name: "Mapped",
  provider: "openai-compatible",
  endpoint: "http://mapped.test/v1",
  model: "mapped-model",
  temperature: 0.9,
  capabilityOverrides: { streaming: false, tools: true },
};

const project = createProjectFile({
  name: "Settings",
  request: {
    provider: "openai-compatible",
    endpoint: "http://project.test/v1",
    model: "project-model",
    messages: [],
  },
  idSuffix: "settings",
  createdAt: "2026-10-08T12:00:00.000Z",
});
const requirementId = project.defaults.target.connectionRequirementId;

function input(
  overrides: Partial<RequestSettingsInput<InferenceProfile>> = {},
): RequestSettingsInput<InferenceProfile> {
  return {
    projectFile: null,
    mappedProfileIds: {},
    profiles: [active, mapped],
    activeProfile: active,
    sessionModel: undefined,
    sessionTemperature: undefined,
    streamingPreferred: true,
    ...overrides,
  };
}

test("without a project the active profile supplies every value", () => {
  const settings = resolveRequestSettings(input({ sessionTemperature: 1.5 }));
  assert.equal(settings.connectionRequirement, undefined);
  assert.equal(settings.profile, active);
  assert.equal(settings.model, "active-model");
  // There is no session layer to override the profile's temperature.
  assert.equal(settings.temperature, 0.3);
  assert.equal(settings.responseMode, "streaming");
});

test("a project runs on its mapped profile with its session values", () => {
  const settings = resolveRequestSettings(input({
    projectFile: project,
    mappedProfileIds: { [requirementId]: "mapped" },
    sessionModel: "session-model",
    sessionTemperature: undefined,
  }));
  assert.equal(settings.connectionRequirement?.id, requirementId);
  assert.equal(settings.profile, mapped);
  assert.equal(settings.profileMapped, true);
  assert.equal(settings.model, "session-model");
  // An absent session temperature is the provider default, not the profile's.
  assert.equal(settings.temperature, undefined);
  assert.equal(settings.capabilities.tools, true);
  // The preference asks for streaming; the profile cannot stream.
  assert.equal(settings.responseMode, "buffered");
});

test("an unmapped project falls back to the active profile", () => {
  const settings = resolveRequestSettings(input({
    projectFile: project,
    mappedProfileIds: { [requirementId]: "deleted" },
  }));
  assert.equal(settings.profile, active);
  assert.equal(settings.profileMapped, false);
  assert.equal(settings.model, "active-model");
});

test("a buffered preference wins over a streaming profile", () => {
  assert.equal(
    resolveRequestSettings(input({ streamingPreferred: false })).responseMode,
    "buffered",
  );
});

test("the request carries the resolved target and the given messages", () => {
  const messages = [
    { id: "message_m1", role: "user", content: [{ type: "text", text: "Hi" }] },
  ] as Parameters<typeof requestFromSettings>[1];
  const settings = resolveRequestSettings(input({
    projectFile: project,
    mappedProfileIds: { [requirementId]: "mapped" },
    sessionTemperature: 0.5,
  }));
  assert.deepEqual(requestFromSettings(settings, messages), {
    provider: "openai-compatible",
    endpoint: "http://mapped.test/v1",
    model: "mapped-model",
    messages,
    temperature: 0.5,
    responseMode: "buffered",
    capabilities: settings.capabilities,
  });
});
