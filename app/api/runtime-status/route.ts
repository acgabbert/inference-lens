import {
  validateSameOrigin,
  WorkbenchRequestError,
} from "../../../services/api/src";
import {
  isContainerizedRuntime,
  runtimeCredentialStore,
  runtimeRequestPolicy,
} from "../credential-store";
import { protocolConfigurationNames } from "../../../packages/core/src/provider-protocols";
import { DEFAULT_SERVER_CONNECTION_ID } from "../../../packages/core/src/server-connection-catalog";

export const runtime = "nodejs";

// Each line is logged once per process: the probe runs on every page load, and
// an operator reading the container's log needs the line once, not on every
// visit.
const reportedProblems = new Set<string>();

function warnOnce(line: string): void {
  if (reportedProblems.has(line)) return;
  reportedProblems.add(line);
  console.warn(line);
}

/**
 * Describes how this service is deployed and what it is already configured to
 * connect to, so the UI can prefill a profile and explain a container-specific
 * mistake before the user hits it. Reports configuration only; credential
 * material never leaves the server.
 */
export function GET(incoming: Request): Response {
  try {
    validateSameOrigin(incoming, runtimeRequestPolicy());
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Invalid request." },
      { status: error instanceof WorkbenchRequestError ? error.status : 403 },
    );
  }

  const store = runtimeCredentialStore();
  // Independent facts: an endpoint may be configured for a provider that needs
  // no key at all, which is the normal shape of a local llama.cpp server.
  const connection = store.defaultConnection.connectionConfiguration();
  const report = store.report();
  for (const { id, unrecognizedProtocols } of report.connections) {
    if (!unrecognizedProtocols) continue;
    const source =
      id === DEFAULT_SERVER_CONNECTION_ID
        ? "INFERENCE_LENS_API_PROTOCOLS"
        : `Server connection "${id}"'s protocols`;
    warnOnce(
      `${source} names ${unrecognizedProtocols
        .map((name) => `"${name}"`)
        .join(", ")}, which ${
        unrecognizedProtocols.length === 1 ? "is" : "are"
      } not a recognized API. The whole list is ignored; accepted names are ${protocolConfigurationNames().join(", ")}.`,
    );
  }
  for (const line of report.diagnostics) warnOnce(line);
  return Response.json(
    {
      containerized: isContainerizedRuntime(),
      // The flat fields describe `default` alone and are what the page reads
      // until it learns the list (slice 2 of SERVER_CONNECTIONS_DESIGN.md),
      // which then replaces them.
      serverDefaultCredentialConfigured: store.defaultConnection.isConfigured(),
      ...(connection ?? {}),
      connections: report.connections,
      ...(report.catalogProblem ? { catalogProblem: report.catalogProblem } : {}),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
