import type { CredentialSelection } from "../../contracts/src/index.ts";

/**
 * How a headless run finds a key for each connection a suite uses.
 *
 * A project names connection requirements and never stores credentials, so
 * this is the CLI's one answer to "which key goes to which endpoint". Keys come
 * only from the environment, never from a flag, a project, or an artifact:
 *
 * - `INFERENCE_LENS_CONNECTION_<ID>_API_KEY` serves one requirement, and
 *   `INFERENCE_LENS_CONNECTION_<ID>_ENDPOINT` optionally re-points it.
 * - `INFERENCE_LENS_API_KEY` serves every other requirement whose endpoint
 *   origin matches `INFERENCE_LENS_API_ENDPOINT`, as the server's does.
 * - `--no-auth <id>` declares an endpoint that needs no key. A missing
 *   variable is never read as "no key needed".
 *
 * Every key is released only to the origin it was configured for.
 */
export interface ConnectionResolution {
  requirementId: string;
  requirementName: string;
  endpoint: string;
  credential: CredentialSelection;
  /** Which variable or flag supplied the credential; never the key itself. */
  source: string;
}

export class CredentialResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialResolutionError";
  }
}

const CONNECTION_ID_PREFIX = "connection_";

/**
 * `connection_evals-default` becomes `EVALS_DEFAULT`. The entity prefix is
 * dropped because every requirement carries it, and anything a shell variable
 * name cannot hold becomes an underscore.
 */
export function connectionVariableStem(requirementId: string): string {
  const bare = requirementId.startsWith(CONNECTION_ID_PREFIX)
    ? requirementId.slice(CONNECTION_ID_PREFIX.length)
    : requirementId;
  return bare.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

export function connectionVariableNames(requirementId: string): { apiKey: string; endpoint: string } {
  const stem = `INFERENCE_LENS_CONNECTION_${connectionVariableStem(requirementId)}`;
  return { apiKey: `${stem}_API_KEY`, endpoint: `${stem}_ENDPOINT` };
}

/**
 * Two requirements that fold to one variable name would silently share a key,
 * so a project that does this is refused rather than guessed at.
 */
export function assertDistinctConnectionVariables(
  requirements: readonly { id: string }[],
): void {
  const seen = new Map<string, string>();
  for (const { id } of requirements) {
    const stem = connectionVariableStem(id);
    const other = seen.get(stem);
    if (other !== undefined) {
      throw new CredentialResolutionError(
        `Connections ${other} and ${id} both map to INFERENCE_LENS_CONNECTION_${stem}_*; rename one in the project before running headless.`,
      );
    }
    seen.set(stem, id);
  }
}

export function providerOrigin(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CredentialResolutionError(`${label} must be a valid HTTP or HTTPS URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CredentialResolutionError(`${label} must use HTTP or HTTPS.`);
  }
  return parsed.origin;
}

export function resolveConnection(
  requirement: { id: string; name: string; endpoint: string },
  environment: Readonly<Record<string, string | undefined>>,
  noAuth: ReadonlySet<string>,
): ConnectionResolution {
  const names = connectionVariableNames(requirement.id);
  const endpointOverride = environment[names.endpoint]?.trim();
  const endpoint = endpointOverride || requirement.endpoint;
  const label = endpointOverride ? names.endpoint : `the endpoint of connection ${requirement.id}`;
  // Validated before any credential decision, so a bad override is named as
  // the problem rather than surfacing later as a confusing origin mismatch.
  const origin = providerOrigin(endpoint, label);
  const base = { requirementId: requirement.id, requirementName: requirement.name, endpoint };

  const ownKey = environment[names.apiKey]?.trim();
  if (noAuth.has(requirement.id)) {
    if (ownKey) {
      throw new CredentialResolutionError(
        `Connection ${requirement.id} is declared --no-auth, but ${names.apiKey} is also set. Remove one.`,
      );
    }
    return { ...base, credential: { kind: "none" }, source: "--no-auth" };
  }
  if (ownKey) {
    return { ...base, credential: { kind: "provided", apiKey: ownKey }, source: names.apiKey };
  }

  const defaultKey = environment.INFERENCE_LENS_API_KEY?.trim();
  const defaultEndpoint = environment.INFERENCE_LENS_API_ENDPOINT?.trim();
  if (defaultKey && defaultEndpoint) {
    const defaultOrigin = providerOrigin(defaultEndpoint, "INFERENCE_LENS_API_ENDPOINT");
    if (defaultOrigin === origin) {
      return { ...base, credential: { kind: "provided", apiKey: defaultKey }, source: "INFERENCE_LENS_API_KEY" };
    }
  }

  throw new CredentialResolutionError(
    `No credential for connection "${requirement.name}" (${requirement.id}) at ${origin}. Set ${names.apiKey}, ` +
      `set INFERENCE_LENS_API_KEY with INFERENCE_LENS_API_ENDPOINT on ${origin}, ` +
      `or pass --no-auth ${requirement.id} if the endpoint needs no key.`,
  );
}
