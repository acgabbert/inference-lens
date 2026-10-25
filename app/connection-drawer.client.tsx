"use client";

import { useEffect, useRef, type RefObject } from "react";
import type { ConnectionRequirement } from "../packages/core/src/project";
import { sameChatCompletionsTarget } from "../packages/core/src/openai-compatible";
import {
  protocolCapabilityKey,
  protocolLabel,
  protocolPath,
  supportedProtocols,
} from "../packages/core/src/provider-protocols";
import { PROVIDER_WIRE_PROTOCOLS } from "../packages/core/src/run-kernel/types";
import type { ProviderWireProtocol } from "../packages/core/src/run-kernel/types";
import type { ProviderCapabilities } from "../packages/core/src/types";
import { servesSystemOne } from "./profile-store.client";
import type {
  StoredInferenceProfile,
  StoredInferenceProfilePatch,
} from "./profile-store.client";
import type { ProfileCredentialHandle } from "./use-connection-profiles.client";
import {
  managingConnectionId,
  serverConnectionFor,
  serverManagesProtocols,
} from "./server-connection-profiles";
import type { ServerConnection, ServerStatus } from "./server-connection-profiles";
import {
  serverConnectionOfMode,
  webCredentialModeFromStorage,
  webCredentialModeToStorage,
} from "./web-credential-mode";
import { DEFAULT_SERVER_CONNECTION_ID } from "../packages/core/src/server-connection-catalog";
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

const protocolDescriptions: Record<ProviderWireProtocol, string> = {
  "openai-compatible-chat-completions": "OpenAI-compatible servers, including most local ones.",
  "openai-responses": "The OpenAI Responses API.",
  "anthropic-messages": "The native Anthropic API; the key is sent as x-api-key.",
};

/**
 * The API families a profile speaks, for the section heading. Derived from its
 * enabled protocols so an Anthropic-only connection is not labelled OpenAI.
 */
function providerFamilies(capabilities: ProviderCapabilities): string | undefined {
  const families = new Set(
    supportedProtocols(capabilities).map((protocol) =>
      protocol === "anthropic-messages" ? "Anthropic" : "OpenAI compatible",
    ),
  );
  return families.size === 0 ? undefined : [...families].join(" + ");
}

/**
 * The server keys a user-made profile may choose from: each connection that
 * holds one and would release it to this endpoint (decision 7). Another
 * origin's key could never be sent here, so offering it would only offer a
 * failure. `default` is not among them; it keeps its own, always-listed option.
 */
function catalogKeyOptions(
  connections: readonly ServerConnection[],
  endpoint: string,
): ServerConnection[] {
  return connections.filter(
    (connection) =>
      connection.id !== DEFAULT_SERVER_CONNECTION_ID &&
      connection.credentialConfigured &&
      matchesServerOrigin(endpoint, connection.endpoint),
  );
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
  server: ServerStatus;
  isDesktopRuntime: boolean;
  onSelectProfile(profileId: string): void;
  onAddProfile(): void;
  onDeleteProfile(): void;
  /** Absent when the active profile can be deleted; otherwise why it cannot. */
  deleteProfileRefusal?: string;
  onUpdateProfile(patch: StoredInferenceProfilePatch): void;
  /** The device-local System One declaration (D9-B). */
  onSystemOneChange(enabled: boolean): void;
  onCapabilityChange(key: keyof ProviderCapabilities, enabled: boolean): void;
  /** Portable requirements in the open project and their device-local joins. */
  connectionRequirements?: readonly ConnectionRequirement[];
  mappedProfileIds: Readonly<Record<string, string>>;
  onMapProfile(requirementId: string, profileId: string): void;
  /** Re-points the project's declared connection at the mapped profile. */
  onUpdateProjectEndpoint(requirementId: string): void;
  pendingDestination?: ReadinessDestination;
  onDestinationHandled(): void;
  authoringNotice?: string;
}

/**
 * The project's declared endpoint beside the one the selected profile will
 * actually call. A mapping is allowed to point somewhere else — a project
 * moved between a hosted provider and a local server is the normal case — so
 * the mismatch is reported rather than refused.
 */
