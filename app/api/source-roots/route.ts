import {
  readSourceRootCatalog,
  SOURCE_ROOTS_VARIABLE,
  validateSameOrigin,
  WorkbenchRequestError,
} from "../../../services/api/src";
import type { SourceRootCatalogResponse } from "../../../packages/contracts/src";
import { runtimeRequestPolicy } from "../credential-store";

export const runtime = "nodejs";

/**
 * Which source folders linked prompts may be read from: names and labels,
 * never host paths. An unconfigured service answers plainly, naming the
 * variable that changes it, because that is the state the UI must explain.
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
  const source = readSourceRootCatalog();
  const body: SourceRootCatalogResponse = {
    available: source.available,
    ...(source.problem === undefined ? {} : { problem: source.problem }),
    configurationVariable: SOURCE_ROOTS_VARIABLE,
    roots: source.roots.map(({ name, label }) => ({ name, ...(label ? { label } : {}) })),
  };
  return Response.json(body, { headers: { "cache-control": "no-store" } });
}
