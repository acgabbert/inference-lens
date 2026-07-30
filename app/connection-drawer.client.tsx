"use client";

import { useEffect, useRef, type RefObject } from "react";
import type { ConnectionRequirement } from "../packages/core/src/project";
import { sameChatCompletionsTarget } from "../packages/core/src/openai-compatible";
import type { ProviderCapabilities } from "../packages/core/src/types";
import type {
  StoredInferenceProfile,
  StoredInferenceProfilePatch,
} from "./profile-store.client";
import type {
  ProfileCredentialHandle,
  ServerDefaultStatus,
} from "./use-connection-profiles.client";
import { SideDrawer } from "./workbench-shell.client";
import type { ReadinessDestination } from "./run-readiness.client";

/**
 * Whether the server would release its credential to this profile. The service
 * refuses any endpoint outside the origin it configured, so a mismatch is
 * reported where the mode is chosen rather than when a run fails.
 */
function matchesServerOrigin(endpoint: string, configured?: string): boolean {
  if (!configured) return false;
  try {
    return new URL(endpoint).origin === new URL(configured).origin;
  } catch {
    return false;
  }
}

function configuredServerOrigin(endpoint?: string): string | undefined {
  if (!endpoint) return undefined;
  try {
    return new URL(endpoint).origin;
  } catch {
    return undefined;
  }
}

/** Names the variables to set, in the one place the absence is felt. */
function ServerCredentialHint() {
  return (
    <span className="credential-status">
      Set <code>INFERENCE_LENS_API_KEY</code> and{" "}
      <code>INFERENCE_LENS_API_ENDPOINT</code> on the server to connect
      automatically. See the Docker guide.
    </span>
  );
}

interface ConnectionDrawerProps {
  open: boolean;
  onClose(): void;
  profiles: StoredInferenceProfile[];
  activeProfile: StoredInferenceProfile;
  capabilities: ProviderCapabilities;
  credential: ProfileCredentialHandle;
  serverDefault: ServerDefaultStatus;
  isDesktopRuntime: boolean;
  onSelectProfile(profileId: string): void;
  onAddProfile(): void;
  onDeleteProfile(): void;
  /** Absent when the active profile can be deleted; otherwise why it cannot. */
  deleteProfileRefusal?: string;
  onUpdateProfile(patch: StoredInferenceProfilePatch): void;
  onCapabilityChange(key: keyof ProviderCapabilities, enabled: boolean): void;
  /** Present only while a project declares a connection to satisfy. */
  connectionRequirement?: ConnectionRequirement;
  /**
   * The profile this device runs the open project against, which is not always
   * the active one — a profile can become active without being mapped. The
   * mapping reads as satisfied only when the two agree, the same condition the
   * run path enforces, so the control that resolves a divergence stays offered.
   */
  mappedProfileId?: string;
  onMapProfile(): void;
  /** Re-points the project's declared connection at the mapped profile. */
  onUpdateProjectEndpoint(): void;
  pendingDestination?: ReadinessDestination;
  onDestinationHandled(): void;
}

/**
 * The project's declared endpoint beside the one the selected profile will
 * actually call. A mapping is allowed to point somewhere else — a project
 * moved between a hosted provider and a local server is the normal case — so
 * the mismatch is reported rather than refused.
 */
function ConnectionMapping({
  requirement,
  activeProfile,
  mapped,
  onMapProfile,
  onUpdateProjectEndpoint,
  mapButtonRef,
  projectEndpointButtonRef,
}: {
  requirement: ConnectionRequirement;
  activeProfile: StoredInferenceProfile;
  mapped: boolean;
  onMapProfile(): void;
  onUpdateProjectEndpoint(): void;
  mapButtonRef: RefObject<HTMLButtonElement | null>;
  projectEndpointButtonRef: RefObject<HTMLButtonElement | null>;
}) {
  const profileName = activeProfile.name.trim() || "the selected profile";
  const mismatched = !sameChatCompletionsTarget(
    activeProfile.endpoint,
    requirement.endpoint,
  );
  return (
    <div
      className={
        mapped && !mismatched
          ? "connection-mapping mapped"
          : "connection-mapping"
      }
    >
      <strong>
        {!mapped
          ? "Connection mapping required"
          : mismatched
            ? "Mapped to a different endpoint"
            : "Project connection mapped"}
      </strong>
      <span>
        Project expects <code>{requirement.endpoint}</code>
      </span>
      {mismatched && (
        <span>
          {mapped ? "Requests go to" : "This profile calls"}{" "}
          <code>{activeProfile.endpoint}</code>
        </span>
      )}
      {!mapped && (
        <button ref={mapButtonRef} className="text-button" data-readiness-control="project-mapping" type="button" onClick={onMapProfile}>
          Use {profileName} for this project
        </button>
      )}
      {/* Offered only once a profile is mapped and still disagrees. Before
          that the mismatch may just be the wrong profile selected, and
          rewriting the shared project file would be the wrong answer. */}
      {mapped && mismatched && (
        <button
          ref={projectEndpointButtonRef}
          className="text-button"
          data-readiness-control="project-endpoint"
          type="button"
          onClick={onUpdateProjectEndpoint}
        >
          Update &ldquo;{requirement.name}&rdquo; to expect this endpoint
        </button>
      )}
    </div>
  );
}

