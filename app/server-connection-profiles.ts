import { isProviderWireProtocol } from "../packages/core/src/provider-protocols.ts";
import { randomUUID } from "../packages/core/src/random-id.ts";
import type { ProviderWireProtocol } from "../packages/core/src/run-kernel/types.ts";
import {
  DEFAULT_SERVER_CONNECTION_ID,
  isServerConnectionId,
} from "../packages/core/src/server-connection-catalog.ts";
import {
  createDefaultProfile,
  withServerProtocols,
} from "./profile-store.client.ts";
import type { StoredInferenceProfile } from "./profile-store.client.ts";
import {
  serverConnectionIdOfCredentialRef,
  serverConnectionOfMode,
  serverCredentialRef,
} from "./web-credential-mode.ts";
import type { WebCredentialMode } from "./web-credential-mode.ts";

/**
 * One provider connection the hosting service holds, as `GET
 * /api/runtime-status` reports it. Never a key, never a filesystem path.
 */
export interface ServerConnection {
  /** `default` for the `INFERENCE_LENS_API_*` variables, else the catalog's id. */
  id: string;
  name: string;
  endpoint: string;
  model?: string;
  /** Present whenever the connection states its protocols; may be empty. */
  protocols?: ProviderWireProtocol[];
  /** Set with `protocols`: whether the list names `systemone` (D9a). */
  systemOne?: boolean;
  /**
   * The connection's protocol list names something the server does not
   * recognize. The list is then ignored whole, exactly as if it were unset,
   * so this is the only trace of the operator's mistake.
   */
  unrecognizedProtocols?: string[];
  /** A server-held key is available and bound to `endpoint`. */
  credentialConfigured: boolean;
  /** Why a declared key is unavailable, in words the operator can act on. */
  problem?: string;
}

/** What the reconciliation needs to know: the list, and whether it is whole. */
export interface ServerConnectionsReport {
  /** The legacy `default` first, then the catalog in file order. */
  connections: ServerConnection[];
  /**
   * The catalog was refused as a whole. Its connections are then absent from
   * `connections` without having been removed, so nothing that belongs to
   * them is released on the strength of that absence.
   */
  catalogProblem?: string;
}

/**
 * What the service running this UI reports about itself. Drives the
 * server-managed profiles, which authentication modes are offered, and the
 * wording of container-specific advice.
 */
export interface ServerStatus extends ServerConnectionsReport {
  /** False until the probe answers; suppresses advice that would be a guess. */
  loaded: boolean;
  /** The API service is running in a container. */
  containerized: boolean;
}

export const unknownServerStatus: ServerStatus = {
  loaded: false,
  containerized: false,
  connections: [],
};

function parseServerConnection(body: unknown): ServerConnection | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = body as Record<string, unknown>;
  const text = (key: string): string | undefined =>
    typeof value[key] === "string" && value[key].trim()
      ? (value[key] as string).trim()
      : undefined;
  const endpoint = text("endpoint");
  if (!isServerConnectionId(value.id) || !endpoint) return undefined;
  const model = text("model");
  const problem = text("problem");
  return {
    id: value.id,
    name: text("name") ?? value.id,
    endpoint,
    ...(model ? { model } : {}),
    // An empty list is a decision-only server (D9a): it is still set, so the
    // chat switches are still the server's.
    ...(Array.isArray(value.protocols) &&
    value.protocols.every(isProviderWireProtocol)
      ? { protocols: value.protocols, systemOne: value.systemOne === true }
      : {}),
    ...(Array.isArray(value.unrecognizedProtocols) &&
    value.unrecognizedProtocols.length > 0 &&
    value.unrecognizedProtocols.every((name) => typeof name === "string")
      ? { unrecognizedProtocols: value.unrecognizedProtocols as string[] }
      : {}),
    credentialConfigured: value.credentialConfigured === true,
    ...(problem ? { problem } : {}),
  };
}

/**
 * The non-secret body of `GET /api/runtime-status`. A malformed connection is
 * dropped alone, and a repeated id keeps its first entry, so one bad entry
 * cannot take the rest of the list with it.
 */
