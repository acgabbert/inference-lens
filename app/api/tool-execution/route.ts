import {
  executeCommandTool,
  resolveCommandToolExecutionRequest,
  validateWorkbenchRequest,
  WorkbenchRequestError,
} from "../../../services/api/src";
import { runtimeRequestPolicy } from "../credential-store";

export const runtime = "nodejs";

/**
 * Runs one declared command tool.
 *
 * The request carries a command id, never an executable: what may run is the
 * operator's catalog, and this route is the boundary that keeps it that way.
 * Everything that goes wrong *after* that check is answered as a normalized
 * `ToolExecutionOutcome` with a 200, because a tool that timed out is a run
 * event rather than an HTTP error, and the client must record it as evidence
 * rather than as a broken request.
 */
export async function POST(incoming: Request): Promise<Response> {
  let request;
  try {
    validateWorkbenchRequest(incoming, runtimeRequestPolicy());
    request = resolveCommandToolExecutionRequest(await incoming.json());
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Invalid request." },
      { status: error instanceof WorkbenchRequestError ? error.status : 400 },
    );
  }

  const outcome = await executeCommandTool(request, { signal: incoming.signal });
  return Response.json(outcome, { headers: { "cache-control": "no-store" } });
}
