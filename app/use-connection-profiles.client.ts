"use client";

import { useEffect, useRef, useState } from "react";
import type { CredentialSelection } from "../packages/contracts/src/index.ts";
import type { ProviderCapabilities } from "../packages/core/src/types.ts";
import { resolveProviderCapabilities } from "../packages/core/src/types.ts";
import { randomUUID } from "../packages/core/src/random-id.ts";
import {
  SERVER_DEFAULT_CREDENTIAL_REF,
  createDefaultProfile,
  createProfile,
  nextCapabilityOverrides,
  profileDeletionRefusal,
  readProfiles,
  removeProfile,
  writeProfiles,
} from "./profile-store.client.ts";
import type { StoredInferenceProfile } from "./profile-store.client.ts";
import { desktopCredentialStore } from "./tauri-inference-transport.client.ts";
import type { CredentialStatus } from "./tauri-inference-transport.client.ts";
import {
  resolveWebCredentialSelection,
  webCredentialIsAvailable,
} from "./web-credential-mode.ts";
import type { WebCredentialMode } from "./web-credential-mode.ts";

const unknownCredentialStatus: CredentialStatus = {
  canPersist: false,
  isStored: false,
  isApprovedForEndpoint: false,
};

const WEB_CREDENTIAL_MODES_STORAGE_KEY =
  "inference-lens:web-credential-modes:v1";
const SERVER_DEFAULT_PROFILE_ID = "server-default";
const SERVER_DEFAULT_PROFILE_NAME = "Server default";

/** Non-secret shape of `GET /api/runtime-status`. */
interface RuntimeStatus {
  containerized: boolean;
  configured: boolean;
  endpoint?: string;
  model?: string;
}

/**
 * What the service running this UI reports about itself. Drives the
 * server-default profile, which authentication modes are offered, and the
 * wording of container-specific advice.
 */
export interface ServerDefaultStatus {
  /** False until the probe answers; suppresses advice that would be a guess. */
  loaded: boolean;
  /** The API service is running in a container. */
  containerized: boolean;
  /** A server-held key is available and bound to `endpoint`. */
  configured: boolean;
  /** Present whenever the server declares a provider, key or no key. */
  endpoint?: string;
}

const unknownServerDefault: ServerDefaultStatus = {
  loaded: false,
  containerized: false,
  configured: false,
};

function parseRuntimeStatus(body: unknown): RuntimeStatus {
  const value = (body ?? {}) as Record<string, unknown>;
  const text = (key: string): string | undefined =>
    typeof value[key] === "string" && value[key].trim()
      ? (value[key] as string).trim()
      : undefined;
  return {
    containerized: value.containerized === true,
    configured: value.serverDefaultCredentialConfigured === true,
    endpoint: text("endpoint"),
    model: text("model"),
  };
}

export interface ProfileCredentialHandle {
  /** Session-only input for the active profile; never persisted by the UI. */
  draft: string;
  status: CredentialStatus;
  error?: string;
  /** A run started now would carry a credential rather than an empty one. */
  hasCredential: boolean;
  /** Web-only selection; Tauri continues to resolve session and Keychain keys. */
  webMode: WebCredentialMode;
  setDraft(value: string): void;
  setWebMode(mode: WebCredentialMode): void;
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
  /** Absent when the active profile can be deleted; otherwise why it cannot. */
  activeProfileDeletionRefusal?: string;
  /**
   * Removes the active profile along with every credential held for it, and
   * selects another. A no-op while `activeProfileDeletionRefusal` is present.
   */
  removeActiveProfile(): void;
  setCapabilityOverride(
    key: keyof ProviderCapabilities,
    enabled: boolean,
  ): void;
  /** What the hosting service reports about itself; see ServerDefaultStatus. */
  serverDefault: ServerDefaultStatus;
  /** Set once, when a server-configured profile is added beside existing ones. */
  serverDefaultProfileNotice?: { profileId: string };
  adoptServerDefaultProfile(): void;
  dismissServerDefaultProfileNotice(): void;
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
  const webCredentialModesRef = useRef(new Map<string, WebCredentialMode>());
  const serverDefaultProvisionedRef = useRef(false);
  // Whether this device had stored profiles at all. Adopting the server's
  // configuration outright is right when there is nothing to displace, and a
  // surprise the moment the user has profiles of their own.
  const firstRunRef = useRef(false);
  const [webCredentialModeOverride, setWebCredentialModeOverride] =
    useState<WebCredentialMode>();
  const [serverDefault, setServerDefault] =
    useState<ServerDefaultStatus>(unknownServerDefault);
  const [serverDefaultProfileNotice, setServerDefaultProfileNotice] =
    useState<{ profileId: string }>();

  // Lets the one-shot provisioning effect read the restored profiles without
  // taking a dependency on them, which would re-arm an effect that must run
  // exactly once per mount.
  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;

