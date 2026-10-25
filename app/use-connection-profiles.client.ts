"use client";

import { useEffect, useRef, useState } from "react";
import type { CredentialSelection } from "../packages/contracts/src/index.ts";
import type { ProviderCapabilities } from "../packages/core/src/types.ts";
import { resolveProviderCapabilities } from "../packages/core/src/types.ts";
import {
  createDefaultProfile,
  createProfile,
  nextCapabilityOverrides,
  withSystemOne,
  profileDeletionRefusal,
  readProfiles,
  removeProfile,
  writeProfiles,
} from "./profile-store.client.ts";
import type {
  StoredInferenceProfile,
  StoredInferenceProfilePatch,
} from "./profile-store.client.ts";
import { desktopCredentialStore } from "./tauri-inference-transport.client.ts";
import type { CredentialStatus } from "./tauri-inference-transport.client.ts";
import {
  defaultWebCredentialMode,
  parseRuntimeStatus,
  reconcileServerProfiles,
  reconcileWebCredentialModes,
  serverConnectionFor,
  unknownServerStatus,
} from "./server-connection-profiles.ts";
import type { ServerStatus } from "./server-connection-profiles.ts";
import {
  resolveWebCredentialSelection,
  webCredentialIsAvailable,
  webCredentialModeFromStorage,
  webCredentialModeToStorage,
} from "./web-credential-mode.ts";
import type { WebCredentialMode } from "./web-credential-mode.ts";

const unknownCredentialStatus: CredentialStatus = {
  canPersist: false,
  isStored: false,
  isApprovedForEndpoint: false,
};

const WEB_CREDENTIAL_MODES_STORAGE_KEY =
  "inference-lens:web-credential-modes:v1";
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
  /** Resolves a mapped profile without changing which profile the drawer edits. */
  prepareForProfile(profileId: string, endpoint: string): Promise<CredentialSelection>;
}

