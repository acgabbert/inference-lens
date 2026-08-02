"use client";

import type {
  InferenceProfile,
  ProviderCapabilities,
  ProviderCapabilityOverrides,
} from "../packages/core/src/types.ts";
import {
  isProviderCapabilityOverrides,
  resolveProviderCapabilities,
} from "../packages/core/src/types.ts";
import { randomUUID } from "../packages/core/src/random-id.ts";

const STORAGE_KEY = "inference-lens:inference-profiles:v1";

/**
 * Marks a profile as provisioned from the hosting service's configuration. The
 * credential itself lives on the server; the profile only names the intent.
 */
export const SERVER_DEFAULT_CREDENTIAL_REF = "environment-default";

/**
 * Connection metadata is persisted locally, but credentials never are. The
 * release desktop host stores them in the OS credential store under this ID;
 * debug hosts keep credentials only in the current UI session.
 */
export interface StoredInferenceProfile extends InferenceProfile {
  /**
   * Non-reused identity for this particular local profile record. Unlike
   * `id`, this changes when storage is reset or a fixed-id profile is recreated,
   * so device-local references cannot attach to a different profile instance.
   */
  instanceId: string;
  /**
   * Model ids pinned for quick access in this profile's picker. A device/user
   * preference, not portable project data — two projects sharing one
   * connection profile share its favorites. Omitted rather than `[]` when
   * empty, matching `capabilityOverrides`. A favorite that a provider later
   * drops from its catalogue is left in place: free-text model ids are
   * already valid here, so there is nothing to reconcile it against.
   */
  favoriteModels?: string[];
}

/** Editable metadata; both forms of local identity are immutable. */
export type StoredInferenceProfilePatch = Partial<
  Omit<StoredInferenceProfile, "id" | "instanceId">
>;

export interface ProfileSnapshot {
  profiles: StoredInferenceProfile[];
  activeProfileId: string;
  /**
   * False when nothing usable was in storage and the snapshot is the built-in
   * starting profile. The exact signal for "this device has never configured
   * a connection" — checking the profile's fields against the current defaults
   * instead would quietly stop matching the moment a release changes them.
   */
  restored: boolean;
}

function profileId(): string {
  return `profile-${randomUUID()}`;
}

function profileInstanceId(): string {
  return `profile-instance-${randomUUID()}`;
}

/**
 * The starting profile ships with no endpoint or model rather than a real
 * provider's, so a first run can never leave for somewhere the user never
 * chose. `run-readiness.client.ts` blocks a run until both are filled in.
 */
export function createDefaultProfile(): StoredInferenceProfile {
  return {
    id: "openai-compatible",
    instanceId: profileInstanceId(),
    name: "OpenAI compatible",
    provider: "openai-compatible",
    endpoint: "",
    model: "",
    temperature: 0.7,
  };
}

export function createProfile(): StoredInferenceProfile {
  return {
    ...createDefaultProfile(),
    id: profileId(),
    name: "New profile",
  };
}

/**
 * Overrides record only the capabilities a profile states differently from its
 * provider baseline. Setting one back to the baseline drops it, and a profile
 * that no longer disagrees with its provider stores no overrides at all, so a
 * later change to the baseline still reaches profiles that never disputed it.
 */
export function nextCapabilityOverrides(
  profile: StoredInferenceProfile,
  key: keyof ProviderCapabilities,
  enabled: boolean,
): ProviderCapabilityOverrides | undefined {
  const defaults = resolveProviderCapabilities(profile.provider);
  const overrides = { ...profile.capabilityOverrides };
  if (enabled === defaults[key]) {
    delete overrides[key];
  } else {
    overrides[key] = enabled;
  }
  return Object.keys(overrides).length === 0 ? undefined : overrides;
}

/**
 * Adds or removes a single model from a profile's favorites, without
 * mutating the array it is given. Returns `undefined` rather than `[]` when
 * the result is empty, so an unfavorited-back-to-nothing profile stores no
 * favorites field at all — the same "no disagreement, nothing stored"
 * convention `nextCapabilityOverrides` uses.
 */
export function toggleFavoriteModel(
  favorites: string[] | undefined,
  model: string,
): string[] | undefined {
  const trimmed = model.trim();
  if (!trimmed) return favorites;
  const current = favorites ?? [];
  const next = current.includes(trimmed)
    ? current.filter((id) => id !== trimmed)
    : [...current, trimmed];
  return next.length === 0 ? undefined : next;
}

/**
 * Why this profile cannot be deleted, phrased for the user, or undefined when it
 * can be. The list must never empty out — the active profile is resolved by
 * falling back to the first one — and a profile the server provisioned would be
 * recreated on the next load, so refusing it is more honest than removing
 * something that comes back.
 */
