import assert from "node:assert/strict";
import test from "node:test";

import {
  createDefaultProfile,
  nextCapabilityOverrides,
  profileDeletionRefusal,
  removeProfile,
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

function named(id: string): StoredInferenceProfile {
  return { ...createDefaultProfile(), id, name: id };
}

function snapshot(activeProfileId: string, ...ids: string[]) {
  return { profiles: ids.map(named), activeProfileId };
}

test("removing a profile that is not active leaves the selection alone", () => {
  const result = removeProfile(snapshot("a", "a", "b", "c"), "b");

  assert.deepEqual(
    result?.profiles.map(({ id }) => id),
    ["a", "c"],
  );
  assert.equal(result?.activeProfileId, "a");
});

test("removing the active profile selects the one that takes its place", () => {
  const result = removeProfile(snapshot("b", "a", "b", "c"), "b");

  assert.equal(result?.activeProfileId, "c");
});

test("removing the last profile in the list selects the new last one", () => {
  const result = removeProfile(snapshot("c", "a", "b", "c"), "c");

  assert.equal(result?.activeProfileId, "b");
});

test("refuses to remove the only profile, or one that is not there", () => {
  assert.equal(removeProfile(snapshot("a", "a"), "a"), undefined);
  assert.equal(removeProfile(snapshot("a", "a", "b"), "gone"), undefined);
});

test("does not mutate the snapshot it is given", () => {
  const existing = snapshot("b", "a", "b");

  removeProfile(existing, "b");

  assert.deepEqual(
    existing.profiles.map(({ id }) => id),
    ["a", "b"],
  );
  assert.equal(existing.activeProfileId, "b");
});

test("deletion is refused while a profile is the only one left", () => {
  const only = named("a");

  assert.match(
    profileDeletionRefusal([only], only, false) ?? "",
    /At least one connection profile/,
  );
  assert.equal(profileDeletionRefusal([only, named("b")], only, false), undefined);
});

test("a server-provisioned profile is deletable only once unconfigured", () => {
  const provisioned: StoredInferenceProfile = {
    ...named("server-default"),
    credentialRef: "environment-default",
  };
  const profiles = [provisioned, named("b")];

  assert.match(
    profileDeletionRefusal(profiles, provisioned, true) ?? "",
    /INFERENCE_LENS_API_KEY/,
  );
  // Released by the reconcile once the server stops declaring a credential,
  // and from then on it is an ordinary profile.
  assert.equal(profileDeletionRefusal(profiles, provisioned, false), undefined);
});
