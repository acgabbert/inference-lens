import {
  executeDecision,
  resolveDecisionRequest,
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

/**
 * Executes one decision (System One) exchange with the credential the server
 * resolves (D14). The events are NDJSON, as for chat turns, so the request
 * evidence reaches the browser even when the provider never answers.
 */
export async function POST(incoming: Request): Promise<Response> {
  let request;
  try {
    validateWorkbenchRequest(incoming, runtimeRequestPolicy());
    request = resolveDecisionRequest(
      await incoming.json(),
      runtimeCredentialStore(),
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Invalid request." },
      { status: error instanceof WorkbenchRequestError ? error.status : 400 },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of executeDecision(
          request.execution,
          request.apiKey,
          incoming.signal,
          { containerized: isContainerizedRuntime() },
        )) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