export function profileDeletionRefusal(
  profiles: StoredInferenceProfile[],
  profile: StoredInferenceProfile,
  serverDefaultConfigured: boolean,
): string | undefined {
  if (profiles.length <= 1) {
    return "At least one connection profile is required.";
  }
  if (
    profile.credentialRef === SERVER_DEFAULT_CREDENTIAL_REF &&
    serverDefaultConfigured
  ) {
    return "This profile comes from the server configuration and would be added back. Unset INFERENCE_LENS_API_KEY to remove it.";
  }
  return undefined;
}

/**
 * The snapshot with `profileId` gone, or undefined when the removal is refused:
 * an unknown id, or the last remaining profile. A removed active profile hands
 * selection to whichever profile takes its place in the list, and to the new
 * last profile when it was at the end.
 */
export function removeProfile(
  snapshot: Pick<ProfileSnapshot, "profiles" | "activeProfileId">,
  profileId: string,
): Pick<ProfileSnapshot, "profiles" | "activeProfileId"> | undefined {
  const index = snapshot.profiles.findIndex(({ id }) => id === profileId);
  if (index < 0 || snapshot.profiles.length <= 1) return undefined;
  const profiles = snapshot.profiles.filter(({ id }) => id !== profileId);
  return {
    profiles,
    activeProfileId:
      snapshot.activeProfileId === profileId
        ? profiles[Math.min(index, profiles.length - 1)].id
        : snapshot.activeProfileId,
  };
}

type PersistedInferenceProfile = InferenceProfile & {
  instanceId?: string;
  favoriteModels?: unknown;
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStoredProfile(value: unknown): value is PersistedInferenceProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Partial<PersistedInferenceProfile>;
  return (
    typeof profile.id === "string" &&
    (profile.instanceId === undefined ||
      typeof profile.instanceId === "string") &&
    typeof profile.name === "string" &&
    profile.provider === "openai-compatible" &&
    typeof profile.endpoint === "string" &&
    typeof profile.model === "string" &&
    (profile.temperature === undefined || typeof profile.temperature === "number") &&
    (profile.capabilityOverrides === undefined ||
      isProviderCapabilityOverrides(profile.capabilityOverrides)) &&
    (profile.favoriteModels === undefined || isStringArray(profile.favoriteModels))
  );
}

/** Profiles are metadata only; credentials never enter browser persistence. */
function sanitizeProfile(
  profile: PersistedInferenceProfile,
): StoredInferenceProfile {
  // A profile written before this field existed simply lacks it, which
  // `isStoredProfile` already treats as valid; an empty favorites list is
  // dropped here the same way a resolved-to-baseline capability override is.
  const favoriteModels = isStringArray(profile.favoriteModels)
    ? Array.from(new Set(profile.favoriteModels.map((id) => id.trim()).filter(Boolean)))
    : [];
  return {
    id: profile.id,
    instanceId: profile.instanceId?.trim() || profileInstanceId(),
    name: profile.name,
    provider: profile.provider,
    endpoint: profile.endpoint,
    model: profile.model,
    ...(profile.temperature === undefined
      ? {}
      : { temperature: profile.temperature }),
    ...(profile.capabilityOverrides === undefined
      ? {}
      : { capabilityOverrides: profile.capabilityOverrides }),
    ...(profile.credentialRef === undefined
      ? {}
      : { credentialRef: profile.credentialRef }),
    ...(favoriteModels.length === 0 ? {} : { favoriteModels }),
  };
}

export function readProfiles(): ProfileSnapshot {
  const fallback = createDefaultProfile();
  const firstRun: ProfileSnapshot = {
    profiles: [fallback],
    activeProfileId: fallback.id,
    restored: false,
  };
  if (typeof window === "undefined") return firstRun;

  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as {
      profiles?: unknown;
      activeProfileId?: unknown;
    } | null;
    const profiles = Array.isArray(value?.profiles)
      ? value.profiles.filter(isStoredProfile).map(sanitizeProfile)
      : [];
    if (profiles.length === 0) return firstRun;
    const activeProfileId =
      typeof value?.activeProfileId === "string" &&
      profiles.some((profile) => profile.id === value.activeProfileId)
        ? value.activeProfileId
        : profiles[0].id;
    return { profiles, activeProfileId, restored: true };
  } catch {
    return firstRun;
  }
}

export function writeProfiles(
  snapshot: Pick<ProfileSnapshot, "profiles" | "activeProfileId">,
): void {
  const { profiles, activeProfileId } = snapshot;
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ profiles, activeProfileId }),
  );
}
