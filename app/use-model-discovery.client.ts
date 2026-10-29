"use client";

import { useRef, useState } from "react";
import type {
  CredentialSelection,
  ProviderTurnTransport,
} from "../packages/contracts/src/index.ts";
import type { ProviderCapabilities } from "../packages/core/src/types.ts";
import type { ConnectionProtocol } from "../packages/core/src/provider-protocols.ts";

export type ModelDiscoveryStatus = "idle" | "loading" | "loaded" | "failed";

export type ModelDiscoveryState = {
  profileKey: string;
  status: ModelDiscoveryStatus;
  models: string[];
  /** A decision listing in which nothing marked decision models apart (D10). */
  unfiltered?: true;
  error?: string;
};

/**
 * Discovery results are cached per profile *and* endpoint: pointing the same
 * profile at a different base URL is a different model catalogue. NUL
 * separates the parts because neither a generated profile id nor a URL can
 * contain one, so no pair of distinct inputs produces the same key.
 */
export function modelProfileKey(profileId: string, endpoint: string): string {
  return `${profileId}\u0000${endpoint}`;
}

/** Case-insensitive substring match, so `gpt4` finds `GPT-4`-style ids. */
export function filterModels(models: string[], filter: string): string[] {
  const needle = filter.toLowerCase();
  return models.filter((model) => model.toLowerCase().includes(needle));
}

export type ModelDiscoveryInput = {
  profileId: string;
  endpoint: string;
  /** Resolved by the caller; discovery is refused when unsupported. */
  capabilities: ProviderCapabilities;
  /**
   * Decides how the credential is presented to the listing; `systemone` asks
   * for decision models (D10, D19).
   */
  protocol: ConnectionProtocol;
  transport: ProviderTurnTransport;
  prepareCredential: () => Promise<CredentialSelection>;
};

export type ModelDiscoveryHandle = {
  /** Null whenever the last result belongs to a different profile/endpoint. */
  discovery: ModelDiscoveryState | null;
  loadModels: (force?: boolean) => Promise<void>;
};

/**
 * Owns the model catalogue for the active profile. Results are cached across
 * profile switches and stale responses are discarded, so reopening the picker
 * mid-flight cannot show another endpoint's models.
 */
export function useModelDiscovery(
  input: ModelDiscoveryInput,
): ModelDiscoveryHandle {
  const { profileId, endpoint, capabilities, protocol, transport, prepareCredential } =
    input;
  const [discovery, setDiscovery] = useState<ModelDiscoveryState | null>(null);
  const cacheRef = useRef(new Map<string, { models: string[]; unfiltered?: true }>());
  const requestRef = useRef(0);
  // The protocol joins the key because it changes the credential header: a
  // listing refused under one protocol may succeed under another.
  const profileKey = `${modelProfileKey(profileId, endpoint)}\u0000${protocol}`;

  async function loadModels(force = false): Promise<void> {
    if (!capabilities.modelDiscovery) {
      setDiscovery({
        profileKey,
        status: "failed",
        models: [],
        error:
          "Model discovery is not supported by this profile. Enter a model ID manually.",
      });
      return;
    }
    const cached = cacheRef.current.get(profileKey);
    if (cached && !force) {
      setDiscovery({ profileKey, status: "loaded", ...cached });
      return;
    }

    const requestId = ++requestRef.current;
    setDiscovery({ profileKey, status: "loading", models: [] });
    try {
      const credential = await prepareCredential();
      const { models, unfiltered } = await transport.discoverModels({
        endpoint,
        protocol,
        capabilities,
        credential,
      });
      const listing = { models, ...(unfiltered ? { unfiltered } : {}) };
      cacheRef.current.set(profileKey, listing);
      if (requestId === requestRef.current) {
        setDiscovery({ profileKey, status: "loaded", ...listing });
      }
    } catch (error) {
      if (requestId === requestRef.current) {
        setDiscovery({
          profileKey,
          status: "failed",
          models: [],
          error:
            error instanceof Error ? error.message : "Could not list models.",
        });
      }
    }
  }

  return {
    discovery: discovery?.profileKey === profileKey ? discovery : null,
    loadModels,
  };
}
