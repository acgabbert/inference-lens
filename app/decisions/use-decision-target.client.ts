"use client";

import { useState } from "react";
import type { CredentialSelection, ProviderTurnTransport } from "../../packages/contracts/src";
import type { DecisionInput, ResolvedDecisionRunInput, ResolvedDecisionTarget } from "../../packages/core/src/decision";
import { createEntityId } from "../../packages/core/src/run-kernel";
import { resolveProviderCapabilities } from "../../packages/core/src/types";
import { servesSystemOne, toggleFavoriteModel } from "../profile-store.client";
import type { StoredInferenceProfile, StoredInferenceProfilePatch } from "../profile-store.client";
import { useModelDiscovery } from "../use-model-discovery.client";
import type { ModelDiscoveryState } from "../use-model-discovery.client";

export interface UseDecisionTargetOptions {
  profiles: StoredInferenceProfile[];
  transport: ProviderTurnTransport;
  prepareCredentialForProfile(profileId: string, endpoint: string): Promise<CredentialSelection>;
  updateProfile(profileId: string, patch: StoredInferenceProfilePatch): void;
}

/** Why a decision cannot be sent to the chosen target yet. */
export type DecisionTargetBlocker =
  | { kind: "no-system-one-connection"; message: string }
  | { kind: "no-model"; message: string };

export interface DecisionTargetHandle {
  /** Only connections that declare System One (D9, U2). */
  profiles: StoredInferenceProfile[];
  profile?: StoredInferenceProfile;
  model: string;
  selectProfile(profileId: string): void;
  setModel(model: string): void;
  /** Favorites are the connection's own, shared with chat's picker. */
  toggleFavoriteModel(model: string): void;
  discovery: ModelDiscoveryState | null;
  loadModels(force?: boolean): Promise<void>;
  blocker?: DecisionTargetBlocker;
  /** Freezes the input and target for one run (D17); undefined while blocked. */
  resolveRun(decision: DecisionInput): ResolvedDecisionRunInput | undefined;
  /** The credential for the target a run was resolved against. */
  prepareCredential(target: ResolvedDecisionTarget): Promise<CredentialSelection>;
}

/**
 * The decision kind's own connection and model (U2, D29). Never chat's: a
 * switch to Decision cannot send to whichever chat model was selected. The
 * choice is session state; models are remembered per connection.
 */
export function useDecisionTarget(options: UseDecisionTargetOptions): DecisionTargetHandle {
  const profiles = options.profiles.filter(servesSystemOne);
  const [chosenProfileId, setChosenProfileId] = useState<string>();
  const [models, setModels] = useState<Record<string, string>>({});
  // A withdrawn declaration or a deleted profile falls back to the first one
  // left rather than keeping a target that can no longer be offered.
  const profile = profiles.find(({ id }) => id === chosenProfileId) ?? profiles[0];
  const model = profile ? models[profile.id] ?? "" : "";
  const capabilities = profile
    ? resolveProviderCapabilities(profile.provider, profile.capabilityOverrides)
    : undefined;

  const { discovery, loadModels } = useModelDiscovery({
    profileId: profile?.id ?? "",
    endpoint: profile?.endpoint ?? "",
    capabilities: capabilities ?? resolveProviderCapabilities("openai-compatible", { modelDiscovery: false }),
    protocol: "systemone",
    transport: options.transport,
    prepareCredential: () =>
      profile
        ? options.prepareCredentialForProfile(profile.id, profile.endpoint)
        : Promise.reject(new Error("No System One connection is selected.")),
  });

  const blocker: DecisionTargetBlocker | undefined = !profile
    ? {
        kind: "no-system-one-connection",
        message: "No connection declares System One. Turn it on for a connection in Connections.",
      }
    : model.trim() === ""
      ? { kind: "no-model", message: "Choose or type a decision model." }
      : undefined;

  return {
    profiles,
    ...(profile ? { profile } : {}),
    model,
    selectProfile: setChosenProfileId,
    setModel(next) {
      if (!profile) return;
      setModels((current) => ({ ...current, [profile.id]: next }));
    },
    toggleFavoriteModel(next) {
      if (!profile) return;
      options.updateProfile(profile.id, { favoriteModels: toggleFavoriteModel(profile.favoriteModels, next) });
    },
    discovery,
    loadModels,
    ...(blocker ? { blocker } : {}),
    resolveRun(decision) {
      if (blocker || !profile || !capabilities) return undefined;
      const suffix = globalThis.crypto.randomUUID();
      return {
        runId: createEntityId("run", suffix),
        resolvedAt: new Date().toISOString(),
        target: {
          profileId: createEntityId("profile", profile.id),
          protocol: "systemone",
          endpoint: profile.endpoint,
          model: model.trim(),
          capabilities,
        },
        decision,
      };
    },
    prepareCredential(target) {
      const resolved = options.profiles.find(({ id }) => createEntityId("profile", id) === target.profileId);
      if (!resolved) return Promise.reject(new Error(`No connection exists for ${target.profileId}.`));
      return options.prepareCredentialForProfile(resolved.id, target.endpoint);
    },
  };
}
