import {
  validateSameOrigin,
  WorkbenchRequestError,
} from "../../../services/api/src";
import {
  isContainerizedRuntime,
  runtimeCredentialStore,
  runtimeRequestPolicy,
} from "../credential-store";

export const runtime = "nodejs";

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
  const connection = store.connectionConfiguration();
  return Response.json(
    {
      containerized: isContainerizedRuntime(),
      serverDefaultCredentialConfigured: store.isConfigured(),
      ...(connection ?? {}),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
