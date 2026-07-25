"use client";

import type { ConnectionRequirement } from "../packages/core/src/project";
import type { ProviderCapabilities } from "../packages/core/src/types";
import type { StoredInferenceProfile } from "./profile-store.client";
import type { ProfileCredentialHandle } from "./use-connection-profiles.client";
import { SideDrawer } from "./workbench-shell.client";

interface ConnectionDrawerProps {
  open: boolean;
  onClose(): void;
  profiles: StoredInferenceProfile[];
  activeProfile: StoredInferenceProfile;
  capabilities: ProviderCapabilities;
  credential: ProfileCredentialHandle;
  isDesktopRuntime: boolean;
  onSelectProfile(profileId: string): void;
  onAddProfile(): void;
  onUpdateProfile(patch: Partial<StoredInferenceProfile>): void;
  onCapabilityChange(key: keyof ProviderCapabilities, enabled: boolean): void;
  /** Present only while a project declares a connection to satisfy. */
  connectionRequirement?: ConnectionRequirement;
  mappedProfileId?: string;
  onMapProfile(): void;
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
  isDesktopRuntime,
  onSelectProfile,
  onAddProfile,
  onUpdateProfile,
  onCapabilityChange,
  connectionRequirement,
  mappedProfileId,
  onMapProfile,
}: ConnectionDrawerProps) {
  const keychainActive = isDesktopRuntime && credential.status.canPersist;

  return (
    <SideDrawer
      open={open}
      title="Connections"
      description="Profiles stay on this device. Credentials are never written to portable projects."
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
        </div>
        {connectionRequirement && (
          <div
            className={
              mappedProfileId ? "connection-mapping mapped" : "connection-mapping"
            }
          >
            <strong>
              {mappedProfileId
                ? "Project connection mapped"
                : "Connection mapping required"}
            </strong>
            <span>Project expects {connectionRequirement.endpoint}.</span>
            {mappedProfileId ? (
              activeProfile.endpoint !== connectionRequirement.endpoint && (
                <span>Selected profile uses {activeProfile.endpoint}.</span>
              )
            ) : (
              <button
                className="text-button"
                type="button"
                onClick={onMapProfile}
              >
                Use {activeProfile.name || "selected profile"}
              </button>
            )}
          </div>
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
            value={activeProfile.endpoint}
            onChange={(event) =>
              onUpdateProfile({ endpoint: event.target.value })
            }
            spellCheck={false}
          />
        </label>
        <label>
          API key {keychainActive ? "(macOS Keychain)" : "(session only)"}
          <input
            type="password"
            value={credential.draft}
            onChange={(event) => credential.setDraft(event.target.value)}
            onBlur={credential.commit}
            placeholder={
              keychainActive && credential.status.isApprovedForEndpoint
                ? "Stored securely — enter a replacement"
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
            type="checkbox"
            checked={capabilities.tools}
            onChange={(event) =>
              onCapabilityChange("tools", event.target.checked)
            }
          />
          <span>
            Allow tool calling
            <small>
              Permit requests using this profile to send their selected tool
              definitions.
            </small>
          </span>
        </label>
        <div className="privacy-note">
          <span aria-hidden="true">●</span>
          {keychainActive ? (
            <>
              <strong>Desktop privacy:</strong> credentials are stored in macOS
              Keychain, never in profiles, project files, or diagnostic traces.
              Each key is bound to this endpoint origin.
            </>
          ) : (
            <>
              <strong>
                {isDesktopRuntime ? "Development privacy:" : "Web privacy:"}
              </strong>{" "}
              this key is held only for the current session. It is not saved to
              localStorage, project files, diagnostic traces, or an OS
              credential store.
            </>
          )}
        </div>
      </div>
    </SideDrawer>
  );
}
