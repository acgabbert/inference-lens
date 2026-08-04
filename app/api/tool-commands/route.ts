import {
  COMMAND_TOOLS_VARIABLE,
  readCommandToolCatalog,
  validateSameOrigin,
  WorkbenchRequestError,
} from "../../../services/api/src";
import type { CommandToolCatalogResponse } from "../../../packages/contracts/src";
import { runtimeRequestPolicy } from "../credential-store";

export const runtime = "nodejs";

/**
 * What this service is willing to spawn.
 *
 * Read-only, same-origin, and the only way the UI learns that command tools
 * exist at all. An unconfigured service answers plainly rather than 404-ing,
 * because "nothing is declared here" is the state the UI has to explain — and
 * it must name the variable that changes it, not leave a user guessing.
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

  const source = readCommandToolCatalog();
  const body: CommandToolCatalogResponse = {
    available: source.available,
    ...(source.problem === undefined ? {} : { problem: source.problem }),
    configurationVariable: COMMAND_TOOLS_VARIABLE,
    commands: source.commands,
  };
  return Response.json(body, { headers: { "cache-control": "no-store" } });
}
