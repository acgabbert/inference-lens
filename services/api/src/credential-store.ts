import type { CredentialSelection } from "../../../packages/contracts/src/index.ts";

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

  constructor(
    environment: Record<string, string | undefined>,
    credentialVariableName = "TRACE_LENS_API_KEY",
    endpointVariableName = "TRACE_LENS_API_ENDPOINT",
  ) {
    this.environment = environment;
    this.credentialVariableName = credentialVariableName;
    this.endpointVariableName = endpointVariableName;
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
