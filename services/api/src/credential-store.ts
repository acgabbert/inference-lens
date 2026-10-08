import type { CredentialSelection } from "../../../packages/contracts/src/index.ts";
import { PROVIDER_WIRE_PROTOCOLS } from "../../../packages/core/src/run-kernel/types.ts";
import type { ProviderWireProtocol } from "../../../packages/core/src/run-kernel/types.ts";

/** The names `INFERENCE_LENS_API_PROTOCOLS` accepts, short and full. */
const protocolNames: Record<string, ProviderWireProtocol> = {
  "chat-completions": "openai-compatible-chat-completions",
  responses: "openai-responses",
  "anthropic-messages": "anthropic-messages",
  ...Object.fromEntries(PROVIDER_WIRE_PROTOCOLS.map((protocol) => [protocol, protocol])),
};

/**
 * Parses a comma-separated protocol list. A list naming anything unknown is
 * refused whole: applying the recognizable part of a typo would quietly run a
 * protocol nobody asked for.
 */
export function parseServerProtocols(
  value: string | undefined,
): ProviderWireProtocol[] | undefined {
  const names = value?.split(",").map((name) => name.trim()).filter(Boolean) ?? [];
  if (names.length === 0) return undefined;
  const protocols = names.map((name) => protocolNames[name]);
  if (protocols.some((protocol) => protocol === undefined)) return undefined;
  return PROVIDER_WIRE_PROTOCOLS.filter((protocol) => protocols.includes(protocol));
}

export interface CredentialStore {
  resolve(selection: CredentialSelection, endpoint: string): string;
}

/**
 * Compose's first credential adapter. It reads a server-only environment value
 * at request time and releases it only to its configured provider origin, so
 * the same image can be configured per developer without exposing the key in
 * browser JavaScript or allowing a request to redirect it.
 */
export class EnvironmentCredentialStore implements CredentialStore {
  private readonly environment: Record<string, string | undefined>;
  private readonly credentialVariableName: string;
  private readonly endpointVariableName: string;
  private readonly modelVariableName: string;
  private readonly protocolsVariableName: string;

  constructor(
    environment: Record<string, string | undefined>,
    credentialVariableName = "INFERENCE_LENS_API_KEY",
    endpointVariableName = "INFERENCE_LENS_API_ENDPOINT",
    modelVariableName = "INFERENCE_LENS_MODEL",
    protocolsVariableName = "INFERENCE_LENS_API_PROTOCOLS",
  ) {
    this.environment = environment;
    this.credentialVariableName = credentialVariableName;
    this.endpointVariableName = endpointVariableName;
    this.modelVariableName = modelVariableName;
    this.protocolsVariableName = protocolsVariableName;
  }

  /** Safe to expose to the same-origin UI; never exposes the credential itself. */
  isConfigured(): boolean {
    const endpoint = this.environment[this.endpointVariableName]?.trim();
    return Boolean(
      this.environment[this.credentialVariableName]?.trim() &&
        endpoint &&
        safeEndpointForClient(endpoint),
    );
  }

  /**
   * Non-secret connection metadata suitable for the same-origin UI. Deliberately
   * independent of `isConfigured()`: a local provider that needs no key at all
   * is a supported configuration, and prefilling its endpoint is the whole
   * point of setting the variable. Callers report the credential separately.
   */
  connectionConfiguration():
    | { endpoint: string; model?: string; protocols?: ProviderWireProtocol[] }
    | undefined {
    const endpoint = this.environment[this.endpointVariableName]?.trim();
    if (!endpoint) return undefined;
    const safeEndpoint = safeEndpointForClient(endpoint);
    if (!safeEndpoint) return undefined;
    const model = this.environment[this.modelVariableName]?.trim();
    const protocols = parseServerProtocols(
      this.environment[this.protocolsVariableName],
    );
    return {
      endpoint: safeEndpoint,
      ...(model ? { model } : {}),
      ...(protocols ? { protocols } : {}),
    };
  }

  resolve(selection: CredentialSelection, endpoint: string): string {
    if (selection.kind === "none") return "";
    if (selection.kind === "provided") return selection.apiKey;

    const apiKey = this.environment[this.credentialVariableName]?.trim();
    if (!apiKey) {
      throw new Error(
        `No default credential is configured. Set ${this.credentialVariableName} for the API service or provide a session key.`,
      );
    }
    const configuredEndpoint =
      this.environment[this.endpointVariableName]?.trim();
    if (!configuredEndpoint) {
      throw new Error(
        `The default credential is not bound to a provider. Set ${this.endpointVariableName} for the API service.`,
      );
    }
    const configuredOrigin = providerOrigin(
      configuredEndpoint,
      this.endpointVariableName,
    );
    const requestedOrigin = providerOrigin(endpoint, "request endpoint");
    if (requestedOrigin !== configuredOrigin) {
      throw new Error(
        `The default credential is bound to ${configuredOrigin}; it cannot be sent to ${requestedOrigin}.`,
      );
    }
    return apiKey;
  }
}

function safeEndpointForClient(value: string): string | undefined {
  try {
    const endpoint = new URL(value);
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
      return undefined;
    }
    endpoint.username = "";
    endpoint.password = "";
    endpoint.search = "";
    endpoint.hash = "";
    return endpoint.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function providerOrigin(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTP or HTTPS URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use HTTP or HTTPS.`);
  }
  return parsed.origin;
}
