"use client";

const STORAGE_KEY = "inference-lens:project-profile-map:v2";

/**
 * Which local connection profile this device runs a given project against.
 *
 * The portable project file names only its connection *requirements*, so it
 * stays shareable and secret-free. The choice of local profile is a property of
 * this device, and lives here instead. Recorded as an object rather than a bare
 * profile id so a later per-connection-requirement mapping is an added field
 * rather than a stored-format migration.
 */
export interface ProjectProfileMapping {
  profileId: string;
  profileInstanceId: string;
}

export interface ProfileIdentity {
  id: string;
  instanceId: string;
}

/** Keyed by the project file's `projectId`, which travels inside the file. */
export type ProjectProfileMap = Record<string, ProjectProfileMapping>;

function isMapping(value: unknown): value is ProjectProfileMapping {
  if (!value || typeof value !== "object") return false;
  const mapping = value as Partial<ProjectProfileMapping>;
  return (
    typeof mapping.profileId === "string" &&
    typeof mapping.profileInstanceId === "string"
  );
}

export function parseProjectProfileMap(value: unknown): ProjectProfileMap {
  if (!value || typeof value !== "object") return {};
  const map: ProjectProfileMap = {};
  for (const [projectId, mapping] of Object.entries(value)) {
    if (isMapping(mapping)) {
      map[projectId] = {
        profileId: mapping.profileId,
        profileInstanceId: mapping.profileInstanceId,
      };
    }
  }
  return map;
}

/**
 * The mapped profile, or undefined when the project has never been mapped on
 * this device or names a different instance of a reused profile id.
 */
export function resolveMappedProfile(
  map: ProjectProfileMap,
  projectId: string,
  profiles: readonly ProfileIdentity[],
): string | undefined {
  const mapped = map[projectId];
  return mapped &&
      profiles.some(
        ({ id, instanceId }) =>
          id === mapped.profileId && instanceId === mapped.profileInstanceId,
      )
    ? mapped.profileId
    : undefined;
}

export function withMappedProfile(
  map: ProjectProfileMap,
  projectId: string,
  profile: ProfileIdentity,
): ProjectProfileMap {
  return {
    ...map,
    [projectId]: {
      profileId: profile.id,
      profileInstanceId: profile.instanceId,
    },
  };
}

/**
 * Every project mapped to `profileId` released at once. A deleted profile takes
 * its mappings with it, so the entries cannot outlive what they name even for
 * projects that are not currently open.
 */
export function withoutMappedProfile(
  map: ProjectProfileMap,
  profileId: string,
): ProjectProfileMap {
  return Object.fromEntries(
    Object.entries(map).filter(([, mapping]) => mapping.profileId !== profileId),
  );
}

/**
 * Drops entries naming profiles this device no longer has, bounding a map that
 * otherwise gains an entry for every project ever opened. Applied on write, so
 * pruning never costs a read the user is waiting on.
 */
export function prunedProjectProfileMap(
  map: ProjectProfileMap,
  profiles: readonly ProfileIdentity[],
): ProjectProfileMap {
  // An empty profile list means the caller has none to check against, not that
  // every mapping is stale. Wiping the map on it would lose real choices.
  if (profiles.length === 0) return map;
  return Object.fromEntries(
    Object.entries(map).filter(([, mapping]) =>
      profiles.some(
        ({ id, instanceId }) =>
          id === mapping.profileId &&
          instanceId === mapping.profileInstanceId,
      ),
    ),
  );
}

export function readProjectProfileMap(): ProjectProfileMap {
  if (typeof window === "undefined") return {};
  try {
    return parseProjectProfileMap(
      JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null"),
    );
  } catch {
    return {};
  }
}

export function writeProjectProfileMap(map: ProjectProfileMap): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Persistence is best-effort. A device that cannot store the mapping still
    // runs the project; it asks which connection to use again after a reload.
  }
}
