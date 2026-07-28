import { handleN8nExecutionDetailRequest } from "../../../../../services/api/src";
import { runtimeRequestPolicy } from "../../../credential-store";

export const runtime = "nodejs";

export function POST(incoming: Request): Promise<Response> {
  return handleN8nExecutionDetailRequest(
    incoming,
    process.env,
    runtimeRequestPolicy(),
  );
}
