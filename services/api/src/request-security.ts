import {
  hostnameFromAuthority,
  isIpLiteral,
} from "../../../packages/core/src/local-addresses.ts";

export class WorkbenchRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "WorkbenchRequestError";
    this.status = status;
  }
}

/** Extra `Host` values an operator declares, e.g. a reverse proxy's name. */
export interface WorkbenchRequestPolicy {
  allowedHosts?: readonly string[];
}

const ALLOWED_HOSTS_VARIABLE = "INFERENCE_LENS_ALLOWED_HOSTS";

/** Parses the operator's comma- or space-separated allowlist. */
export function parseAllowedHosts(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,\s]+/)
    .map((entry) => hostnameFromAuthority(entry))
    .filter(Boolean);
}

/**
 * Refuses a request whose `Host` names something this service was not opened
 * as.
 *
 * The origin check below cannot catch DNS rebinding. An attacker's page on
 * `evil.test:3000` whose name is re-resolved to `127.0.0.1` reaches this server
 * with the browser believing the request is same-origin: `Origin` matches the
 * URL the server reconstructs, because the server reconstructs it from this
 * very header. The credential in `INFERENCE_LENS_API_KEY` would then be spent
 * by a page the user never trusted.
 *
 * Rebinding needs a *name* to re-point, so an address literal is accepted
 * whatever it is — that keeps `localhost`, `127.0.0.1`, the `0.0.0.0` a
 * container logs, and a LAN address all working untouched. A name is accepted
 * only when it is a loopback name or the operator listed it.
 */
export function validateRequestHost(
  request: Request,
  policy?: WorkbenchRequestPolicy,
): void {
  const header = request.headers.get("host");
  // Absent only off a real HTTP server (tests, direct handler calls), where
  // the request URL is the authority.
  const authority = header ?? new URL(request.url).host;
  const hostname = hostnameFromAuthority(authority);
  if (!hostname) {
    throw new WorkbenchRequestError("Request Host header is missing.", 403);
  }

  if (isIpLiteral(hostname)) return;
  // `*.localhost` resolves to loopback per RFC 6761 and is what some proxies
  // hand out for local services.
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return;
  if (policy?.allowedHosts?.includes(hostname)) return;

  throw new WorkbenchRequestError(
    `Requests for host "${hostname}" are not allowed. Inference Lens serves ` +
      `local addresses by default; add this name to ${ALLOWED_HOSTS_VARIABLE} ` +
      `to serve it from a proxy or DNS name.`,
    403,
  );
}

/**
 * Keeps browser callers on the local workbench origin. Split out from
 * `validateWorkbenchRequest` because a GET route carries no request body to
 * demand a media type from, but still must not answer another origin.
 */
export function validateSameOrigin(
  request: Request,
  policy?: WorkbenchRequestPolicy,
): void {
  validateRequestHost(request, policy);

  const origin = request.headers.get("origin");
  if (!origin) return;

  let callerOrigin: string;
  try {
    callerOrigin = new URL(origin).origin;
  } catch {
    throw new WorkbenchRequestError("Request origin is invalid.", 403);
  }
  if (callerOrigin !== new URL(request.url).origin) {
    throw new WorkbenchRequestError(
      "Cross-origin API requests are not allowed.",
      403,
    );
  }
}

/**
 * Keeps browser callers on the local workbench origin and requires a
 * non-simple JSON request so cross-origin pages cannot submit API work without
 * a CORS preflight.
 */
export function validateWorkbenchRequest(
  request: Request,
  policy?: WorkbenchRequestPolicy,
): void {
  const mediaType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    throw new WorkbenchRequestError(
      "Content-Type must be application/json.",
      415,
    );
  }

  validateSameOrigin(request, policy);
}
