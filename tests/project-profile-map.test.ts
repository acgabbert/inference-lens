import assert from "node:assert/strict";
import test from "node:test";

import {
  parseLegacyProjectProfileMap,
  parseProjectProfileMap,
  prunedProjectProfileMap,
  resolveMappedProfile,
  resolveMappedProfiles,
  withMappedProfile,
  withoutMappedProfile,
} from "../app/project-profile-map.client.ts";

const profile = (id: string, instanceId = `${id}-instance`) => ({ id, instanceId });

test("requirements in one project map independently", () => {
  const map = withMappedProfile(
    withMappedProfile({}, "project_a", "connection_a", profile("profile-1")),
    "project_a",
    "connection_b",
    profile("profile-2"),
  );
  assert.deepEqual(map, {
    project_a: {
      connection_a: { profileId: "profile-1", profileInstanceId: "profile-1-instance" },
      connection_b: { profileId: "profile-2", profileInstanceId: "profile-2-instance" },
    },
  });
  assert.deepEqual(resolveMappedProfiles(map, "project_a", [profile("profile-1"), profile("profile-2")]), {
    connection_a: "profile-1",
    connection_b: "profile-2",
  });
});

test("an absent or stale requirement mapping resolves to none", () => {
  const map = withMappedProfile({}, "project_a", "connection_a", profile("profile-gone"));
  assert.equal(resolveMappedProfile(map, "project_a", "connection_b", [profile("profile-1")]), undefined);
  assert.equal(resolveMappedProfile(map, "project_a", "connection_a", [profile("profile-1")]), undefined);
});

test("a reused profile id does not inherit another instance's mapping", () => {
  const map = withMappedProfile({}, "project_a", "connection_a", profile("server-default", "old-instance"));
  assert.equal(resolveMappedProfile(map, "project_a", "connection_a", [profile("server-default", "new-instance")]), undefined);
});

test("remapping one requirement preserves other requirements and projects", () => {
  const map = withMappedProfile(
    withMappedProfile(
      withMappedProfile({}, "project_a", "connection_a", profile("profile-1")),
      "project_a",
      "connection_b",
      profile("profile-2"),
    ),
    "project_b",
    "connection_a",
    profile("profile-1"),
  );
  assert.deepEqual(withMappedProfile(map, "project_a", "connection_a", profile("profile-3")), {
    project_a: {
      connection_a: { profileId: "profile-3", profileInstanceId: "profile-3-instance" },
      connection_b: { profileId: "profile-2", profileInstanceId: "profile-2-instance" },
    },
    project_b: {
      connection_a: { profileId: "profile-1", profileInstanceId: "profile-1-instance" },
    },
  });
});

test("deleting a profile releases every requirement mapped to it", () => {
  const map = {
    project_a: {
      connection_a: { profileId: "profile-1", profileInstanceId: "profile-1-instance" },
      connection_b: { profileId: "profile-2", profileInstanceId: "profile-2-instance" },
    },
    project_b: {
      connection_a: { profileId: "profile-1", profileInstanceId: "profile-1-instance" },
    },
  };
  assert.deepEqual(withoutMappedProfile(map, "profile-1"), {
    project_a: {
      connection_b: { profileId: "profile-2", profileInstanceId: "profile-2-instance" },
    },
  });
});

test("pruning drops stale requirement mappings and empty projects", () => {
  const map = {
    project_a: {
      connection_a: { profileId: "profile-1", profileInstanceId: "profile-1-instance" },
      connection_b: { profileId: "profile-gone", profileInstanceId: "profile-gone-instance" },
    },
    project_b: {
      connection_a: { profileId: "profile-gone", profileInstanceId: "profile-gone-instance" },
    },
  };
  assert.deepEqual(prunedProjectProfileMap(map, [profile("profile-1")]), {
    project_a: {
      connection_a: { profileId: "profile-1", profileInstanceId: "profile-1-instance" },
    },
  });
  assert.deepEqual(prunedProjectProfileMap(map, []), map);
});

test("nested parsing drops malformed entries and secret-shaped extra fields", () => {
  assert.deepEqual(parseProjectProfileMap({
    project_a: {
      connection_a: {
        profileId: "profile-1",
        profileInstanceId: "profile-1-instance",
        apiKey: "should-never-be-here",
      },
      connection_bad: { profileId: 7 },
    },
    project_bad: "profile-2",
  }), {
    project_a: {
      connection_a: { profileId: "profile-1", profileInstanceId: "profile-1-instance" },
    },
  });
  assert.deepEqual(parseProjectProfileMap(null), {});
});

test("v2 mappings parse only at the explicit legacy boundary", () => {
  const legacy = {
    project_a: {
      profileId: "profile-1",
      profileInstanceId: "profile-1-instance",
      apiKey: "discarded",
    },
  };
  assert.deepEqual(parseProjectProfileMap(legacy), {});
  assert.deepEqual(parseLegacyProjectProfileMap(legacy), {
    project_a: { profileId: "profile-1", profileInstanceId: "profile-1-instance" },
  });
  assert.deepEqual(parseLegacyProjectProfileMap({ project_a: { profileId: "openai-compatible" } }), {});
});
