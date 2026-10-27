import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import type { CredentialSelection } from "../../../packages/contracts/src/index.ts";
import {
  DEFAULT_SERVER_CONNECTION_ID,
  parseServerConnectionCatalog,
  ServerConnectionCatalogError,
} from "../../../packages/core/src/server-connection-catalog.ts";
import type { ServerConnectionDeclaration } from "../../../packages/core/src/server-connection-catalog.ts";
import type { ProviderWireProtocol } from "../../../packages/core/src/run-kernel/types.ts";
import {
  EnvironmentCredentialStore,
  parseServerProtocolNames,
  providerOrigin,
} from "./credential-store.ts";
import type { CredentialStore } from "./credential-store.ts";

/** Names the catalog file (docs/archive/SERVER_CONNECTIONS_DESIGN.md). */
export const SERVER_CONNECTIONS_VARIABLE = "INFERENCE_LENS_CONNECTIONS";

const DEFAULT_SERVER_CONNECTION_NAME = "Server default";

/**
 * One connection as the same-origin UI may see it. Never holds a key, and
 * never a filesystem path: `problem` says what is wrong in words the operator
 * can act on, and the path goes to the server log through `diagnostics`.
 */
export interface ServerConnectionStatus {
  id: string;
  name: string;
  endpoint: string;
  model?: string;
  /** Present whenever the connection states its protocols; may be empty. */
  protocols?: ProviderWireProtocol[];
  /** Set with `protocols`: whether the list names `systemone`. */
  systemOne?: boolean;
  /** Set instead of `protocols` when the list names something unknown. */
  unrecognizedProtocols?: string[];
  credentialConfigured: boolean;
  /** Why a declared key is unavailable. */
  problem?: string;
}

export interface ServerConnectionReport {
  /** The legacy default first, then the catalog in file order. */
  connections: ServerConnectionStatus[];
  /** The catalog was configured and refused as a whole (decision 3). */
  catalogProblem?: string;
  /** Full-detail lines for the operator's log, paths included. */
  diagnostics: string[];
}

export interface ServerConnectionStoreOptions {
  /** Throws when the file cannot be read, as `readFileSync` does. */
  readFile?: (path: string) => string;
}

type KeyReading =
  | { kind: "none" }
  | { kind: "key"; apiKey: string }
  | { kind: "problem"; problem: string; diagnostic: string };

interface CatalogReading {
  connections: ServerConnectionDeclaration[];
  /** The catalog's directory, against which relative key files resolve. */
  base: string;
  problem?: string;
  diagnostic?: string;
}

/**
 * Every provider connection the service holds a key for: the legacy
 * `INFERENCE_LENS_API_*` variables as `default`, plus the catalog that
 * `INFERENCE_LENS_CONNECTIONS` names.
 *
 * The catalog and every key file are read per call, as the command-tool
 * catalog is (decision 8): rotating a key or editing a connection then takes
 * effect without a restart, and nothing has to remember which edits need one.
 */
export class ServerConnectionStore implements CredentialStore {
  /** The legacy connection, whose behavior this class leaves exactly as it was. */
  readonly defaultConnection: EnvironmentCredentialStore;
  private readonly environment: Record<string, string | undefined>;
  private readonly readFile: (path: string) => string;

  constructor(
    environment: Record<string, string | undefined>,
    options: ServerConnectionStoreOptions = {},
  ) {
    this.environment = environment;
    this.defaultConnection = new EnvironmentCredentialStore(environment);
    this.readFile = options.readFile ?? ((path) => readFileSync(path, "utf8"));
  }

  report(): ServerConnectionReport {
    const connections: ServerConnectionStatus[] = [];
    const diagnostics: string[] = [];

    const legacy = this.defaultConnection.connectionConfiguration();
    if (legacy) {
      connections.push({
        id: DEFAULT_SERVER_CONNECTION_ID,
        name: DEFAULT_SERVER_CONNECTION_NAME,
        ...legacy,
        credentialConfigured: this.defaultConnection.isConfigured(),
      });
    }

    const catalog = this.readCatalog();
    if (catalog?.diagnostic) diagnostics.push(catalog.diagnostic);
    for (const connection of catalog?.connections ?? []) {
      const key = this.readKey(connection, catalog!.base);
      if (key.kind === "problem") diagnostics.push(key.diagnostic);
      const protocols = connection.protocols
        ? parseServerProtocolNames(connection.protocols)
        : ({ kind: "unset" } as const);
      connections.push({
        id: connection.id,
        name: connection.name,
        endpoint: connection.endpoint,
        ...(connection.model ? { model: connection.model } : {}),
        ...(protocols.kind === "valid"
          ? { protocols: protocols.protocols, systemOne: protocols.systemOne }
          : {}),
        ...(protocols.kind === "invalid"
          ? { unrecognizedProtocols: protocols.unrecognized }
          : {}),
        credentialConfigured: key.kind === "key",
        ...(key.kind === "problem" ? { problem: key.problem } : {}),
      });
    }

    return {
      connections,
      ...(catalog?.problem ? { catalogProblem: catalog.problem } : {}),
      diagnostics,
    };
  }

