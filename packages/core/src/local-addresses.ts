/**
 * Classification of the handful of hostnames that mean something special to a
 * local workbench: the wildcard a server binds to, the loopback names that
 * resolve to "this machine", and literal IP addresses.
 *
 * These questions are asked from three places that reason about entirely
 * different things — a browser origin's trustworthiness, whether a provider
 * address can be reached from inside a container, and whether an incoming
 * `Host` header could have been produced by DNS rebinding — but they all turn
 * on the same small set of names. Kept together so the set cannot drift apart.
 */

/**
 * Addresses a server binds to in order to listen on every interface. Never a
 * browser URL: they name a set of interfaces rather than a destination.
 */
const WILDCARD_HOSTNAMES = new Set(["0.0.0.0", "::", "[::]"]);

/** Names that resolve to the machine asking, excluding the wildcards above. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "::1", "[::1]"]);

/** The whole 127.0.0.0/8 range, not just 127.0.0.1. */
const LOOPBACK_IPV4 = /^127(\.\d{1,3}){3}$/;

/** An IPv4 address in dotted-quad form, each octet in range. */
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Anything a browser will treat as an IPv6 literal rather than a name. DNS
 * labels cannot contain a colon, so requiring one is enough to separate the
 * two — a malformed address simply fails to connect.
 */
const IPV6 = /^[0-9a-f:.]*:[0-9a-f:.]*$/i;

function normalize(hostname: string): string {
  const host = hostname.trim().toLowerCase();
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

export function isWildcardAddress(hostname: string): boolean {
  return WILDCARD_HOSTNAMES.has(normalize(hostname));
}

export function isLoopbackAddress(hostname: string): boolean {
  const host = normalize(hostname);
  return LOOPBACK_HOSTNAMES.has(host) || LOOPBACK_IPV4.test(host);
}

/**
 * True for an address the browser or resolver reaches directly, with no name
 * to look up. Such a host cannot be pointed somewhere else by a DNS answer,
 * which is what makes it safe to accept in a `Host` header.
 */
export function isIpLiteral(hostname: string): boolean {
  const host = normalize(hostname);
  if (IPV6.test(host)) return true;
  if (!IPV4.test(host)) return false;
  return host.split(".").every((octet) => Number(octet) <= 255);
}

/**
 * Splits a `Host` header or URL authority into its hostname, dropping the port
 * and any IPv6 brackets. Returns the input lowercased when it parses as
 * neither, so callers compare something rather than nothing.
 */
export function hostnameFromAuthority(authority: string): string {
  const value = authority.trim().toLowerCase();
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    return close === -1 ? value : value.slice(1, close);
  }
  const colon = value.indexOf(":");
  return colon === -1 ? value : value.slice(0, colon);
}
