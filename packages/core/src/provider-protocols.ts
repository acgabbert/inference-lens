import type { ProviderCapabilities } from "./types.ts";
import { PROVIDER_WIRE_PROTOCOLS } from "./run-kernel/types.ts";
import type { ProviderWireProtocol } from "./run-kernel/types.ts";

/**
 * Wire-protocol facts every host needs before any adapter is involved: which
 * capability declares a protocol, which path it is served at, and how its
 * credential is presented. Protocol choice is per run; a connection only says
 * which protocols it supports.
 */

/** The Anthropic API version every Messages request and model listing pins. */
export const ANTHROPIC_VERSION = "2023-06-01";

/**
 * A provider answered with something the protocol does not allow. Distinct
 * from a transport failure (nothing answered) and a provider error (an HTTP
 * status), so a run can say which of the three it was.
 */
export class ProviderProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderProtocolError";
  }
}

const capabilityByProtocol = {
  "openai-compatible-chat-completions": "chatCompletions",
  "openai-responses": "responsesApi",
  "anthropic-messages": "anthropicMessages",
} as const satisfies Record<ProviderWireProtocol, keyof ProviderCapabilities>;

const pathByProtocol = {
  "openai-compatible-chat-completions": "/chat/completions",
  "openai-responses": "/responses",
  "anthropic-messages": "/messages",
} as const satisfies Record<ProviderWireProtocol, string>;

const labelByProtocol = {
  "openai-compatible-chat-completions": "Chat Completions",
  "openai-responses": "Responses",
  "anthropic-messages": "Anthropic Messages",
} as const satisfies Record<ProviderWireProtocol, string>;

export function isProviderWireProtocol(value: unknown): value is ProviderWireProtocol {
  return (PROVIDER_WIRE_PROTOCOLS as readonly unknown[]).includes(value);
}

export function protocolCapabilityKey(
  protocol: ProviderWireProtocol,
): (typeof capabilityByProtocol)[ProviderWireProtocol] {
  return capabilityByProtocol[protocol];
}

/** A short human name, for settings, readiness, and evidence. */
export function protocolLabel(protocol: ProviderWireProtocol): string {
  return labelByProtocol[protocol];
}

/** The path a protocol appends to a connection's base endpoint. */
export function protocolPath(protocol: ProviderWireProtocol): string {
  return pathByProtocol[protocol];
}

export function supportsProtocol(
  capabilities: ProviderCapabilities,
  protocol: ProviderWireProtocol,
): boolean {
  // Snapshots recorded before a protocol existed lack its key; absent is "no".
  return capabilities[capabilityByProtocol[protocol]] === true;
}

export function supportedProtocols(
  capabilities: ProviderCapabilities,
): ProviderWireProtocol[] {
  return PROVIDER_WIRE_PROTOCOLS.filter((protocol) =>
    supportsProtocol(capabilities, protocol),
  );
}

/**
 * The protocol a run uses when nothing chose one: the stated preference if the
 * connection supports it, else the first one it does. A connection supporting
 * none still answers chat completions, so readiness can name what is missing
 * instead of the run failing on an undefined protocol.
 */
export function effectiveProtocol(
  capabilities: ProviderCapabilities,
  preferred?: ProviderWireProtocol,
): ProviderWireProtocol {
  if (preferred && supportsProtocol(capabilities, preferred)) return preferred;
  return supportedProtocols(capabilities)[0] ?? preferred ??
    "openai-compatible-chat-completions";
}

function endpointWithPath(
  endpoint: string,
  suffix: string,
): string {
  const parsed = new URL(endpoint.trim());
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Endpoint must use HTTP or HTTPS.");
  }
  let path = parsed.pathname.replace(/\/+$/, "");
  for (const known of Object.values(pathByProtocol)) {
    if (path.endsWith(known)) {
      path = path.slice(0, -known.length);
      break;
    }
  }
  // A gateway may need its query (an `api-version`, say) on every call, so it
  // is kept. A fragment never reaches a server and is dropped.
  parsed.pathname = `${path}${suffix}`;
  parsed.hash = "";
  return parsed.toString();
}

/**
 * The base URL a protocol path is appended to. An endpoint that already ends
 * in any protocol's path is reduced to its base, so a pasted full URL and its
 * base address name the same connection whichever protocol a run picks.
 */
export function providerBaseEndpoint(endpoint: string): string {
  const base = new URL(endpointWithPath(endpoint, ""));
  base.pathname = base.pathname.replace(/\/+$/, "");
  return base.toString().replace(/\/(?=\?|$)/, "");
}

export function providerRequestUrl(
  endpoint: string,
  protocol: ProviderWireProtocol,
): string {
  return endpointWithPath(endpoint, pathByProtocol[protocol]);
}

/**
 * Where a connection lists its models; the same path for every protocol. The
 * query is dropped, as discovery always has: a listing is not a model call.
 */
export function providerModelsUrl(endpoint: string): string {
  const url = new URL(endpointWithPath(endpoint, "/models"));
  url.search = "";
  return url.toString();
}

/**
 * Whether two endpoints dial the same provider. Compared on the base URL, so
 * an endpoint with a protocol path appended, a trailing slash, or a differently
 * cased host is the same target as its base.
 */
export function sameProviderTarget(a: string, b: string): boolean {
  try {
    return providerBaseEndpoint(a) === providerBaseEndpoint(b);
  } catch {
    // An endpoint that cannot be parsed is reported by the readiness checks
    // that own it. Comparing the text is the most this can honestly say.
    return a.trim() === b.trim();
  }
}

/**
 * Headers a protocol needs that are not credentials. Safe to record in
 * evidence as-is.
 */
export function protocolHeaders(
  protocol: ProviderWireProtocol,
): Record<string, string> {
  return protocol === "anthropic-messages"
    ? { "anthropic-version": ANTHROPIC_VERSION }
    : {};
}

/** How a protocol presents an API key. An empty key sends nothing. */
export function credentialHeaders(
  protocol: ProviderWireProtocol,
  apiKey: string,
): Record<string, string> {
  if (!apiKey) return {};
  return protocol === "anthropic-messages"
    ? { "x-api-key": apiKey }
    : { authorization: `Bearer ${apiKey}` };
}

/** The credential headers as they appear in recorded evidence. */
export function redactedCredentialHeaders(
  protocol: ProviderWireProtocol,
  hasCredential: boolean,
): Record<string, string> {
  const name = protocol === "anthropic-messages" ? "x-api-key" : "authorization";
  const masked = protocol === "anthropic-messages" ? "••••••••" : "Bearer ••••••••";
  return { [name]: hasCredential ? masked : "(not set)" };
}