  resolve(selection: CredentialSelection, endpoint: string): string {
    if (
      selection.kind !== "environment-default" ||
      selection.connectionId === undefined ||
      selection.connectionId === DEFAULT_SERVER_CONNECTION_ID
    ) {
      return this.defaultConnection.resolve(selection, endpoint);
    }

    const { connectionId } = selection;
    const catalog = this.readCatalog();
    const connection = catalog?.connections.find(({ id }) => id === connectionId);
    if (!connection) {
      throw new Error(
        catalog?.problem
          ? `The server has no connection "${connectionId}": ${catalog.problem}`
          : `The server has no connection "${connectionId}".`,
      );
    }

    const key = this.readKey(connection, catalog!.base);
    if (key.kind !== "key") {
      throw new Error(
        key.kind === "problem"
          ? `Server connection "${connectionId}" holds no key: ${lowerFirst(key.problem)}`
          : `Server connection "${connectionId}" holds no key. Choose No authentication for it.`,
      );
    }

    const configuredOrigin = providerOrigin(connection.endpoint, `Server connection "${connectionId}"`);
    const requestedOrigin = providerOrigin(endpoint, "request endpoint");
    if (requestedOrigin !== configuredOrigin) {
      throw new Error(
        `The key for server connection "${connectionId}" is bound to ${configuredOrigin}; it cannot be sent to ${requestedOrigin}.`,
      );
    }
    return key.apiKey;
  }

  private readCatalog(): CatalogReading | undefined {
    const path = this.environment[SERVER_CONNECTIONS_VARIABLE]?.trim();
    if (!path) return undefined;
    const base = dirname(resolve(path));
    const refuse = (problem: string, detail: string): CatalogReading => ({
      connections: [],
      base,
      problem,
      diagnostic: `${SERVER_CONNECTIONS_VARIABLE} (${path}): ${detail}`,
    });

    let contents: string;
    try {
      contents = this.readFile(path);
    } catch (error) {
      return refuse("The connection catalog could not be read.", errorText(error));
    }
    let value: unknown;
    try {
      value = JSON.parse(contents);
    } catch (error) {
      return refuse("The connection catalog is not valid JSON.", errorText(error));
    }
    try {
      return { connections: parseServerConnectionCatalog(value).connections, base };
    } catch (error) {
      if (!(error instanceof ServerConnectionCatalogError)) throw error;
      // The parser's messages name fields and rules, never values, so they
      // are safe for the browser as well as the log.
      return refuse(`The connection catalog was refused: ${error.message}`, error.message);
    }
  }

  private readKey(connection: ServerConnectionDeclaration, base: string): KeyReading {
    const { key } = connection;
    if (key.kind === "none") return { kind: "none" };

    if (key.kind === "environment") {
      const apiKey = this.environment[key.variable]?.trim();
      if (apiKey) return { kind: "key", apiKey };
      const problem = `${key.variable} is not set.`;
      return {
        kind: "problem",
        problem,
        diagnostic: `Server connection "${connection.id}": ${problem}`,
      };
    }

    // Relative to the catalog rather than the service's working directory: a
    // catalog and its key files are one thing an operator mounts together.
    const path = isAbsolute(key.path) ? key.path : resolve(base, key.path);
    let contents: string;
    try {
      contents = this.readFile(path);
    } catch (error) {
      return {
        kind: "problem",
        problem: "Its key file could not be read.",
        diagnostic: `Server connection "${connection.id}": key file ${path} could not be read: ${errorText(error)}`,
      };
    }
    const apiKey = contents.trim();
    if (apiKey) return { kind: "key", apiKey };
    return {
      kind: "problem",
      problem: "Its key file is empty.",
      diagnostic: `Server connection "${connection.id}": key file ${path} is empty.`,
    };
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
