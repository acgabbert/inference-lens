import {
  listSourceRootFiles,
  readSourceRootCatalog,
  validateSameOrigin,
  WorkbenchRequestError,
} from "../../../../services/api/src";
import type { SourceRootFileListResponse } from "../../../../packages/contracts/src";
import { runtimeRequestPolicy } from "../../credential-store";

export const runtime = "nodejs";

/** The `.md` and `.txt` files in one declared source folder, for choosing a link. */
export async function GET(incoming: Request): Promise<Response> {
  try {
    validateSameOrigin(incoming, runtimeRequestPolicy());
    const root = new URL(incoming.url).searchParams.get("root") ?? "";
    const body: SourceRootFileListResponse = await listSourceRootFiles(readSourceRootCatalog(), root);
    return Response.json(body, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Invalid request." },
      { status: error instanceof WorkbenchRequestError ? error.status : 500 },
    );
  }
}