export interface ConnectionProfilesHandle {
  profiles: StoredInferenceProfile[];
  /** True once local profile storage has been read and migrated. */
  profilesLoaded: boolean;
  activeProfile: StoredInferenceProfile;
  /** Resolved for the active profile, including its overrides. */
  capabilities: ProviderCapabilities;
  selectProfile(profileId: string): void;
  /** Returns the new profile, which is also made active. */
  addProfile(): StoredInferenceProfile;
  /** Updates one profile without changing which profile the drawer edits. */
  updateProfile(profileId: string, patch: StoredInferenceProfilePatch): void;
  updateActiveProfile(patch: StoredInferenceProfilePatch): void;
  /** The active profile's device-local System One declaration (D9-B). */
  setActiveSystemOne(enabled: boolean): void;
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
  /** What the hosting service reports about itself; see ServerStatus. */
  server: ServerStatus;
  /**
   * Set once, when server-configured profiles are added beside existing ones.
   * Lists every profile added by this load, in the server's order.
   */
  serverProfilesNotice?: { profiles: { id: string; name: string }[] };
  /** Switches to the first profile the notice lists. */
  adoptServerProfile(): void;
  dismissServerProfilesNotice(): void;
  /**
   * A connection's protocol list names something unrecognized and was
   * ignored. Held until dismissed for this page load; the next load reports
   * it again, because nothing here can fix it.
   */
  serverProtocolsNotice?: {
    connections: { id: string; name: string; unrecognized: string[] }[];
  };
  dismissServerProtocolsNotice(): void;
  /** The server refused its connection catalog whole; held like the above. */
  serverCatalogNotice?: { problem: string };
  dismissServerCatalogNotice(): void;
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
  const serverProvisionedRef = useRef(false);
  // Whether this device had stored profiles at all. Adopting the server's
  // configuration outright is right when there is nothing to displace, and a
  // surprise the moment the user has profiles of their own.
  const firstRunRef = useRef(false);
  const [webCredentialModeOverride, setWebCredentialModeOverride] =
    useState<WebCredentialMode>();
  const [server, setServer] = useState<ServerStatus>(unknownServerStatus);
  const [serverProfilesNotice, setServerProfilesNotice] =
    useState<{ profiles: { id: string; name: string }[] }>();
  const [serverProtocolsNoticeDismissed, setServerProtocolsNoticeDismissed] =
    useState(false);
  const [serverCatalogNoticeDismissed, setServerCatalogNoticeDismissed] =
    useState(false);

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
    serverConnectionFor(activeProfile, server),
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
        for (const [profileId, value] of Object.entries(stored)) {
          const mode = webCredentialModeFromStorage(value);
          if (!mode) continue;
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
  const reconcileRef = useRef(reconcileWithServer);
  reconcileRef.current = reconcileWithServer;

  // Runs once per mount, after profiles are restored, and is deliberately not
  // cancelled: the result is idempotent, and aborting it on a Strict Mode
  // remount would leave the ref latched with nothing ever adopted.
  useEffect(() => {
    if (isDesktopRuntime || !profilesLoaded) return;
    if (serverProvisionedRef.current) return;
    serverProvisionedRef.current = true;
    void (async () => {
      let status: Omit<ServerStatus, "loaded"> | undefined;
      try {
        const response = await fetch("/api/runtime-status");
        if (response.ok) status = parseRuntimeStatus(await response.json());
      } catch {
        // The UI stays fully usable when the status route is unreachable, but
        // the absence of an answer is not evidence that configuration was
        // removed. Keep the last stored managed profile intact.
      }
      if (!status) return;
      setServer({ loaded: true, ...status });
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
    webCredentialModeOverride ?? defaultWebCredentialMode(activeProfile, server);

  function persistWebCredentialModes(): void {
    window.localStorage.setItem(
      WEB_CREDENTIAL_MODES_STORAGE_KEY,
      JSON.stringify(
        Object.fromEntries(
          [...webCredentialModesRef.current].map(([profileId, mode]) => [
            profileId,
            webCredentialModeToStorage(mode),
          ]),
        ),
      ),
    );
  }

  /**
   * Applies what the server now reports to stored preferences and profiles;
   * see `reconcileServerProfiles` for the rules.
   */
  function reconcileWithServer(status: Omit<ServerStatus, "loaded">): void {
    // Any stored preference for a credential the server no longer holds would
    // fail on every run, so it is downgraded rather than left to break.
    const downgraded = reconcileWebCredentialModes(webCredentialModesRef.current, status);
    if (downgraded.length > 0) {
      if (downgraded.includes(activeProfileId)) setWebCredentialModeOverride("none");
      persistWebCredentialModes();
    }

    const result = reconcileServerProfiles({
      profiles: profilesRef.current,
      connections: status.connections,
      ...(status.catalogProblem ? { catalogProblem: status.catalogProblem } : {}),
      firstRun: firstRunRef.current,
    });
    if (!result) return;
    setProfiles(result.profiles);
    if (result.activeProfileId) setActiveProfileId(result.activeProfileId);
    if (result.added.length > 0) {
      setServerProfilesNotice({
        profiles: result.profiles
          .filter(({ id }) => result.added.includes(id))
          .map(({ id, name }) => ({ id, name })),
      });
    }
  }

  function updateProfile(
    profileId: string,
    patch: StoredInferenceProfilePatch,
  ): void {
    setProfiles((current) =>
      current.map((profile) =>
        profile.id === profileId ? { ...profile, ...patch } : profile,
      ),
    );
  }

  function updateActiveProfile(patch: StoredInferenceProfilePatch): void {
    updateProfile(activeProfile.id, patch);
  }

  /** Declares or withdraws System One for the active profile (D9-B). */
  function setActiveSystemOne(enabled: boolean): void {
    const profileId = activeProfile.id;
    setProfiles((current) =>
      current.map((profile) => (profile.id === profileId ? withSystemOne(profile, enabled) : profile)),
    );
  }

  function addProfile(): StoredInferenceProfile {
    const profile = createProfile();
    setProfiles((current) => [...current, profile]);
    setActiveProfileId(profile.id);
    return profile;
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
    if (serverProfilesNotice?.profiles.some(({ id }) => id === removed.id)) {
      const remaining = serverProfilesNotice.profiles.filter(({ id }) => id !== removed.id);
      setServerProfilesNotice(remaining.length > 0 ? { profiles: remaining } : undefined);
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
  async function prepareCredentialForProfile(
    profileId: string,
    endpoint: string,
  ): Promise<CredentialSelection> {
    const profile = profilesRef.current.find(({ id }) => id === profileId);
    if (!profile || profile.endpoint !== endpoint) {
      throw new Error(`The mapped connection profile ${profileId} changed before the evaluation started.`);
    }
    const draft = sessionCredentialsRef.current.get(profileId) ?? "";
    if (!isDesktopRuntime) {
      const mode = webCredentialModesRef.current.get(profileId) ??
        defaultWebCredentialMode(profile, server);
      return resolveWebCredentialSelection(mode, draft);
    }
    const status = await desktopCredentialStore.status(
      profileId,
      endpoint,
    );
    if (!status.canPersist) {
      if (profileId === activeProfile.id) {
        setCredentialStatus(status);
        setCredentialError(undefined);
      }
      return draft.trim()
        ? { kind: "provided" as const, apiKey: draft }
        : { kind: "none" as const };
    }
    if (draft.trim()) {
      await desktopCredentialStore.save(
        profileId,
        endpoint,
        draft,
      );
    }
    const storedStatus = await desktopCredentialStore.status(
      profileId,
      endpoint,
    );
    if (!storedStatus.isApprovedForEndpoint) {
      if (profileId === activeProfile.id) {
        setCredentialStatus(storedStatus);
        setCredentialError(undefined);
      }
      return { kind: "none" as const };
    }
    if (profileId === activeProfile.id) {
      setCredentialStatus(storedStatus);
      setCredentialError(undefined);
    }
    return { kind: "native-keychain" as const, profileId };
  }

  async function prepareCredential(): Promise<CredentialSelection> {
    return prepareCredentialForProfile(activeProfile.id, activeProfile.endpoint);
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

  const unrecognizedProtocolConnections = server.connections.flatMap(
    ({ id, name, unrecognizedProtocols }) =>
      unrecognizedProtocols ? [{ id, name, unrecognized: unrecognizedProtocols }] : [],
  );

  return {
    profiles,
    profilesLoaded,
    activeProfile,
    capabilities,
    selectProfile: setActiveProfileId,
    addProfile,
    updateProfile,
    updateActiveProfile,
    setActiveSystemOne,
    ...(activeProfileDeletionRefusal ? { activeProfileDeletionRefusal } : {}),
    removeActiveProfile,
    setCapabilityOverride,
    server,
    serverProfilesNotice,
    adoptServerProfile: () => {
      const first = serverProfilesNotice?.profiles[0];
      if (first) setActiveProfileId(first.id);
      setServerProfilesNotice(undefined);
    },
    dismissServerProfilesNotice: () => setServerProfilesNotice(undefined),
    ...(unrecognizedProtocolConnections.length > 0 && !serverProtocolsNoticeDismissed
      ? { serverProtocolsNotice: { connections: unrecognizedProtocolConnections } }
      : {}),
    dismissServerProtocolsNotice: () => setServerProtocolsNoticeDismissed(true),
    ...(server.catalogProblem && !serverCatalogNoticeDismissed
      ? { serverCatalogNotice: { problem: server.catalogProblem } }
      : {}),
    dismissServerCatalogNotice: () => setServerCatalogNoticeDismissed(true),
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
      prepareForProfile: prepareCredentialForProfile,
    },
  };
}