function ConnectionMappings({
  requirements,
  profiles,
  mappedProfileIds,
  onMapProfile,
  onUpdateProjectEndpoint,
  mappingRefs,
  endpointRefs,
}: {
  requirements: readonly ConnectionRequirement[];
  profiles: readonly StoredInferenceProfile[];
  mappedProfileIds: Readonly<Record<string, string>>;
  onMapProfile(requirementId: string, profileId: string): void;
  onUpdateProjectEndpoint(requirementId: string): void;
  mappingRefs: RefObject<Map<string, HTMLSelectElement>>;
  endpointRefs: RefObject<Map<string, HTMLButtonElement>>;
}) {
  return (
    <div className="project-connection-mappings">
      <div className="section-heading"><span>Project mappings</span><span>{requirements.length}</span></div>
      <small>Each portable connection requirement maps explicitly to one profile on this device.</small>
      {requirements.map((requirement) => {
        const mappedProfile = profiles.find(({ id }) => id === mappedProfileIds[requirement.id]);
        const mismatched = mappedProfile
          ? !sameChatCompletionsTarget(mappedProfile.endpoint, requirement.endpoint)
          : false;
        return (
          <div className={`connection-mapping${mappedProfile && !mismatched ? " mapped" : ""}`} key={requirement.id}>
            <strong>{!mappedProfile ? "Connection mapping required" : mismatched ? "Mapped to a different endpoint" : "Project connection mapped"}</strong>
            <label>{requirement.name}
              <select
                ref={(element) => {
                  if (element) mappingRefs.current.set(requirement.id, element);
                  else mappingRefs.current.delete(requirement.id);
                }}
                aria-label={`Profile for ${requirement.name}`}
                data-readiness-control="project-mapping"
                value={mappedProfile?.id ?? ""}
                onChange={(event) => onMapProfile(requirement.id, event.target.value)}
              >
                <option value="" disabled>Choose a local profile</option>
                {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name || "Untitled profile"}</option>)}
              </select>
            </label>
            <span>Project expects <code>{requirement.endpoint}</code></span>
            {mappedProfile && mismatched && <>
              <span>Requests go to <code>{mappedProfile.endpoint}</code></span>
              <button
                ref={(element) => {
                  if (element) endpointRefs.current.set(requirement.id, element);
                  else endpointRefs.current.delete(requirement.id);
                }}
                className="text-button"
                data-readiness-control="project-endpoint"
                type="button"
                onClick={() => onUpdateProjectEndpoint(requirement.id)}
              >
                Update &ldquo;{requirement.name}&rdquo; to expect this endpoint
              </button>
            </>}
          </div>
        );
      })}
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
  server,
  isDesktopRuntime,
  onSelectProfile,
  onAddProfile,
  onDeleteProfile,
  deleteProfileRefusal,
  onUpdateProfile,
  onSystemOneChange,
  onCapabilityChange,
  connectionRequirements = [],
  mappedProfileIds,
  onMapProfile,
  onUpdateProjectEndpoint,
  pendingDestination,
  onDestinationHandled,
  authoringNotice,
}: ConnectionDrawerProps) {
  const profileRef = useRef<HTMLSelectElement>(null);
  const endpointRef = useRef<HTMLInputElement>(null);
  const toolsCapabilityRef = useRef<HTMLInputElement>(null);
  const protocolRefs = useRef(new Map<ProviderWireProtocol, HTMLInputElement>());
  const mappingRefs = useRef(new Map<string, HTMLSelectElement>());
  const projectEndpointRefs = useRef(new Map<string, HTMLButtonElement>());
  const keychainActive = isDesktopRuntime && credential.status.canPersist;
  // Locked whenever the profile is the server's, reported or not: a profile
  // whose connection has not answered is held, never handed back early.
  const serverProfileActive =
    !isDesktopRuntime && managingConnectionId(activeProfile) !== undefined;
  const activeServerConnection = isDesktopRuntime
    ? undefined
    : serverConnectionFor(activeProfile, server);
  const selectedServerKey = serverConnectionOfMode(credential.webMode);
  const usingServerKey = selectedServerKey !== undefined;
  const selectedConnection = server.connections.find(
    ({ id }) => id === selectedServerKey,
  );
  const defaultConnection = server.connections.find(
    ({ id }) => id === DEFAULT_SERVER_CONNECTION_ID,
  );
  const defaultKeyConfigured = defaultConnection?.credentialConfigured === true;
  // The selected key stays listed even when it no longer qualifies, so the
  // control shows what is chosen and the warning below explains why it fails.
  const catalogOptions = catalogKeyOptions(server.connections, activeProfile.endpoint);
  if (
    selectedConnection &&
    selectedConnection.id !== DEFAULT_SERVER_CONNECTION_ID &&
    !catalogOptions.includes(selectedConnection)
  ) {
    catalogOptions.push(selectedConnection);
  }
  // Withheld until the probe answers, so an unconfigured server and an
  // unanswered one are never presented as the same thing. Containers only: a
  // `npm run dev` user has .env.example open beside them already.
  const offerServerCredentialHint =
    !isDesktopRuntime &&
    server.loaded &&
    server.containerized &&
    !server.connections.some(({ credentialConfigured }) => credentialConfigured);
  const serverOriginMismatch =
    usingServerKey &&
    !matchesServerOrigin(activeProfile.endpoint, selectedConnection?.endpoint);
  const serverOrigin = configuredServerOrigin(selectedConnection?.endpoint);
  const selectedIsDefault = selectedServerKey === DEFAULT_SERVER_CONNECTION_ID;
  const providerFamily = providerFamilies(capabilities);
  // Locked the way the endpoint is; see `serverManagesProtocols`.
  const protocolsManaged = serverManagesProtocols(
    activeProfile,
    server,
    isDesktopRuntime,
  );


  useEffect(() => {
    if (!open || pendingDestination?.surface !== "connections") return;
    const target = {
      profile: profileRef.current,
      endpoint: endpointRef.current,
      "tools-capability": toolsCapabilityRef.current,
      protocols: protocolRefs.current.get(
        pendingDestination.protocol ?? PROVIDER_WIRE_PROTOCOLS[0],
      ),
      "project-mapping": connectionRequirements
        .map(({ id }) => mappingRefs.current.get(id))
        .find((element) => element?.value === "") ?? mappingRefs.current.values().next().value,
      "project-endpoint": projectEndpointRefs.current.values().next().value,
    }[pendingDestination.control];
    if (!target) return;
    target.scrollIntoView?.({ block: "center" });
    target.focus();
    onDestinationHandled();
  }, [connectionRequirements, onDestinationHandled, open, pendingDestination]);

  return (
    <SideDrawer
      open={open}
      title="Connections"
      description="Profiles stay on this device; credentials never enter portable projects."
      onClose={onClose}
    >
      <div className="configuration">
        {authoringNotice && (
          <div className="template-warning" role="status">
            {authoringNotice}
          </div>
        )}
        <div className="section-heading">
          <span>Connection</span>
          {providerFamily && <span className="provider-pill">{providerFamily}</span>}
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
        {connectionRequirements.length > 0 && (
          <ConnectionMappings
            requirements={connectionRequirements}
            profiles={profiles}
            mappedProfileIds={mappedProfileIds}
            onMapProfile={onMapProfile}
            onUpdateProjectEndpoint={onUpdateProjectEndpoint}
            mappingRefs={mappingRefs}
            endpointRefs={projectEndpointRefs}
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
            disabled={serverProfileActive}
          />
          {serverProfileActive && (
            <span className="credential-status">
              Managed by server configuration. Create a profile for another provider.
            </span>
          )}
        </label>
        {!isDesktopRuntime && (
          <label>
            Authentication
            <select
              value={webCredentialModeToStorage(credential.webMode)}
              onChange={(event) => {
                const mode = webCredentialModeFromStorage(event.target.value);
                if (mode) credential.setWebMode(mode);
              }}
            >
              <option value="none">No authentication</option>
              {/* Kept visible but unselectable when unconfigured: an option
                  that explains why it is unavailable teaches the feature,
                  where a hidden one leaves the user to find it in the docs. */}
              <option
                value="environment-default"
                disabled={server.loaded && !defaultKeyConfigured}
              >
                Server default (.env)
                {server.loaded && !defaultKeyConfigured
                  ? " — not configured"
                  : ""}
              </option>
              {catalogOptions.map((connection) => (
                <option
                  key={connection.id}
                  value={webCredentialModeToStorage({ server: connection.id })}
                >
                  Server: {connection.name}
                </option>
              ))}
              <option value="session">Session key</option>
            </select>
            {usingServerKey && !serverOriginMismatch && (
              <span className="credential-status">
                The server sends its credential only to its configured origin.
              </span>
            )}
            {serverOriginMismatch && (
              <span className="credential-status credential-status-error">
                {serverOrigin
                  ? `The server's credential${selectedIsDefault ? "" : ` for "${selectedConnection!.name}"`} is bound to ${serverOrigin} and will not be sent to this endpoint. Choose another authentication mode, or point this profile at the configured provider.`
                  : selectedIsDefault
                    ? "This server holds no default credential to send. Choose another authentication mode."
                    : "This server no longer holds that connection's credential. Choose another authentication mode."}
              </span>
            )}
            {activeServerConnection?.problem && (
              <span className="credential-status credential-status-error" role="status">
                The server holds no key for this connection: {activeServerConnection.problem}
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
            disabled={!isDesktopRuntime && usingServerKey}
            placeholder={
              keychainActive && credential.status.isApprovedForEndpoint
                ? "Stored securely — enter a replacement"
                : !isDesktopRuntime && usingServerKey
                  ? "Server key selected"
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
        <fieldset className="protocol-capabilities">
          <legend>Protocols</legend>
          <small>
            Which APIs this endpoint speaks. Each run picks one in Run settings.
          </small>
          {PROVIDER_WIRE_PROTOCOLS.map((protocol) => {
            const key = protocolCapabilityKey(protocol);
            return (
              <label className="capability-toggle" key={protocol}>
                <input
                  ref={(element) => {
                    if (element) protocolRefs.current.set(protocol, element);
                    else protocolRefs.current.delete(protocol);
                  }}
                  data-readiness-control="protocols"
                  type="checkbox"
                  checked={capabilities[key]}
                  disabled={protocolsManaged}
                  onChange={(event) => onCapabilityChange(key, event.target.checked)}
                />
                <span>
                  {protocolLabel(protocol)} <code>{protocolPath(protocol)}</code>
                  <small>{protocolDescriptions[protocol]}</small>
                </span>
              </label>
            );
          })}
          {/*
            Device-local, outside the portable snapshot (D9-B): it decides
            only which connections Compose → Decision offers. The server
            locks it with the chat APIs when it declares its list (D9a).
          */}
          <label className="capability-toggle">
            <input
              type="checkbox"
              checked={servesSystemOne(activeProfile)}
              disabled={protocolsManaged}
              onChange={(event) => onSystemOneChange(event.target.checked)}
            />
            <span>
              {protocolLabel("systemone")} <code>{protocolPath("systemone")}</code>
              <small>Decision requests: choice, score, and true/false questions. Offered in Compose → Decision.</small>
            </span>
          </label>
          {protocolsManaged && activeServerConnection && (
            <span className="credential-status">
              {activeServerConnection.id === DEFAULT_SERVER_CONNECTION_ID ? (
                <>
                  Managed by <code>INFERENCE_LENS_API_PROTOCOLS</code>. Enabling
                  another API means changing that variable on the server.
                </>
              ) : (
                <>
                  Managed by the server&apos;s connection catalog
                  (<code>INFERENCE_LENS_CONNECTIONS</code>). Enabling another
                  API means changing its &quot;{activeServerConnection.id}&quot; entry.
                </>
              )}
            </span>
          )}
          {activeServerConnection?.unrecognizedProtocols && (
            <span className="credential-status" role="status">
              {activeServerConnection.id === DEFAULT_SERVER_CONNECTION_ID ? (
                <code>INFERENCE_LENS_API_PROTOCOLS</code>
              ) : (
                <>The protocol list for &quot;{activeServerConnection.id}&quot;</>
              )}{" "}
              was ignored: it names{" "}
              {activeServerConnection.unrecognizedProtocols.map((name) => `"${name}"`).join(", ")},
              which the server does not recognize.
            </span>
          )}
        </fieldset>
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
              Allow attached tool definitions on requests from this profile.
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