export function parseRuntimeStatus(
  body: unknown,
): Omit<ServerStatus, "loaded"> {
  const value = (body ?? {}) as Record<string, unknown>;
  const connections: ServerConnection[] = [];
  for (const entry of Array.isArray(value.connections) ? value.connections : []) {
    const connection = parseServerConnection(entry);
    if (connection && !connections.some(({ id }) => id === connection.id)) {
      connections.push(connection);
    }
  }
  const catalogProblem =
    typeof value.catalogProblem === "string" && value.catalogProblem.trim()
      ? value.catalogProblem.trim()
      : undefined;
  return {
    containerized: value.containerized === true,
    connections,
    ...(catalogProblem ? { catalogProblem } : {}),
  };
}

/** The server connection a profile is managed by, whether or not it is reported. */
export function managingConnectionId(
  profile: { credentialRef?: string },
): string | undefined {
  return serverConnectionIdOfCredentialRef(profile.credentialRef);
}

/** The reported connection that manages this profile, if there is one. */
export function serverConnectionFor(
  profile: { credentialRef?: string },
  report: ServerConnectionsReport,
): ServerConnection | undefined {
  const id = managingConnectionId(profile);
  return id ? report.connections.find((connection) => connection.id === id) : undefined;
}

/**
 * Whether a profile's protocol switches are the server's rather than the
 * user's. They are reapplied from the server's configuration on every load,
 * so a surface that offered to change one would be offering an edit that is
 * silently undone. Shared by Connections, which locks them, and readiness,
 * which must not send the user to a locked switch.
 */
export function serverManagesProtocols(
  profile: { credentialRef?: string },
  report: ServerConnectionsReport,
  isDesktopRuntime: boolean,
): boolean {
  return !isDesktopRuntime && Boolean(serverConnectionFor(profile, report)?.protocols);
}

/** Where the operator states a connection's protocols, for wording that names it. */
export function serverProtocolsSource(connectionId: string): string {
  return connectionId === DEFAULT_SERVER_CONNECTION_ID
    ? "INFERENCE_LENS_API_PROTOCOLS"
    : `the "${connectionId}" entry in INFERENCE_LENS_CONNECTIONS`;
}

/**
 * A catalog connection that was not reported because the catalog itself was
 * refused. Its absence says nothing about whether it was removed.
 */
function unanswered(connectionId: string, report: ServerConnectionsReport): boolean {
  return (
    Boolean(report.catalogProblem) &&
    connectionId !== DEFAULT_SERVER_CONNECTION_ID &&
    !report.connections.some(({ id }) => id === connectionId)
  );
}

/** The mode a profile with no stored preference authenticates with. */
export function defaultWebCredentialMode(
  profile: { credentialRef?: string },
  report: ServerConnectionsReport,
): WebCredentialMode {
  const connection = serverConnectionFor(profile, report);
  return connection?.credentialConfigured ? { server: connection.id } : "none";
}

/**
 * Downgrades, in place, every stored server mode whose key the server no
 * longer holds: it would fail on every run. Returns the profiles changed.
 */
export function reconcileWebCredentialModes(
  modes: Map<string, WebCredentialMode>,
  report: ServerConnectionsReport,
): string[] {
  const changed: string[] = [];
  for (const [profileId, mode] of modes) {
    const server = serverConnectionOfMode(mode);
    if (!server || unanswered(server, report)) continue;
    const connection = report.connections.find(({ id }) => id === server);
    if (connection?.credentialConfigured) continue;
    modes.set(profileId, "none");
    changed.push(profileId);
  }
  return changed;
}

/** `server-default` for the legacy variables, `server-<id>` for the catalog. */
function serverProfileId(connectionId: string): string {
  return connectionId === DEFAULT_SERVER_CONNECTION_ID
    ? "server-default"
    : `server-${connectionId}`;
}

function sameServerManagedFields(
  a: StoredInferenceProfile,
  b: StoredInferenceProfile,
): boolean {
  return (
    a.endpoint === b.endpoint &&
    a.model === b.model &&
    a.credentialRef === b.credentialRef &&
    JSON.stringify(a.capabilityOverrides) === JSON.stringify(b.capabilityOverrides) &&
    a.systemOne === b.systemOne
  );
}

export interface ServerProfilesReconciliation {
  profiles: StoredInferenceProfile[];
  /** Set on a first run, which adopts the server's profiles outright. */
  activeProfileId?: string;
  /** Profiles added beside the user's own, to be offered rather than assumed. */
  added: string[];
}

