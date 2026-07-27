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
export type StoredInferenceProfile = InferenceProfile;

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

export function createDefaultProfile(): StoredInferenceProfile {
  return {
    id: "openai-compatible",
    name: "OpenAI compatible",
    provider: "openai-compatible",
    endpoint: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
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

function isStoredProfile(value: unknown): value is StoredInferenceProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Partial<StoredInferenceProfile>;
  return (
    typeof profile.id === "string" &&
    typeof profile.name === "string" &&
    profile.provider === "openai-compatible" &&
    typeof profile.endpoint === "string" &&
    typeof profile.model === "string" &&
    (profile.temperature === undefined || typeof profile.temperature === "number") &&
    (profile.capabilityOverrides === undefined ||
      isProviderCapabilityOverrides(profile.capabilityOverrides))
  );
}

/** Profiles are metadata only; credentials never enter browser persistence. */
function sanitizeProfile(profile: StoredInferenceProfile): StoredInferenceProfile {
  return {
    id: profile.id,
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
