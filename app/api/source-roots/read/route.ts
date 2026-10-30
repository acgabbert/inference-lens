import {
  readSourceRootCatalog,
  readSourceRootFiles,
  resolveSourceFileReadRequest,
  validateWorkbenchRequest,
  WorkbenchRequestError,
} from "../../../../services/api/src";
import type { SourceFileReadResponse } from "../../../../packages/contracts/src";
import { runtimeRequestPolicy } from "../../credential-store";

export const runtime = "nodejs";

/**
 * Reads linked prompt files, confined to their declared folders. Each file is
 * answered with its text or a named reason, so one missing file does not hide
 * the others' drift.
 */
export async function POST(incoming: Request): Promise<Response> {
  let request;
  try {
    validateWorkbenchRequest(incoming, runtimeRequestPolicy());
    request = resolveSourceFileReadRequest(await incoming.json());
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Invalid request." },
      { status: error instanceof WorkbenchRequestError ? error.status : 400 },
    );
  }
  const body: SourceFileReadResponse = { results: await readSourceRootFiles(readSourceRootCatalog(), request.files) };
  return Response.json(body, { headers: { "cache-control": "no-store" } });
}
