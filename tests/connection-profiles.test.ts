import assert from "node:assert/strict";
import test from "node:test";

import {
  createDefaultProfile,
  nextCapabilityOverrides,
} from "../app/profile-store.client.ts";
import type { StoredInferenceProfile } from "../app/profile-store.client.ts";

// The openai-compatible baseline enables modelDiscovery and disables tools.
function profile(
  overrides?: StoredInferenceProfile["capabilityOverrides"],
): StoredInferenceProfile {
  return { ...createDefaultProfile(), capabilityOverrides: overrides };
}

test("records only capabilities that differ from the provider baseline", () => {
  assert.deepEqual(nextCapabilityOverrides(profile(), "tools", true), {
    tools: true,
  });
  assert.deepEqual(
    nextCapabilityOverrides(profile(), "modelDiscovery", false),
    { modelDiscovery: false },
  );
});

test("drops an override that returns to the provider baseline", () => {
  assert.equal(
    nextCapabilityOverrides(profile({ tools: true }), "tools", false),
    undefined,
  );
  assert.equal(
    nextCapabilityOverrides(
      profile({ modelDiscovery: false }),
      "modelDiscovery",
      true,
    ),
    undefined,
  );
});

test("keeps unrelated overrides when one returns to the baseline", () => {
  assert.deepEqual(
    nextCapabilityOverrides(
      profile({ tools: true, modelDiscovery: false }),
      "tools",
      false,
    ),
    { modelDiscovery: false },
  );
});

test("re-setting a capability to its current override is a no-op", () => {
  assert.deepEqual(
    nextCapabilityOverrides(profile({ tools: true }), "tools", true),
    { tools: true },
  );
});

test("does not mutate the profile it is given", () => {
  const existing = profile({ tools: true });

  nextCapabilityOverrides(existing, "modelDiscovery", false);

  assert.deepEqual(existing.capabilityOverrides, { tools: true });
});
