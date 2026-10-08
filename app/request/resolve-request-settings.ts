import type {
  ConnectionRequirement,
  ProjectFile,
} from "../../packages/core/src/project.ts";
import type { ConversationMessage } from "../../packages/core/src/run-kernel/types.ts";
import { resolveProviderCapabilities } from "../../packages/core/src/types.ts";
import {
  effectiveProtocol,
  supportedProtocols,
  supportsProtocol,
} from "../../packages/core/src/provider-protocols.ts";
import type { ProviderWireProtocol } from "../../packages/core/src/run-kernel/types.ts";
import type {
  InferenceProfile,
  ProviderCapabilities,
  RichInferenceRequest,
} from "../../packages/core/src/types.ts";

export interface RequestSettingsInput<Profile extends InferenceProfile> {
  projectFile: ProjectFile | null;
  /** Device-local mapping from the project's connection requirements to profiles. */
  mappedProfileIds: Readonly<Record<string, string>>;
  profiles: readonly Profile[];
  activeProfile: Profile;
  /** The project's model and temperature for this session; unused without a project. */
  sessionModel: string | undefined;
  sessionTemperature: number | undefined;
  streamingPreferred: boolean;
}

/** What the next composer run is sent with, and the profile that serves it. */
export interface ResolvedRequestSettings<Profile extends InferenceProfile> {
  /** The project's default target requirement; `undefined` without a project. */
  connectionRequirement: ConnectionRequirement | undefined;
  profile: Profile;
  /** Whether the requirement's mapping names a profile that still exists. */
  profileMapped: boolean;
  capabilities: ProviderCapabilities;
  /**
   * The wire protocol the run is sent with. A project's requirement states it
   * outright; without a project the profile's preference picks among what the
   * profile supports.
   */
  protocol: ProviderWireProtocol;
  /** False when the project asks for a protocol its mapped profile has not enabled. */
  protocolSupported: boolean;
  supportedProtocols: ProviderWireProtocol[];
  model: string;
  temperature: number | undefined;
  responseMode: "streaming" | "buffered";
}

export function resolveRequestSettings<Profile extends InferenceProfile>(
  input: RequestSettingsInput<Profile>,
): ResolvedRequestSettings<Profile> {
  const { projectFile, mappedProfileIds, profiles, activeProfile } = input;
  const connectionRequirement = projectFile?.connectionRequirements.find(
    ({ id }) => id === projectFile.defaults.target.connectionRequirementId,
  );
  const mappedProfile = connectionRequirement
    ? profiles.find(({ id }) => id === mappedProfileIds[connectionRequirement.id])
    : undefined;
  // A project's device-local mapping owns execution. The active profile only
  // owns which definition the Connections drawer is editing.
  const profile = projectFile ? mappedProfile ?? activeProfile : activeProfile;
  const capabilities = resolveProviderCapabilities(
    profile.provider,
    profile.capabilityOverrides,
  );
  const protocol = connectionRequirement
    ? connectionRequirement.protocol
    : effectiveProtocol(capabilities, profile.protocol);
  return {
    connectionRequirement,
    profile,
    profileMapped: Boolean(mappedProfile),
    capabilities,
    protocol,
    protocolSupported: supportsProtocol(capabilities, protocol),
    supportedProtocols: supportedProtocols(capabilities),
    model: input.sessionModel ?? profile.model,
    // Without a project there is no session layer: the profile is edited directly.
    temperature: projectFile ? input.sessionTemperature : profile.temperature,
    responseMode:
      input.streamingPreferred && capabilities.streaming ? "streaming" : "buffered",
  };
}

export function requestFromSettings(
  settings: ResolvedRequestSettings<InferenceProfile>,
  messages: ConversationMessage[],
): RichInferenceRequest {
  return {
    provider: "openai-compatible",
    protocol: settings.protocol,
    endpoint: settings.profile.endpoint,
    model: settings.model,
    messages,
    temperature: settings.temperature,
    responseMode: settings.responseMode,
    capabilities: settings.capabilities,
  };
}
