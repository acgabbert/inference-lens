"use client";

import { useEffect, useRef, useState } from "react";
import type { CredentialSelection } from "../packages/contracts/src/index.ts";
import type { ProviderCapabilities } from "../packages/core/src/types.ts";
import { resolveProviderCapabilities } from "../packages/core/src/types.ts";
import {
  createDefaultProfile,
  createProfile,
  nextCapabilityOverrides,
  readProfiles,
  writeProfiles,
} from "./profile-store.client.ts";
import type { StoredInferenceProfile } from "./profile-store.client.ts";
import { desktopCredentialStore } from "./tauri-inference-transport.client.ts";
import type { CredentialStatus } from "./tauri-inference-transport.client.ts";

const unknownCredentialStatus: CredentialStatus = {
  canPersist: false,
  isStored: false,
  isApprovedForEndpoint: false,
};

export interface ProfileCredentialHandle {
  /** Session-only input for the active profile; never persisted by the UI. */
  draft: string;
  status: CredentialStatus;
  error?: string;
  /** A run started now would carry a credential rather than an empty one. */
  hasCredential: boolean;
  setDraft(value: string): void;
  /** Surfaces failures inline; use `prepare` when the caller needs the result. */
  commit(): void;
  prepare(): Promise<CredentialSelection>;
}

export interface ConnectionProfilesHandle {
  profiles: StoredInferenceProfile[];
  activeProfile: StoredInferenceProfile;
  /** Resolved for the active profile, including its overrides. */
  capabilities: ProviderCapabilities;
  selectProfile(profileId: string): void;
  /** Returns the new profile's id, which is also made active. */
  addProfile(): string;
  updateActiveProfile(patch: Partial<StoredInferenceProfile>): void;
  setCapabilityOverride(
    key: keyof ProviderCapabilities,
    enabled: boolean,
  ): void;
  credential: ProfileCredentialHandle;
}

/**
 * Owns local connection profiles and the credential for whichever one is
 * active. Profile metadata is persisted to this device; credentials are not —
 * they are held for the session, or handed to the desktop keychain, and the
 * two are kept in one hook because a credential is only ever meaningful for a
 * specific profile's id and endpoint.
 *
 * Callers own how a profile change interacts with an open project; this hook
 * deliberately knows nothing about projects.
 */
export function useConnectionProfiles(input: {
  isDesktopRuntime: boolean;
}): ConnectionProfilesHandle {
  const { isDesktopRuntime } = input;
  // The first browser render must match the server's, so persisted profiles
  // are restored after mount rather than read during render.
  const [profiles, setProfiles] = useState<StoredInferenceProfile[]>(() => [
    createDefaultProfile(),
  ]);
  const [activeProfileId, setActiveProfileId] = useState(() => profiles[0].id);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [credentialDraft, setCredentialDraft] = useState("");
  const [credentialStatus, setCredentialStatus] = useState(
    unknownCredentialStatus,
  );
  const [credentialError, setCredentialError] = useState<string>();
  const sessionCredentialsRef = useRef(new Map<string, string>());

  const activeProfile =
    profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0];
  const capabilities = resolveProviderCapabilities(
    activeProfile.provider,
    activeProfile.capabilityOverrides,
  );
  const credentialProfileId = activeProfile.id;
  const credentialProfileEndpoint = activeProfile.endpoint;

  useEffect(() => {
    const restoreId = window.setTimeout(() => {
      const snapshot = readProfiles();
      setProfiles(snapshot.profiles);
      setActiveProfileId(snapshot.activeProfileId);
      setProfilesLoaded(true);
    }, 0);
    return () => window.clearTimeout(restoreId);
  }, []);

  useEffect(() => {
    if (!profilesLoaded) return;
    writeProfiles({ profiles, activeProfileId });
  }, [activeProfileId, profiles, profilesLoaded]);

  // A credential belongs to one profile *and* endpoint, so switching either
  // swaps in that profile's session draft and re-probes the keychain.
  useEffect(() => {
    setCredentialDraft(
      sessionCredentialsRef.current.get(credentialProfileId) ?? "",
    );
    setCredentialError(undefined);
    if (!isDesktopRuntime) return;
    let cancelled = false;
    void desktopCredentialStore
      .status(credentialProfileId, credentialProfileEndpoint)
      .then((status) => {
        if (!cancelled) setCredentialStatus(status);
      })
      .catch(() => {
        if (!cancelled) setCredentialStatus(unknownCredentialStatus);
      });
    return () => {
      cancelled = true;
    };
  }, [credentialProfileEndpoint, credentialProfileId, isDesktopRuntime]);

  function updateActiveProfile(patch: Partial<StoredInferenceProfile>): void {
    setProfiles((current) =>
      current.map((profile) =>
        profile.id === activeProfile.id ? { ...profile, ...patch } : profile,
      ),
    );
  }

  function addProfile(): string {
    const profile = createProfile();
    setProfiles((current) => [...current, profile]);
    setActiveProfileId(profile.id);
    return profile.id;
  }

  function setCapabilityOverride(
    key: keyof ProviderCapabilities,
    enabled: boolean,
  ): void {
    updateActiveProfile({
      capabilityOverrides: nextCapabilityOverrides(activeProfile, key, enabled),
    });
  }

  function setCredentialDraftForActiveProfile(value: string): void {
    sessionCredentialsRef.current.set(activeProfile.id, value);
    setCredentialDraft(value);
    setCredentialError(undefined);
  }

  /**
   * Resolves what a request should carry. On desktop this also promotes a
   * typed key into the keychain, so the caller never handles the secret; a key
   * the host cannot bind to this endpoint's origin yields no credential rather
   * than being sent anyway.
   */
  async function prepareCredential(): Promise<CredentialSelection> {
    if (!isDesktopRuntime) {
      return credentialDraft.trim()
        ? { kind: "provided" as const, apiKey: credentialDraft }
        : { kind: "none" as const };
    }
    const status = await desktopCredentialStore.status(
      activeProfile.id,
      activeProfile.endpoint,
    );
    if (!status.canPersist) {
      setCredentialStatus(status);
      setCredentialError(undefined);
      return credentialDraft.trim()
        ? { kind: "provided" as const, apiKey: credentialDraft }
        : { kind: "none" as const };
    }
    if (credentialDraft.trim()) {
      await desktopCredentialStore.save(
        activeProfile.id,
        activeProfile.endpoint,
        credentialDraft,
      );
    }
    const storedStatus = await desktopCredentialStore.status(
      activeProfile.id,
      activeProfile.endpoint,
    );
    if (!storedStatus.isApprovedForEndpoint) {
      setCredentialStatus(storedStatus);
      setCredentialError(undefined);
      return { kind: "none" as const };
    }
    setCredentialStatus(storedStatus);
    setCredentialError(undefined);
    return { kind: "native-keychain" as const, profileId: activeProfile.id };
  }

  function commitCredential(): void {
    if (!credentialDraft.trim()) return;
    void prepareCredential().catch((error) => {
      setCredentialError(
        error instanceof Error
          ? error.message
          : "Could not prepare the credential.",
      );
    });
  }

  return {
    profiles,
    activeProfile,
    capabilities,
    selectProfile: setActiveProfileId,
    addProfile,
    updateActiveProfile,
    setCapabilityOverride,
    credential: {
      draft: credentialDraft,
      status: credentialStatus,
      error: credentialError,
      hasCredential:
        credentialDraft.trim().length > 0 ||
        credentialStatus.isApprovedForEndpoint,
      setDraft: setCredentialDraftForActiveProfile,
      commit: commitCredential,
      prepare: prepareCredential,
    },
  };
}
