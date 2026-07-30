import assert from "node:assert/strict";
import test from "node:test";

import {
  parseProjectProfileMap,
  prunedProjectProfileMap,
  resolveMappedProfile,
  withMappedProfile,
  withoutMappedProfile,
} from "../app/project-profile-map.client.ts";

test("a mapping survives as long as the profile it names exists", () => {
  const map = withMappedProfile({}, "project_a", "profile-1");
  assert.deepEqual(map, { project_a: { profileId: "profile-1" } });
  assert.equal(
    resolveMappedProfile(map, "project_a", ["profile-1", "profile-2"]),
    "profile-1",
  );
});

test("a project with no mapping on this device resolves to none", () => {
  const map = withMappedProfile({}, "project_a", "profile-1");
  assert.equal(resolveMappedProfile(map, "project_b", ["profile-1"]), undefined);
});

test("a mapping to a profile this device no longer has resolves to none", () => {
  const map = withMappedProfile({}, "project_a", "profile-gone");
  assert.equal(resolveMappedProfile(map, "project_a", ["profile-1"]), undefined);
});

test("remapping a project replaces its profile without touching others", () => {
  const map = withMappedProfile(
    withMappedProfile({}, "project_a", "profile-1"),
    "project_b",
    "profile-2",
  );
  assert.deepEqual(withMappedProfile(map, "project_a", "profile-2"), {
    project_a: { profileId: "profile-2" },
    project_b: { profileId: "profile-2" },
  });
});

test("a deleted profile releases every project mapped to it", () => {
  const map = {
    project_a: { profileId: "profile-1" },
    project_b: { profileId: "profile-2" },
    project_c: { profileId: "profile-1" },
  };
  assert.deepEqual(withoutMappedProfile(map, "profile-1"), {
    project_b: { profileId: "profile-2" },
  });
});

test("pruning drops entries naming profiles that are gone", () => {
  const map = {
    project_a: { profileId: "profile-1" },
    project_b: { profileId: "profile-gone" },
  };
  assert.deepEqual(prunedProjectProfileMap(map, ["profile-1"]), {
    project_a: { profileId: "profile-1" },
  });
});

test("pruning against no known profiles keeps the map intact", () => {
  // An empty profile list means the caller has nothing to check against, which
  // is the state before the profile list is restored. Treating it as "every
  // profile is gone" would erase real choices on load.
  const map = { project_a: { profileId: "profile-1" } };
  assert.deepEqual(prunedProjectProfileMap(map, []), map);
});

test("malformed stored entries are dropped rather than trusted", () => {
  assert.deepEqual(
    parseProjectProfileMap({
      project_a: { profileId: "profile-1" },
      project_b: { profileId: 7 },
      project_c: "profile-2",
      project_d: null,
    }),
    { project_a: { profileId: "profile-1" } },
  );
  assert.deepEqual(parseProjectProfileMap(null), {});
  assert.deepEqual(parseProjectProfileMap("nonsense"), {});
});

test("stored entries keep only the fields the mapping defines", () => {
  assert.deepEqual(
    parseProjectProfileMap({
      project_a: { profileId: "profile-1", apiKey: "should-never-be-here" },
    }),
    { project_a: { profileId: "profile-1" } },
  );
});
