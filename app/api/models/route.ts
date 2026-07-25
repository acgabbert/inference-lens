import { discoverOpenAICompatibleModels } from "../../../packages/core/src/openai-compatible";
import type { ResolvedInferenceRequest } from "../../../packages/core/src/types";
import {
  resolveModelDiscoveryRequest,
  validateWorkbenchRequest,
  WorkbenchRequestError,
} from "../../../services/api/src";
import { runtimeCredentialStore } from "../credential-store";

// Compose runs the standalone Node server, where credentials are read from the
// container environment when each request is handled.
export const runtime = "nodejs";

export async function POST(incoming: Request): Promise<Response> {
  let request: Pick<
    ResolvedInferenceRequest,
    "endpoint" | "apiKey" | "capabilities"
  >;
  try {
    validateWorkbenchRequest(incoming);
    request = resolveModelDiscoveryRequest(
      await incoming.json(),
      runtimeCredentialStore(),
    );
    const models = await discoverOpenAICompatibleModels(request, incoming.signal);
    return Response.json({ models }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const status = error instanceof WorkbenchRequestError
      ? error.status
      : error &&
          typeof error === "object" &&
          "status" in error &&
          typeof error.status === "number"
        ? error.status
        : 400;
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not list models." },
      { status },
    );
  }
}
