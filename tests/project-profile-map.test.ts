import assert from "node:assert/strict";
import test from "node:test";

import {
  parseProjectProfileMap,
  prunedProjectProfileMap,
  resolveMappedProfile,
  withMappedProfile,
  withoutMappedProfile,
} from "../app/project-profile-map.client.ts";

const profile = (id: string, instanceId = `${id}-instance`) => ({
  id,
  instanceId,
});

test("a mapping survives as long as the profile it names exists", () => {
  const map = withMappedProfile({}, "project_a", profile("profile-1"));
  assert.deepEqual(map, {
    project_a: {
      profileId: "profile-1",
      profileInstanceId: "profile-1-instance",
    },
  });
  assert.equal(
    resolveMappedProfile(map, "project_a", [
      profile("profile-1"),
      profile("profile-2"),
    ]),
    "profile-1",
  );
});

test("a project with no mapping on this device resolves to none", () => {
  const map = withMappedProfile({}, "project_a", profile("profile-1"));
  assert.equal(
    resolveMappedProfile(map, "project_b", [profile("profile-1")]),
    undefined,
  );
});

test("a mapping to a profile this device no longer has resolves to none", () => {
  const map = withMappedProfile({}, "project_a", profile("profile-gone"));
  assert.equal(
    resolveMappedProfile(map, "project_a", [profile("profile-1")]),
    undefined,
  );
});

test("a reused profile id does not inherit another instance's mapping", () => {
  const map = withMappedProfile(
    {},
    "project_a",
    profile("server-default", "old-instance"),
  );
  assert.equal(
    resolveMappedProfile(map, "project_a", [
      profile("server-default", "new-instance"),
    ]),
    undefined,
  );
});

test("remapping a project replaces its profile without touching others", () => {
  const map = withMappedProfile(
    withMappedProfile({}, "project_a", profile("profile-1")),
    "project_b",
    profile("profile-2"),
  );
  assert.deepEqual(withMappedProfile(map, "project_a", profile("profile-2")), {
    project_a: {
      profileId: "profile-2",
      profileInstanceId: "profile-2-instance",
    },
    project_b: {
      profileId: "profile-2",
      profileInstanceId: "profile-2-instance",
    },
  });
});

test("a deleted profile releases every project mapped to it", () => {
  const map = {
    project_a: {
      profileId: "profile-1",
      profileInstanceId: "profile-1-instance",
    },
    project_b: {
      profileId: "profile-2",
      profileInstanceId: "profile-2-instance",
    },
    project_c: {
      profileId: "profile-1",
      profileInstanceId: "profile-1-instance",
    },
  };
  assert.deepEqual(withoutMappedProfile(map, "profile-1"), {
    project_b: {
      profileId: "profile-2",
      profileInstanceId: "profile-2-instance",
    },
  });
});

test("pruning drops entries naming profiles that are gone", () => {
  const map = {
    project_a: {
      profileId: "profile-1",
      profileInstanceId: "profile-1-instance",
    },
    project_b: {
      profileId: "profile-gone",
      profileInstanceId: "profile-gone-instance",
    },
  };
  assert.deepEqual(prunedProjectProfileMap(map, [profile("profile-1")]), {
    project_a: {
      profileId: "profile-1",
      profileInstanceId: "profile-1-instance",
    },
  });
});

test("pruning against no known profiles keeps the map intact", () => {
  // An empty profile list means the caller has nothing to check against, which
  // is the state before the profile list is restored. Treating it as "every
  // profile is gone" would erase real choices on load.
  const map = {
    project_a: {
      profileId: "profile-1",
      profileInstanceId: "profile-1-instance",
    },
  };
  assert.deepEqual(prunedProjectProfileMap(map, []), map);
});

test("malformed stored entries are dropped rather than trusted", () => {
  assert.deepEqual(
    parseProjectProfileMap({
      project_a: {
        profileId: "profile-1",
        profileInstanceId: "profile-1-instance",
      },
      project_b: { profileId: 7 },
      project_c: "profile-2",
      project_d: null,
    }),
    {
      project_a: {
        profileId: "profile-1",
        profileInstanceId: "profile-1-instance",
      },
    },
  );
  assert.deepEqual(parseProjectProfileMap(null), {});
  assert.deepEqual(parseProjectProfileMap("nonsense"), {});
});

test("stored entries keep only the fields the mapping defines", () => {
  assert.deepEqual(
    parseProjectProfileMap({
      project_a: {
        profileId: "profile-1",
        profileInstanceId: "profile-1-instance",
        apiKey: "should-never-be-here",
      },
    }),
    {
      project_a: {
        profileId: "profile-1",
        profileInstanceId: "profile-1-instance",
      },
    },
  );
});

test("legacy id-only mappings are invalidated instead of being adopted", () => {
  assert.deepEqual(
    parseProjectProfileMap({
      project_a: { profileId: "openai-compatible" },
    }),
    {},
  );
});
