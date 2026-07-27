import { discoverOpenAICompatibleModels } from "../../../packages/core/src/openai-compatible";
import type { ResolvedInferenceRequest } from "../../../packages/core/src/types";
import {
  explainProviderTransportError,
  resolveModelDiscoveryRequest,
  validateWorkbenchRequest,
  WorkbenchRequestError,
} from "../../../services/api/src";
import {
  isContainerizedRuntime,
  runtimeCredentialStore,
  runtimeRequestPolicy,
} from "../credential-store";

// Compose runs the standalone Node server, where credentials are read from the
// container environment when each request is handled.
export const runtime = "nodejs";

export async function POST(incoming: Request): Promise<Response> {
  let request:
    | Pick<ResolvedInferenceRequest, "endpoint" | "apiKey" | "capabilities">
    | undefined;
  try {
    validateWorkbenchRequest(incoming, runtimeRequestPolicy());
    request = resolveModelDiscoveryRequest(
      await incoming.json(),
      runtimeCredentialStore(),
    );
    const models = await discoverOpenAICompatibleModels(request, incoming.signal);
    return Response.json({ models }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const providerStatus =
      error &&
      typeof error === "object" &&
      "status" in error &&
      typeof error.status === "number"
        ? error.status
        : undefined;
    const status = error instanceof WorkbenchRequestError
      ? error.status
      : (providerStatus ?? 400);
    const message =
      error instanceof Error ? error.message : "Could not list models.";
    // Discovery is usually the first request a new user makes, so a container
    // that cannot reach the address they typed should say so here too. Only a
    // failure with no provider status means nothing answered.
    const reachable =
      error instanceof WorkbenchRequestError || providerStatus !== undefined;
    return Response.json(
      {
        error:
          reachable || !request
            ? message
            : explainProviderTransportError(
                message,
                request.endpoint,
                isContainerizedRuntime(),
              ),
      },
      { status },
    );
  }
}
