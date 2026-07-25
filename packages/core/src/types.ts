export type MessageRole = "system" | "user" | "assistant" | "tool";

/**
 * Feature support declared for a connection before Trace Lens constructs a
 * provider request. These are transport/protocol capabilities, not claims
 * about a model's quality or reliability.
 */
export interface ProviderCapabilities {
  chatCompletions: boolean;
  responsesApi: boolean;
  streaming: boolean;
  modelDiscovery: boolean;
  tools: boolean;
  parallelToolCalls: boolean;
  structuredOutput: boolean;
  vision: boolean;
  embeddings: boolean;
}

export type ProviderCapabilityOverrides = Partial<ProviderCapabilities>;

const providerCapabilityKeys = [
  "chatCompletions",
  "responsesApi",
  "streaming",
  "modelDiscovery",
  "tools",
  "parallelToolCalls",
  "structuredOutput",
  "vision",
  "embeddings",
] as const satisfies readonly (keyof ProviderCapabilities)[];

/** Safe baseline for the adapter currently implemented by the workbench. */
export const OPENAI_COMPATIBLE_CAPABILITIES: ProviderCapabilities = Object.freeze({
  chatCompletions: true,
  responsesApi: false,
  streaming: true,
  modelDiscovery: true,
  tools: false,
  parallelToolCalls: false,
  structuredOutput: false,
  vision: false,
  embeddings: false,
});

export function isProviderCapabilityOverrides(
  value: unknown,
): value is ProviderCapabilityOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([key, capability]) =>
      providerCapabilityKeys.includes(key as keyof ProviderCapabilities) &&
      typeof capability === "boolean",
  );
}

export function isProviderCapabilities(
  value: unknown,
): value is ProviderCapabilities {
  return (
    isProviderCapabilityOverrides(value) &&
    providerCapabilityKeys.every((key) => key in value)
  );
}

/**
 * Produces the secret-free capability snapshot used for a request/run. A
 * profile may adjust this when a local server or gateway differs from the
 * adapter baseline; endpoint shape alone is never used as evidence.
 */
export function resolveProviderCapabilities(
  provider: "openai-compatible",
  overrides?: ProviderCapabilityOverrides,
): ProviderCapabilities {
  switch (provider) {
    case "openai-compatible":
      return providerCapabilityKeys.reduce<ProviderCapabilities>(
        (capabilities, key) => ({
          ...capabilities,
          [key]:
            typeof overrides?.[key] === "boolean"
              ? overrides[key]
              : OPENAI_COMPATIBLE_CAPABILITIES[key],
        }),
        {} as ProviderCapabilities,
      );
  }
}

export interface InferenceMessage {
  role: MessageRole;
  content: string;
}

export interface InferenceRequest {
  provider: "openai-compatible";
  endpoint: string;
  model: string;
  messages: InferenceMessage[];
  temperature?: number;
  /** Resolved at request creation and serialized with portable projects. */
  capabilities?: ProviderCapabilities;
}

/**
 * The short-lived input passed across the application execution boundary.
 * It must never be saved in project files, run traces, or profile metadata.
 */
export interface ResolvedInferenceRequest
  extends Omit<InferenceRequest, "capabilities"> {
  apiKey: string;
  capabilities: ProviderCapabilities;
}

/**
 * A reusable, secret-free connection preset. The credential reference is
 * meaningful only to the local application that owns the credential store.
 */
export interface InferenceProfile {
  id: string;
  name: string;
  provider: "openai-compatible";
  endpoint: string;
  model: string;
  temperature?: number;
  /** Conservative adjustments to the adapter's protocol defaults. */
  capabilityOverrides?: ProviderCapabilityOverrides;
  credentialRef?: string;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}
