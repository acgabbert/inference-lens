import { discoverDecisionModelsOverHttp } from "../../../packages/core/src/decision-discovery";
import { discoverOpenAICompatibleModels } from "../../../packages/core/src/openai-compatible";
import { explainProviderStatusError } from "../../../packages/core/src/provider-protocols";
import {
  explainProviderTransportError,
  resolveModelDiscoveryRequest,
  type ResolvedModelDiscoveryRequest,
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
  let request: ResolvedModelDiscoveryRequest | undefined;
  try {
    validateWorkbenchRequest(incoming, runtimeRequestPolicy());
    request = resolveModelDiscoveryRequest(
      await incoming.json(),
      runtimeCredentialStore(),
    );
    const { protocol } = request;
    const discovery = protocol === "systemone"
      ? await discoverDecisionModelsOverHttp(request, incoming.signal)
      : { models: await discoverOpenAICompatibleModels({ ...request, protocol }, incoming.signal) };
    return Response.json(discovery, { headers: { "cache-control": "no-store" } });
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
    // that cannot reach the address they typed, or a base URL missing its
    // version segment, should say so here too. Only a failure with no provider
    // status means nothing answered.
    const explained = !request || error instanceof WorkbenchRequestError
      ? message
      : providerStatus !== undefined
        ? explainProviderStatusError(message, providerStatus, request.endpoint)
        : explainProviderTransportError(
            message,
            request.endpoint,
            isContainerizedRuntime(),
          );
    return Response.json({ error: explained }, { status });
  }
}
