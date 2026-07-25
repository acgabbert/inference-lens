import { EnvironmentCredentialStore } from "../../services/api/src";

/**
 * HTTP-framework adapter for the Compose credential source. The rest of the
 * execution service receives only the CredentialStore interface.
 */
export function runtimeCredentialStore(): EnvironmentCredentialStore {
  return new EnvironmentCredentialStore(process.env);
}
