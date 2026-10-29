import {
  discoveryUrl,
  fetchModelListing,
  parseModelsResponse,
} from "./openai-compatible.ts";
import {
  providerBaseEndpoint,
  providerModelsUrl,
} from "./provider-protocols.ts";
import type { ConnectionProtocol } from "./provider-protocols.ts";
import type { ResolvedInferenceRequest } from "./types.ts";

/**
 * Decision-model discovery (D10-B, D13). Each runtime marks decision models
 * differently, so discovery follows whichever marker the server's listing
 * carries. The steps run here, against an injected fetcher, so the web
 * service and the Tauri webview take the same path; a host only turns a
 * listing name into its own URL and relays the parsed body.
 */

/**
 * Which listing a host is asked for. A host builds the URL itself from the
 * name, so a webview cannot direct a credential to an arbitrary URL.
 */
export type ModelListing = "chat" | "decisions" | "ollama-tags";

export interface DecisionModelDiscovery {
  models: string[];
  /** Nothing in the server's listings marked decision models apart. */
  unfiltered?: true;
}

/**
 * The URL for a listing, or undefined when the endpoint gives no basis for
 * one. `ollama-tags` is Ollama's native listing at the server root, derived
 * by removing a trailing `/v1`; any other base has no such layout to guess.
 */
export function modelListingUrl(
  endpoint: string,
  protocol: ConnectionProtocol,
  listing: ModelListing,
): string | undefined {
  switch (listing) {
    case "chat":
      return discoveryUrl(endpoint, protocol);
    case "decisions": {
      const url = new URL(providerModelsUrl(endpoint));
      url.searchParams.set("output_modalities", "decisions");
      return url.toString();
    }
    case "ollama-tags": {
      const base = new URL(providerBaseEndpoint(endpoint));
      if (!base.pathname.endsWith("/v1")) return undefined;
      base.pathname = `${base.pathname.slice(0, -"/v1".length)}/api/tags`;
      base.search = "";
      return base.toString();
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortedUnique(ids: string[]): string[] {
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
}

/**
 * Entries of an OpenAI-shaped listing whose `architecture.output_modalities`
 * names decisions, or undefined when no entry carries the marker. An
 * Ollama-style `models[]` in the same body is ignored: llama.cpp sends one
 * that labels its decision model `completion`.
 */
function markedDecisionModels(body: unknown): string[] | undefined {
  if (!isRecord(body) || !Array.isArray(body.data)) return undefined;
  const marked = body.data.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string") return [];
    const architecture = entry.architecture;
    const modalities = isRecord(architecture) ? architecture.output_modalities : undefined;
    return Array.isArray(modalities) && modalities.includes("decisions") ? [entry.id] : [];
  });
  return marked.length > 0 ? sortedUnique(marked) : undefined;
}

/** Ollama `/api/tags` entries whose `capabilities` include `decision`. */
function taggedDecisionModels(body: unknown): string[] | undefined {
  if (!isRecord(body) || !Array.isArray(body.models)) return undefined;
  const tagged = body.models.flatMap((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry.capabilities)) return [];
    if (!entry.capabilities.includes("decision")) return [];
    const name = typeof entry.name === "string" ? entry.name : entry.model;
    return typeof name === "string" ? [name] : [];
  });
  return tagged.length > 0 ? sortedUnique(tagged) : undefined;
}

/**
 * Runs D10's three steps. A failure of the first listing is the discovery
 * error, as it is for chat. The tags request is a layout guess, so its
 * failure only means the listing stays unfiltered.
 */
export async function discoverDecisionModels(
  endpoint: string,
  fetchListing: (listing: ModelListing) => Promise<unknown>,
): Promise<DecisionModelDiscovery> {
  const listing = await fetchListing("decisions");
  const marked = markedDecisionModels(listing);
  if (marked) return { models: marked };

  if (modelListingUrl(endpoint, "systemone", "ollama-tags")) {
    const tags = await fetchListing("ollama-tags").catch(() => undefined);
    const tagged = taggedDecisionModels(tags);
    if (tagged) return { models: tagged };
  }

  return { models: parseModelsResponse(listing), unfiltered: true };
}

/**
 * Decision-model discovery over `fetch`, for a host that holds the credential
 * in-process. The credential is presented as System One presents it.
 */
export async function discoverDecisionModelsOverHttp(
  request: Pick<ResolvedInferenceRequest, "endpoint" | "apiKey" | "capabilities">,
  signal?: AbortSignal,
): Promise<DecisionModelDiscovery> {
  if (!request.capabilities.modelDiscovery) {
    throw new Error("Model discovery is not supported by this profile.");
  }
  return discoverDecisionModels(request.endpoint, (listing) =>
    fetchModelListing(
      modelListingUrl(request.endpoint, "systemone", listing)!,
      "systemone",
      request.apiKey,
      signal,
    ),
  );
}
