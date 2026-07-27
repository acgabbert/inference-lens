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
 * Connection metadata is persisted locally, but credentials never are. The
 * release desktop host stores them in the OS credential store under this ID;
 * debug hosts keep credentials only in the current UI session.
 */
export type StoredInferenceProfile = InferenceProfile;

export interface ProfileSnapshot {
  profiles: StoredInferenceProfile[];
  activeProfileId: string;
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
  if (typeof window === "undefined") {
    return { profiles: [fallback], activeProfileId: fallback.id };
  }

  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as {
      profiles?: unknown;
      activeProfileId?: unknown;
    } | null;
    const profiles = Array.isArray(value?.profiles)
      ? value.profiles.filter(isStoredProfile).map(sanitizeProfile)
      : [];
    if (profiles.length === 0) {
      return { profiles: [fallback], activeProfileId: fallback.id };
    }
    const activeProfileId =
      typeof value?.activeProfileId === "string" &&
      profiles.some((profile) => profile.id === value.activeProfileId)
        ? value.activeProfileId
        : profiles[0].id;
    return { profiles, activeProfileId };
  } catch {
    return { profiles: [fallback], activeProfileId: fallback.id };
  }
}

export function writeProfiles(snapshot: ProfileSnapshot): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
}
