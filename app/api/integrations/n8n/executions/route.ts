import { handleN8nExecutionsRequest } from "../../../../../services/api/src";
import { runtimeRequestPolicy } from "../../../credential-store";

export const runtime = "nodejs";

export function GET(incoming: Request): Promise<Response> {
  return handleN8nExecutionsRequest(
    incoming,
    process.env,
    runtimeRequestPolicy(),
  );
}
