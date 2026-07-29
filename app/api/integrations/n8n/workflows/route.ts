import { handleN8nWorkflowsRequest } from "../../../../../services/api/src";
import { runtimeRequestPolicy } from "../../../credential-store";

export const runtime = "nodejs";

export function GET(incoming: Request): Promise<Response> {
  return handleN8nWorkflowsRequest(
    incoming,
    process.env,
    runtimeRequestPolicy(),
  );
}
