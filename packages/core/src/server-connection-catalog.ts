import { z } from "zod";

/**
 * The operator's declaration of the provider connections this service holds
 * keys for (docs/archive/SERVER_CONNECTIONS_DESIGN.md).
 *
 * The catalog names where each key lives — a file or an environment variable —
 * and never holds one itself: it is a file operators copy, mount, and share,
 * and keeping the secret out of it is why there is a catalog at all.
 *
 * Parsing lives in core so the shape is defined once for every host that
 * might read it; reading files and keys is the service's job.
 */

export const SERVER_CONNECTION_CATALOG_SCHEMA_VERSION = 1;

/** The connection the `INFERENCE_LENS_API_*` variables describe (decision 2). */
export const DEFAULT_SERVER_CONNECTION_ID = "default";

/**
 * Stable, because the browser persists it as a profile's identity. Lowercase
 * so that it can be read back from a profile id without case folding.
 */
const connectionIdPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isServerConnectionId(value: unknown): value is string {
  return typeof value === "string" && connectionIdPattern.test(value);
}

export type ServerConnectionKeySource =
  | { kind: "none" }
  /** Absolute, or relative to the catalog file's own directory. */
  | { kind: "file"; path: string }
  | { kind: "environment"; variable: string };

export interface ServerConnectionDeclaration {
  id: string;
  name: string;
  /** An HTTP or HTTPS base URL with no user info, query, fragment, or trailing slash. */
  endpoint: string;
  model?: string;
  /**
   * As written. Recognizing the names is the store's job, because an unknown
   * one is that connection's problem rather than the catalog's (decision 3).
   */
  protocols?: string[];
  key: ServerConnectionKeySource;
}

export interface ServerConnectionCatalog {
  schemaVersion: typeof SERVER_CONNECTION_CATALOG_SCHEMA_VERSION;
  connections: ServerConnectionDeclaration[];
}

export class ServerConnectionCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerConnectionCatalogError";
  }
}

/**
 * The messages name the rule rather than echo the value: an endpoint that
 * breaks one of them may well carry a secret in its user info or query.
 */
const endpointSchema = z
  .string()
  .trim()
  .min(1, "A connection needs an endpoint.")
  .superRefine((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: "custom", message: "Must be an absolute URL." });
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      context.addIssue({ code: "custom", message: "Must use HTTP or HTTPS." });
    }
    if (url.username || url.password) {
      context.addIssue({
        code: "custom",
        message: "Must not contain user info; name the key with apiKeyFile or apiKeyEnv.",
      });
    }
    if (url.search || url.hash) {
      context.addIssue({ code: "custom", message: "Must not contain a query or fragment." });
    }
  })
  .transform((value) => value.replace(/\/+$/, ""));

const declarationSchema = z
  .object({
    id: z
      .string()
      .regex(
        connectionIdPattern,
        "A connection id may contain lowercase letters, digits, and dash, must start with a letter or digit, and is at most 63 characters.",
      ),
    name: z.string().trim().min(1).optional(),
    endpoint: endpointSchema,
    model: z.string().trim().min(1).optional(),
    protocols: z.array(z.string().trim().min(1)).optional(),
    apiKeyFile: z.string().trim().min(1).optional(),
    apiKeyEnv: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((connection, context) => {
    if (connection.id === DEFAULT_SERVER_CONNECTION_ID) {
      context.addIssue({
        code: "custom",
        path: ["id"],
        message: `"${DEFAULT_SERVER_CONNECTION_ID}" is reserved for INFERENCE_LENS_API_ENDPOINT and INFERENCE_LENS_API_KEY.`,
      });
    }
    if (connection.apiKeyFile !== undefined && connection.apiKeyEnv !== undefined) {
      context.addIssue({
        code: "custom",
        message: "A connection takes apiKeyFile or apiKeyEnv, not both.",
      });
    }
  });

const catalogSchema = z
  .object({
    schemaVersion: z.literal(SERVER_CONNECTION_CATALOG_SCHEMA_VERSION),
    connections: z.array(declarationSchema),
  })
  .strict()
  .superRefine((catalog, context) => {
    const seen = new Set<string>();
    catalog.connections.forEach((connection, index) => {
      if (seen.has(connection.id)) {
        context.addIssue({
          code: "custom",
          path: ["connections", index, "id"],
          message: `Duplicate connection id "${connection.id}".`,
        });
      }
      seen.add(connection.id);
    });
  });

function issueText(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

/**
 * Throws rather than keeping the connections that parsed (decision 3). A
 * catalog the operator got structurally wrong is not one they meant part of,
 * and a connection that silently went missing would be looked for in the
 * wrong place.
 */
export function parseServerConnectionCatalog(value: unknown): ServerConnectionCatalog {
  const parsed = catalogSchema.safeParse(value);
  if (!parsed.success) {
    throw new ServerConnectionCatalogError(issueText(parsed.error));
  }
  return {
    schemaVersion: SERVER_CONNECTION_CATALOG_SCHEMA_VERSION,
    connections: parsed.data.connections.map((connection) => ({
      id: connection.id,
      name: connection.name ?? connection.id,
      endpoint: connection.endpoint,
      ...(connection.model === undefined ? {} : { model: connection.model }),
      ...(connection.protocols === undefined ? {} : { protocols: connection.protocols }),
      key:
        connection.apiKeyFile !== undefined
          ? { kind: "file", path: connection.apiKeyFile }
          : connection.apiKeyEnv !== undefined
            ? { kind: "environment", variable: connection.apiKeyEnv }
            : { kind: "none" },
    })),
  };
}
