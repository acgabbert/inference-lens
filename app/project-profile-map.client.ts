"use client";

const STORAGE_KEY = "inference-lens:project-profile-map:v3";
const LEGACY_STORAGE_KEY = "inference-lens:project-profile-map:v2";

/** One explicit device-local resolution of a portable connection requirement. */
export interface ProjectProfileMapping {
  profileId: string;
  profileInstanceId: string;
}

export interface ProfileIdentity {
  id: string;
  instanceId: string;
}

/**
 * Project id → connection requirement id → local profile identity.
 *
 * Requirement ids are portable, while the mapped identities stay on this
 * device. A newly-authored requirement therefore starts unmapped instead of
 * inheriting a profile the user chose for a different provider boundary.
 */
export type ProjectProfileMap = Record<
  string,
  Record<string, ProjectProfileMapping>
>;

/** The v2 shape had one undifferentiated mapping per project. */
export type LegacyProjectProfileMap = Record<string, ProjectProfileMapping>;

function isMapping(value: unknown): value is ProjectProfileMapping {
  if (!value || typeof value !== "object") return false;
  const mapping = value as Partial<ProjectProfileMapping>;
  return (
    typeof mapping.profileId === "string" &&
    typeof mapping.profileInstanceId === "string"
  );
}

function cleanMapping(mapping: ProjectProfileMapping): ProjectProfileMapping {
  return {
    profileId: mapping.profileId,
    profileInstanceId: mapping.profileInstanceId,
  };
}

export function parseProjectProfileMap(value: unknown): ProjectProfileMap {
  if (!value || typeof value !== "object") return {};
  const map: ProjectProfileMap = {};
  for (const [projectId, projectMappings] of Object.entries(value)) {
    if (!projectMappings || typeof projectMappings !== "object") continue;
    const parsed: Record<string, ProjectProfileMapping> = {};
    for (const [requirementId, mapping] of Object.entries(projectMappings)) {
      if (isMapping(mapping)) parsed[requirementId] = cleanMapping(mapping);
    }
    if (Object.keys(parsed).length > 0) map[projectId] = parsed;
  }
  return map;
}

export function parseLegacyProjectProfileMap(
  value: unknown,
): LegacyProjectProfileMap {
  if (!value || typeof value !== "object") return {};
  const map: LegacyProjectProfileMap = {};
  for (const [projectId, mapping] of Object.entries(value)) {
    if (isMapping(mapping)) map[projectId] = cleanMapping(mapping);
  }
  return map;
}

/** Resolves every valid mapping for one project, dropping stale identities. */
export function resolveMappedProfiles(
  map: ProjectProfileMap,
  projectId: string,
  profiles: readonly ProfileIdentity[],
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [requirementId, mapped] of Object.entries(map[projectId] ?? {})) {
    if (profiles.some(({ id, instanceId }) =>
      id === mapped.profileId && instanceId === mapped.profileInstanceId
    )) {
      resolved[requirementId] = mapped.profileId;
    }
  }
  return resolved;
}

export function resolveMappedProfile(
  map: ProjectProfileMap,
  projectId: string,
  requirementId: string,
  profiles: readonly ProfileIdentity[],
): string | undefined {
  return resolveMappedProfiles(map, projectId, profiles)[requirementId];
}

export function withMappedProfile(
  map: ProjectProfileMap,
  projectId: string,
  requirementId: string,
  profile: ProfileIdentity,
): ProjectProfileMap {
  return {
    ...map,
    [projectId]: {
      ...map[projectId],
      [requirementId]: {
        profileId: profile.id,
        profileInstanceId: profile.instanceId,
      },
    },
  };
}

/** Releases every requirement on every project that names a deleted profile. */
export function withoutMappedProfile(
  map: ProjectProfileMap,
  profileId: string,
): ProjectProfileMap {
  const next: ProjectProfileMap = {};
  for (const [projectId, mappings] of Object.entries(map)) {
    const retained = Object.fromEntries(
      Object.entries(mappings).filter(([, mapping]) =>
        mapping.profileId !== profileId
      ),
    );
    if (Object.keys(retained).length > 0) next[projectId] = retained;
  }
  return next;
}

/** Drops mappings naming profile instances this device no longer has. */
export function prunedProjectProfileMap(
  map: ProjectProfileMap,
  profiles: readonly ProfileIdentity[],
): ProjectProfileMap {
  if (profiles.length === 0) return map;
  const next: ProjectProfileMap = {};
  for (const [projectId, mappings] of Object.entries(map)) {
    const retained = Object.fromEntries(
      Object.entries(mappings).filter(([, mapping]) =>
        profiles.some(({ id, instanceId }) =>
          id === mapping.profileId && instanceId === mapping.profileInstanceId
        )
      ),
    );
    if (Object.keys(retained).length > 0) next[projectId] = retained;
  }
  return next;
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

export function readLegacyProjectProfileMap(): LegacyProjectProfileMap {
  if (typeof window === "undefined") return {};
  try {
    return parseLegacyProjectProfileMap(
      JSON.parse(window.localStorage.getItem(LEGACY_STORAGE_KEY) ?? "null"),
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