/**
 * Brings the local profile list in line with the connections the server now
 * reports, or returns undefined when it already is.
 *
 * Both directions matter. A newly configured connection should produce a
 * profile that is ready to run, and a connection that was removed must not
 * leave behind a profile that is permanently endpoint-locked and fails every
 * request against a credential that no longer exists.
 */
export function reconcileServerProfiles(input: {
  profiles: StoredInferenceProfile[];
  connections: ServerConnection[];
  catalogProblem?: string;
  /** This device had no stored profiles; `profiles` is the starting one. */
  firstRun: boolean;
}): ServerProfilesReconciliation | undefined {
  const report: ServerConnectionsReport = input;
  const reported = new Map(input.connections.map((connection) => [connection.id, connection]));
  const provisioned = new Set<string>();
  let changed = false;

  const profiles = input.profiles.map((profile) => {
    const connectionId = managingConnectionId(profile);
    if (!connectionId || unanswered(connectionId, report)) return profile;
    const connection = reported.get(connectionId);
    if (!connection) {
      // Release a profile provisioned by a configuration that is now gone,
      // unlocking its endpoint. The profile itself is kept: the user may have
      // chosen a model on it.
      changed = true;
      return { ...profile, credentialRef: undefined };
    }
    provisioned.add(connectionId);
    // The endpoint is the server's to own: the credential is released only to
    // the origin it names, so a profile pointing anywhere else is dead weight.
    // The model is not — the user may have picked one from discovery, and the
    // server's model is a starting point rather than a lock. It is filled in
    // only while the profile has no model at all. Like the endpoint, declared
    // protocols are the server's; a connection that declares none leaves the
    // profile's choices with the user.
    const relocked = {
      ...profile,
      endpoint: connection.endpoint,
      ...(connection.model && !profile.model ? { model: connection.model } : {}),
    };
    const next = connection.protocols
      ? withServerProtocols(relocked, connection.protocols, connection.systemOne)
      : relocked;
    if (sameServerManagedFields(profile, next)) return profile;
    changed = true;
    return next;
  });

  const taken = new Set(profiles.map(({ id }) => id));
  const added: StoredInferenceProfile[] = [];
  for (const connection of input.connections) {
    if (provisioned.has(connection.id)) continue;
    const preferredId = serverProfileId(connection.id);
    const id = taken.has(preferredId) ? `${preferredId}-${randomUUID()}` : preferredId;
    taken.add(id);
    const profile: StoredInferenceProfile = {
      ...createDefaultProfile(),
      id,
      name: connection.name,
      endpoint: connection.endpoint,
      // The server named a provider but not always a model. An empty model
      // blocks the run with a notice that points at the model picker, which
      // is true, instead of failing at the provider with a name the user
      // never chose.
      model: connection.model ?? "",
      credentialRef: serverCredentialRef(connection.id),
    };
    added.push(
      connection.protocols
        ? withServerProtocols(profile, connection.protocols, connection.systemOne)
        : profile,
    );
  }

  // Configuring the server is explicit intent, so a device that has never
  // stored a profile adopts it outright. `profiles` here is just the unused
  // starting profile — replacing it rather than keeping it means a first run
  // never leaves an unconfigured profile beside the ones the server actually
  // provisioned. Once the user has profiles of their own, the starting profile
  // may be one of them, so it is kept and the server's are offered instead.
  if (input.firstRun && added.length > 0) {
    return { profiles: added, activeProfileId: added[0]!.id, added: [] };
  }
  if (!changed && added.length === 0) return undefined;
  return {
    profiles: [...profiles, ...added],
    added: added.map(({ id }) => id),
  };
}

/**
 * Where the profile's locked protocol switches are set, or undefined when they
 * are the user's. Readiness names it so its advice points at the right file.
 */
export function serverProtocolsManagedBy(
  profile: { credentialRef?: string },
  report: ServerConnectionsReport,
  isDesktopRuntime: boolean,
): string | undefined {
  if (!serverManagesProtocols(profile, report, isDesktopRuntime)) return undefined;
  return serverProtocolsSource(managingConnectionId(profile)!);
}
