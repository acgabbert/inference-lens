/**
 * Turns a container's opaque connection failure into the instruction that
 * fixes it.
 *
 * Inside a container, `127.0.0.1` is the container — not the machine running
 * it. Every local-provider README says to use `http://127.0.0.1:<port>`, so
 * pasting that address into a containerized Inference Lens is the expected
 * mistake rather than a rare one. Node's fetch reports it as the bare string
 * `fetch failed`, which names neither the cause nor the fix.
 */

import {
  isLoopbackAddress,
  isWildcardAddress,
} from "../../../packages/core/src/local-addresses.ts";

/**
 * A wildcard counts alongside true loopback here: as a *provider* address it
 * is equally undialable from inside a container, and every local-provider
 * README prints one spelling or the other.
 */
function isContainerLocalHostname(hostname: string): boolean {
  return isLoopbackAddress(hostname) || isWildcardAddress(hostname);
}

/**
 * The host machine as seen from inside a container. Docker Desktop resolves it
 * unconditionally; on plain Linux Docker Engine it exists only when the
 * container was started with `--add-host=host.docker.internal:host-gateway`,
 * which this project's own `docker run` and Compose invocations pass. A
 * container started without it gets a second opaque failure — `ENOTFOUND` —
 * from following this advice, so the suggestion names the flag.
 */
const HOST_GATEWAY_HOSTNAME = "host.docker.internal";

/**
 * Rewrites a transport-level failure when — and only when — the container
 * cannot possibly have reached the address the user gave.
 *
 * Callers must pass transport failures only. A provider that answered with an
 * HTTP status was reachable, so its message is the provider's own and must
 * survive untouched.
 */
export function explainProviderTransportError(
  message: string,
  endpoint: string,
  containerized: boolean,
): string {
  if (!containerized) return message;

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return message;
  }
  if (!isContainerLocalHostname(parsed.hostname)) return message;

  const suggested = new URL(parsed.toString());
  suggested.hostname = HOST_GATEWAY_HOSTNAME;

  return (
    `${endpoint} points at the Inference Lens container itself, not at the ` +
    `machine running it, so nothing is listening there. For a provider running ` +
    `natively on that machine, use ${suggested.toString().replace(/\/$/, "")} ` +
    `— on Linux the container must also have been started with ` +
    `--add-host=${HOST_GATEWAY_HOSTNAME}:host-gateway for that name to ` +
    `resolve. For a provider running as another Compose service, use its ` +
    `service name as the hostname. (${message})`
  );
}
