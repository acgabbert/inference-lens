import {
  ToolRegistryStorageUnavailableError,
  WorkbenchRequestError,
  resolveReplaceToolRegistryRequest,
  validateSameOrigin,
  validateWorkbenchRequest,
} from "../../../services/api/src";
import {
  ToolRegistryConflictError,
  ToolRegistryValidationError,
} from "../../../packages/core/src/tool-registry";
import { runtimeRequestPolicy } from "../credential-store";
import { runtimeToolRegistryStore } from "../tool-registry-store";

export const runtime = "nodejs";

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function failure(error: unknown): Response {
  if (error instanceof ToolRegistryConflictError) {
    return response({ error: error.message, actualRevision: error.actualRevision }, 409);
  }
  if (error instanceof ToolRegistryStorageUnavailableError) {
    return response({ error: error.message }, 404);
  }
  if (error instanceof WorkbenchRequestError) return response({ error: error.message }, error.status);
  if (error instanceof ToolRegistryValidationError) return response({ error: error.message }, 400);
  return response({ error: "The shared tool registry could not be accessed." }, 500);
}

export async function GET(incoming: Request): Promise<Response> {
  try {
    validateSameOrigin(incoming, runtimeRequestPolicy());
    return response(await runtimeToolRegistryStore().load());
  } catch (error) {
    return failure(error);
  }
}

export async function PUT(incoming: Request): Promise<Response> {
  try {
    validateWorkbenchRequest(incoming, runtimeRequestPolicy());
    let value: unknown;
    try {
      value = await incoming.json();
    } catch {
      throw new ToolRegistryValidationError([{ code: "custom", path: [], message: "Request body is not valid JSON." }]);
    }
    const request = resolveReplaceToolRegistryRequest(value);
    return response(await runtimeToolRegistryStore().replace(request.registry, request.expectedRevision));
  } catch (error) {
    return failure(error);
  }
}
