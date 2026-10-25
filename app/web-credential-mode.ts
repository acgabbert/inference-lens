import type { CredentialSelection } from "../packages/contracts/src/index.ts";
import {
  DEFAULT_SERVER_CONNECTION_ID,
  isServerConnectionId,
} from "../packages/core/src/server-connection-catalog.ts";

/**
 * How a web profile authenticates. `server` names a key the service holds, by
 * the id of the connection it belongs to; the browser never sees the key.
 */
export type WebCredentialMode = "session" | "none" | { server: string };

/**
 * The string form of a server key: `environment-default` for the legacy
 * `default` connection, which is what every profile and preference stored
 * before the catalog already says, and `environment-default:<id>` otherwise.
 * Shared by `credentialRef` and the stored mode, so the two cannot disagree
 * about which connection they mean.
 */
const SERVER_CREDENTIAL_PREFIX = "environment-default";

export function serverCredentialRef(connectionId: string): string {
  return connectionId === DEFAULT_SERVER_CONNECTION_ID
    ? SERVER_CREDENTIAL_PREFIX
    : `${SERVER_CREDENTIAL_PREFIX}:${connectionId}`;
}

/** The connection a server credential reference names, or undefined. */
export function serverConnectionIdOfCredentialRef(
  value: unknown,
): string | undefined {
  if (value === SERVER_CREDENTIAL_PREFIX) return DEFAULT_SERVER_CONNECTION_ID;
  if (typeof value !== "string") return undefined;
  if (!value.startsWith(`${SERVER_CREDENTIAL_PREFIX}:`)) return undefined;
  const id = value.slice(SERVER_CREDENTIAL_PREFIX.length + 1);
  // `default` has exactly one spelling, so a reference can be compared as text.
  return isServerConnectionId(id) && id !== DEFAULT_SERVER_CONNECTION_ID
    ? id
    : undefined;
}

export function serverConnectionOfMode(
  mode: WebCredentialMode,
): string | undefined {
  return typeof mode === "object" ? mode.server : undefined;
}

export function webCredentialModeToStorage(mode: WebCredentialMode): string {
  return typeof mode === "object" ? serverCredentialRef(mode.server) : mode;
}

/** Undefined for anything that is not a mode, which is no preference at all. */
export function webCredentialModeFromStorage(
  value: unknown,
): WebCredentialMode | undefined {
  if (value === "session" || value === "none") return value;
  const server = serverConnectionIdOfCredentialRef(value);
  return server ? { server } : undefined;
}

/**
 * Resolves the web authentication selector into the exact API contract.
 * Keeping this mode-driven prevents a retained session draft from leaking into
 * a request after the user explicitly selects "No authentication".
 */
export function resolveWebCredentialSelection(
  mode: WebCredentialMode,
  draft: string,
): CredentialSelection {
  if (typeof mode === "object") {
    // `default` is sent without an id, the shape every older client sends.
    return mode.server === DEFAULT_SERVER_CONNECTION_ID
      ? { kind: "environment-default" }
      : { kind: "environment-default", connectionId: mode.server };
  }
  if (mode === "session" && draft.trim()) {
    return { kind: "provided", apiKey: draft };
  }
  return { kind: "none" };
}

export function webCredentialIsAvailable(
  mode: WebCredentialMode,
  draft: string,
): boolean {
  return (
    typeof mode === "object" ||
    (mode === "session" && draft.trim().length > 0)
  );
}