/**
 * Local connection settings: which profiles exist, which one runs, and the
 * credential for it. An imported project's connection requirement is mapped to
 * a profile here, because that mapping is the point where a portable document
 * meets a credential that never leaves this device.
 */
export function ConnectionDrawer({
  open,
  onClose,
  profiles,
  activeProfile,
  capabilities,
  credential,
  serverDefault,
  isDesktopRuntime,
  onSelectProfile,
  onAddProfile,
  onDeleteProfile,
  deleteProfileRefusal,
  onUpdateProfile,
  onCapabilityChange,
  connectionRequirement,
  mappedProfileId,
  onMapProfile,
  onUpdateProjectEndpoint,
  pendingDestination,
  onDestinationHandled,
}: ConnectionDrawerProps) {
  const profileRef = useRef<HTMLSelectElement>(null);
  const endpointRef = useRef<HTMLInputElement>(null);
  const toolsCapabilityRef = useRef<HTMLInputElement>(null);
  const mapButtonRef = useRef<HTMLButtonElement>(null);
  const projectEndpointButtonRef = useRef<HTMLButtonElement>(null);
  const keychainActive = isDesktopRuntime && credential.status.canPersist;
  const serverDefaultActive =
    !isDesktopRuntime && activeProfile.credentialRef === "environment-default";
  const usingServerDefault = credential.webMode === "environment-default";
  // Withheld until the probe answers, so an unconfigured server and an
  // unanswered one are never presented as the same thing. Containers only: a
  // `npm run dev` user has .env.example open beside them already.
  const offerServerCredentialHint =
    !isDesktopRuntime &&
    serverDefault.loaded &&
    serverDefault.containerized &&
    !serverDefault.configured;
  const serverOriginMismatch =
    usingServerDefault &&
    !matchesServerOrigin(activeProfile.endpoint, serverDefault.endpoint);
  const serverOrigin = configuredServerOrigin(serverDefault.endpoint);

  useEffect(() => {
    if (!open || pendingDestination?.surface !== "connections") return;
    const target = {
      profile: profileRef.current,
      endpoint: endpointRef.current,
      "tools-capability": toolsCapabilityRef.current,
      "project-mapping": mapButtonRef.current,
      "project-endpoint": projectEndpointButtonRef.current,
    }[pendingDestination.control];
    if (!target) return;
    target.scrollIntoView?.({ block: "center" });
    target.focus();
    onDestinationHandled();
  }, [onDestinationHandled, open, pendingDestination]);

  return (
    <SideDrawer
      open={open}
      title="Connections"
      description="Profiles stay on this device; credentials never enter portable projects."
      onClose={onClose}
    >
      <div className="configuration">
        <div className="section-heading">
          <span>Connection</span>
          <span className="provider-pill">OpenAI compatible</span>
        </div>

        <div className="profile-row">
          <label>
            Profile
            <select
              ref={profileRef}
              data-readiness-control="profile"
              value={activeProfile.id}
              onChange={(event) => onSelectProfile(event.target.value)}
            >
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name || "Untitled profile"}
                </option>
              ))}
            </select>
          </label>
          <button className="text-button" type="button" onClick={onAddProfile}>
            + New
          </button>
          {/* The refusal is carried as the title so the reason is readable on
              the control that is refused, rather than only after a click. */}
          <button
            className="text-button danger"
            type="button"
            disabled={Boolean(deleteProfileRefusal)}
            title={deleteProfileRefusal}
            onClick={onDeleteProfile}
          >
            Delete
          </button>
        </div>
        {connectionRequirement && (
          <ConnectionMapping
            requirement={connectionRequirement}
            activeProfile={activeProfile}
            mapped={mappedProfileId === activeProfile.id}
            onMapProfile={onMapProfile}
            onUpdateProjectEndpoint={onUpdateProjectEndpoint}
            mapButtonRef={mapButtonRef}
            projectEndpointButtonRef={projectEndpointButtonRef}
          />
        )}
        <label>
          Profile name
          <input
            value={activeProfile.name}
            onChange={(event) => onUpdateProfile({ name: event.target.value })}
            spellCheck={false}
          />
        </label>
        <label>
          Endpoint
          <input
            ref={endpointRef}
            data-readiness-control="endpoint"
            value={activeProfile.endpoint}
            onChange={(event) =>
              onUpdateProfile({ endpoint: event.target.value })
            }
            spellCheck={false}
            disabled={serverDefaultActive}
          />
          {serverDefaultActive && (
            <span className="credential-status">
              Managed by server configuration. Create a profile for another provider.
            </span>
          )}
        </label>
        {!isDesktopRuntime && (
          <label>
            Authentication
            <select
              value={credential.webMode}
              onChange={(event) =>
                credential.setWebMode(
                  event.target.value as typeof credential.webMode,
                )
              }
            >
              <option value="none">No authentication</option>
              {/* Kept visible but unselectable when unconfigured: an option
                  that explains why it is unavailable teaches the feature,
                  where a hidden one leaves the user to find it in the docs. */}
              <option
                value="environment-default"
                disabled={serverDefault.loaded && !serverDefault.configured}
              >
                Server default (.env)
                {serverDefault.loaded && !serverDefault.configured
                  ? " — not configured"
                  : ""}
              </option>
              <option value="session">Session key</option>
            </select>
            {usingServerDefault && !serverOriginMismatch && (
              <span className="credential-status">
                The server sends its credential only to its configured origin.
              </span>
            )}
            {serverOriginMismatch && (
              <span className="credential-status credential-status-error">
                {serverOrigin
                  ? `The server's credential is bound to ${serverOrigin} and will not be sent to this endpoint. Choose another authentication mode, or point this profile at the configured provider.`
                  : "This server holds no default credential to send. Choose another authentication mode."}
              </span>
            )}
            {offerServerCredentialHint && <ServerCredentialHint />}
          </label>
        )}
        <label>
          API key {keychainActive ? "(macOS Keychain)" : "(session only)"}
          <input
            type="password"
            value={credential.draft}
            onChange={(event) => credential.setDraft(event.target.value)}
            onBlur={credential.commit}
            disabled={!isDesktopRuntime && usingServerDefault}
            placeholder={
              keychainActive && credential.status.isApprovedForEndpoint
                ? "Stored securely — enter a replacement"
                : !isDesktopRuntime && usingServerDefault
                  ? "Server default selected"
                  : "Enter a key for this endpoint"
            }
            autoComplete="off"
          />
          {keychainActive && credential.status.isApprovedForEndpoint && (
            <span className="credential-status">
              Stored securely in Keychain.
            </span>
          )}
          {credential.error && (
            <span className="credential-status credential-status-error">
              {credential.error}
            </span>
          )}
        </label>
        <label className="capability-toggle">
          <input
            type="checkbox"
            checked={capabilities.modelDiscovery}
            onChange={(event) =>
              onCapabilityChange("modelDiscovery", event.target.checked)
            }
          />
          <span>
            Discover models
            <small>
              Use the provider&apos;s optional <code>/models</code> endpoint.
            </small>
          </span>
        </label>
        <label className="capability-toggle">
          <input
            ref={toolsCapabilityRef}
            data-readiness-control="tools-capability"
            type="checkbox"
            checked={capabilities.tools}
            onChange={(event) =>
              onCapabilityChange("tools", event.target.checked)
            }
          />
          <span>
            Allow tool calling
            <small>
              Send selected tool definitions with requests from this profile.
            </small>
          </span>
        </label>
        <div className="privacy-note">
          <span aria-hidden="true">●</span>
          {keychainActive ? (
            <>
              <strong>Desktop privacy:</strong> credentials stay in macOS Keychain,
              not profiles, project files, or diagnostic traces. Each key is
              limited to this endpoint origin.
            </>
          ) : (
            <>
              <strong>
                {isDesktopRuntime ? "Development privacy:" : "Web privacy:"}
              </strong>{" "}
              this key lasts only for this session—never localStorage, project
              files, diagnostic traces, or an OS credential store.
            </>
          )}
        </div>
      </div>
    </SideDrawer>
  );
}