  const activeProfile =
    profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0];
  const capabilities = resolveProviderCapabilities(
    activeProfile.provider,
    activeProfile.capabilityOverrides,
  );
  const credentialProfileId = activeProfile.id;
  const credentialProfileEndpoint = activeProfile.endpoint;
  // Shared by the control that offers deletion and the function that performs
  // it, so a refused profile cannot be removed through some other path.
  const activeProfileDeletionRefusal = profileDeletionRefusal(
    profiles,
    activeProfile,
    serverDefault.configured,
  );

  useEffect(() => {
    const restoreId = window.setTimeout(() => {
      const snapshot = readProfiles();
      try {
        const stored = JSON.parse(
          window.localStorage.getItem(WEB_CREDENTIAL_MODES_STORAGE_KEY) ?? "{}",
        ) as Record<string, unknown>;
        // Preferences for profiles that no longer exist are dropped on the way
        // in, healing a record that drifted — a profile deleted in another tab,
        // or one `readProfiles` rejected as malformed. Left in place they would
        // be inherited by the next profile to take the same id, and the two
        // fixed ids make that reachable rather than theoretical.
        let pruned = false;
        for (const [profileId, mode] of Object.entries(stored)) {
          if (
            mode !== "environment-default" &&
            mode !== "session" &&
            mode !== "none"
          ) {
            continue;
          }
          if (snapshot.profiles.some(({ id }) => id === profileId)) {
            webCredentialModesRef.current.set(profileId, mode);
          } else {
            pruned = true;
          }
        }
        if (pruned) persistWebCredentialModes();
      } catch {
        // A malformed local preference is equivalent to no preference.
      }
      firstRunRef.current = !snapshot.restored;
      setProfiles(snapshot.profiles);
      setActiveProfileId(snapshot.activeProfileId);
      setWebCredentialModeOverride(
        webCredentialModesRef.current.get(snapshot.activeProfileId),
      );
      setProfilesLoaded(true);
    }, 0);
    return () => window.clearTimeout(restoreId);
  }, []);

  // Held in a ref so the one-shot effect below can reach the current closure
  // without listing it as a dependency, which would re-arm it on every render.
  const reconcileRef = useRef(reconcileServerDefaultProfile);
  reconcileRef.current = reconcileServerDefaultProfile;

  // Runs once per mount, after profiles are restored, and is deliberately not
  // cancelled: the result is idempotent, and aborting it on a Strict Mode
  // remount would leave the ref latched with nothing ever adopted.
  useEffect(() => {
    if (isDesktopRuntime || !profilesLoaded) return;
    if (serverDefaultProvisionedRef.current) return;
    serverDefaultProvisionedRef.current = true;
    void (async () => {
      let status: RuntimeStatus | undefined;
      try {
        const response = await fetch("/api/runtime-status");
        if (response.ok) status = parseRuntimeStatus(await response.json());
      } catch {
        // An unreachable status route means only that there is no server
        // configuration to adopt; the UI stays fully usable without one.
      }
      setServerDefault({
        loaded: true,
        containerized: status?.containerized ?? false,
        configured: status?.configured ?? false,
        ...(status?.endpoint ? { endpoint: status.endpoint } : {}),
      });
      reconcileRef.current(status);
    })();
  }, [isDesktopRuntime, profilesLoaded]);

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
    setWebCredentialModeOverride(
      webCredentialModesRef.current.get(credentialProfileId),
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

  const webCredentialMode =
    webCredentialModeOverride ??
    (serverDefault.configured &&
    activeProfile.credentialRef === SERVER_DEFAULT_CREDENTIAL_REF
      ? "environment-default"
      : "none");

  function persistWebCredentialModes(): void {
    window.localStorage.setItem(
      WEB_CREDENTIAL_MODES_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(webCredentialModesRef.current)),
    );
  }

  /**
   * Brings the local profile list in line with what the server now reports.
   *
   * Both directions matter. A newly configured server should produce a profile
   * that is ready to run, and a server whose variables were removed must not
   * leave behind a profile that is permanently endpoint-locked and fails every
   * request against a credential that no longer exists.
   */
  function reconcileServerDefaultProfile(status: RuntimeStatus | undefined): void {
    const current = profilesRef.current;
    const existing = current.find(
      ({ credentialRef }) => credentialRef === SERVER_DEFAULT_CREDENTIAL_REF,
    );

    // Any stored preference for a credential the server no longer holds would
    // fail on every run, so it is downgraded rather than left to break.
    if (!status?.configured) {
      let changed = false;
      for (const [profileId, mode] of webCredentialModesRef.current) {
        if (mode !== "environment-default") continue;
        webCredentialModesRef.current.set(profileId, "none");
        if (profileId === activeProfileId) setWebCredentialModeOverride("none");
        changed = true;
      }
      if (changed) persistWebCredentialModes();
    }

    if (!status?.endpoint) {
      // Release a profile provisioned by a configuration that is now gone,
      // unlocking its endpoint. The profile itself is kept: the user may have
      // chosen a model on it.
      if (!existing) return;
      setProfiles(
        current.map((profile) =>
          profile.credentialRef === SERVER_DEFAULT_CREDENTIAL_REF
            ? { ...profile, credentialRef: undefined }
            : profile,
        ),
      );
      return;
    }

    if (existing) {
      const next: StoredInferenceProfile = {
        ...existing,
        // The endpoint is the server's to own: the credential is released only
        // to the origin it names, so a profile pointing anywhere else is dead
        // weight. The model is not — the user may have picked one from
        // discovery, and INFERENCE_LENS_MODEL is a starting point rather than
        // a lock. It is filled in only while the profile has no model at all.
        endpoint: status.endpoint,
        ...(status.model && !existing.model ? { model: status.model } : {}),
      };
      if (existing.endpoint === next.endpoint && existing.model === next.model) {
        return;
      }
      setProfiles(
        current.map((profile) => (profile.id === existing.id ? next : profile)),
      );
      return;
    }

    const added: StoredInferenceProfile = {
      ...createDefaultProfile(),
      id: current.some(({ id }) => id === SERVER_DEFAULT_PROFILE_ID)
        ? `${SERVER_DEFAULT_PROFILE_ID}-${randomUUID()}`
        : SERVER_DEFAULT_PROFILE_ID,
      name: SERVER_DEFAULT_PROFILE_NAME,
      endpoint: status.endpoint,
      // Empty rather than the hosted-OpenAI default the starting profile
      // carries: the server named a provider but not a model, and a local
      // llama.cpp server has never heard of `gpt-4.1-mini`. An empty model
      // blocks the run with a notice that points at the model picker, which
      // is true, instead of failing at the provider with a name the user
      // never chose.
      model: status.model ?? "",
      credentialRef: SERVER_DEFAULT_CREDENTIAL_REF,
    };
    setProfiles([...current, added]);
    // Configuring the server is explicit intent, so a device that has never
    // stored a profile adopts it outright. Once the user has profiles of their
    // own, switching under them would be a surprise — offer it instead.
    if (firstRunRef.current) {
      setActiveProfileId(added.id);
    } else {
      setServerDefaultProfileNotice({ profileId: added.id });
    }
  }

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

  /**
   * Deleting a profile has to take its credentials with it. A profile id can be
   * reused — the starting profile and the server-provisioned one both have fixed
   * ids — so a mode preference, a session key, or a keychain entry left behind
   * would be silently adopted by whatever is created under that id next.
   */
  function removeActiveProfile(): void {
    if (activeProfileDeletionRefusal) return;
    const removed = activeProfile;
    const next = removeProfile({ profiles, activeProfileId }, removed.id);
    if (!next) return;

    sessionCredentialsRef.current.delete(removed.id);
    if (webCredentialModesRef.current.delete(removed.id)) {
      persistWebCredentialModes();
    }
    if (isDesktopRuntime) {
      // An empty key is the host's delete path, and it tolerates a secret that
      // was never stored. Failures are ignored on purpose: debug builds hold no
      // keychain at all, and a host that will not forget the secret must still
      // not keep the profile alive.
      void desktopCredentialStore
        .save(removed.id, removed.endpoint, "")
        .catch(() => {});
    }

    setProfiles(next.profiles);
    setActiveProfileId(next.activeProfileId);
    // The credential effect swaps in the newly active profile's draft, mode and
    // keychain status on its own; only the notice pointing at a profile that no
    // longer exists has to be cleared here.
    if (serverDefaultProfileNotice?.profileId === removed.id) {
      setServerDefaultProfileNotice(undefined);
    }
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
    if (!isDesktopRuntime && value.trim()) setWebCredentialModeForActiveProfile("session");
  }

  function setWebCredentialModeForActiveProfile(mode: WebCredentialMode): void {
    if (isDesktopRuntime) return;
    webCredentialModesRef.current.set(activeProfile.id, mode);
    setWebCredentialModeOverride(mode);
    persistWebCredentialModes();
  }

  /**
   * Resolves what a request should carry. On desktop this also promotes a
   * typed key into the keychain, so the caller never handles the secret; a key
   * the host cannot bind to this endpoint's origin yields no credential rather
   * than being sent anyway.
   */
  async function prepareCredential(): Promise<CredentialSelection> {
    if (!isDesktopRuntime) {
      return resolveWebCredentialSelection(webCredentialMode, credentialDraft);
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
    ...(activeProfileDeletionRefusal ? { activeProfileDeletionRefusal } : {}),
    removeActiveProfile,
    setCapabilityOverride,
    serverDefault,
    serverDefaultProfileNotice,
    adoptServerDefaultProfile: () => {
      if (serverDefaultProfileNotice) {
        setActiveProfileId(serverDefaultProfileNotice.profileId);
      }
      setServerDefaultProfileNotice(undefined);
    },
    dismissServerDefaultProfileNotice: () =>
      setServerDefaultProfileNotice(undefined),
    credential: {
      draft: credentialDraft,
      status: credentialStatus,
      error: credentialError,
      hasCredential:
        isDesktopRuntime
          ? credentialDraft.trim().length > 0 ||
            credentialStatus.isApprovedForEndpoint
          : webCredentialIsAvailable(webCredentialMode, credentialDraft),
      webMode: webCredentialMode,
      setDraft: setCredentialDraftForActiveProfile,
      setWebMode: setWebCredentialModeForActiveProfile,
      commit: commitCredential,
      prepare: prepareCredential,
    },
  };
}
