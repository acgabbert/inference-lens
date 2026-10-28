"use client";

import { useId, type ComponentProps } from "react";
import type { CredentialSelection, ProviderTurnTransport } from "../../packages/contracts/src";
import type { ConnectionRequirement, PromptTemplate } from "../../packages/core/src/project";
import { effectiveProtocol, sameProviderTarget } from "../../packages/core/src/provider-protocols";
import { resolveProviderCapabilities } from "../../packages/core/src/types";
import { ModelCombobox } from "../model-combobox.client";
import { servesSystemOne, toggleFavoriteModel, type StoredInferenceProfile, type StoredInferenceProfilePatch } from "../profile-store.client";
import { useModelDiscovery } from "../use-model-discovery.client";

/** Device-local services; recommendations continue to store only portable model/connection IDs. */
export interface PromptModelCatalog {
  profiles: StoredInferenceProfile[];
  mappedProfileIds?: Readonly<Record<string, string>>;
  transport: ProviderTurnTransport;
  prepareCredentialForProfile(profileId: string, endpoint: string): Promise<CredentialSelection>;
  updateProfile(profileId: string, patch: StoredInferenceProfilePatch): void;
}

/** Both prompt kinds share recommendation editing and discover only through a matching connection. */
export function RecommendedModelEditor({
  kind, connections, connectionId, model, disabled, catalog, onConnectionChange, onModelChange,
}: {
  kind: PromptTemplate["kind"];
  connections: ConnectionRequirement[];
  connectionId?: ConnectionRequirement["id"];
  model: string;
  disabled: boolean;
  catalog?: PromptModelCatalog;
  onConnectionChange(id: ConnectionRequirement["id"]): void;
  onModelChange(model: string): void;
}) {
  const id = useId();
  const requirement = connections.find(({ id }) => id === connectionId);
  const matches = (candidate: StoredInferenceProfile) => Boolean(
    requirement && candidate.provider === requirement.provider &&
    sameProviderTarget(candidate.endpoint, requirement.endpoint) &&
    (kind !== "decision" || servesSystemOne(candidate)),
  );
  const mappedId = connectionId && catalog?.mappedProfileIds?.[connectionId];
  const profile = catalog?.profiles.find((candidate) => candidate.id === mappedId && matches(candidate))
    ?? catalog?.profiles.find(matches);
  const pickerProps = {
    label: "Recommended model",
    placeholder: "No recommendation",
    disabled: disabled || !connectionId,
    readinessTarget: false,
    allowEmpty: true,
    idPrefix: `recommended-model-${id}`,
    value: model,
    onChange: onModelChange,
  };
  return (
    <section className="recommended-model-editor" aria-label="Model recommendation">
      <h3>Recommended model</h3>
      <p className="template-empty">Optional advice for this prompt. Choosing it does not change the model used by a run or create a content revision.</p>
      <label>
        Recommended connection
        <select aria-label="Recommended connection" disabled={disabled || connections.length === 0}
          value={connectionId ?? ""} onChange={(event) => onConnectionChange(event.target.value as ConnectionRequirement["id"])}>
          {!connectionId && <option value="">Choose a connection</option>}
          {connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
        </select>
      </label>
      {profile && catalog ? (
        <DiscoveredModelPicker key={`${connectionId}:${profile.id}`} kind={kind} profile={profile} catalog={catalog} pickerProps={pickerProps} />
      ) : (
        <ModelCombobox {...pickerProps} key={connectionId ?? "no-connection"} discovery={null}
          onLoadModels={() => {}} favoriteModels={[]} onToggleFavoriteModel={() => {}} />
      )}
      {!disabled && model && <button className="text-button" type="button" onClick={() => onModelChange("")}>Remove recommendation</button>}
      {!profile && <p className="template-empty">Enter a model ID manually. Model discovery needs a matching connection on this device.</p>}
    </section>
  );
}

/** Discovery is mounted only when its connection and credential services exist. */
function DiscoveredModelPicker({ kind, profile, catalog, pickerProps }: {
  kind: PromptTemplate["kind"];
  profile: StoredInferenceProfile;
  catalog: PromptModelCatalog;
  pickerProps: Pick<ComponentProps<typeof ModelCombobox>, "label" | "placeholder" | "disabled" | "readinessTarget" | "allowEmpty" | "idPrefix" | "value" | "onChange">;
}) {
  const capabilities = resolveProviderCapabilities(profile.provider, profile.capabilityOverrides);
  const discovery = useModelDiscovery({
    profileId: profile.id,
    endpoint: profile.endpoint,
    capabilities,
    protocol: kind === "decision" ? "systemone" : effectiveProtocol(capabilities, profile.protocol),
    transport: catalog.transport,
    prepareCredential: () => catalog.prepareCredentialForProfile(profile.id, profile.endpoint),
  });
  return <>
    <ModelCombobox {...pickerProps}
      discovery={discovery.discovery}
      onLoadModels={(force) => void discovery.loadModels(force)}
      favoriteModels={profile.favoriteModels ?? []}
      onToggleFavoriteModel={(model) => catalog.updateProfile(profile.id, { favoriteModels: toggleFavoriteModel(profile.favoriteModels, model) })}
    />
    {kind === "decision" && discovery.discovery?.unfiltered && <p className="template-empty">This server does not mark decision models separately. Enter a decision model ID if it is not listed.</p>}
  </>;
}
