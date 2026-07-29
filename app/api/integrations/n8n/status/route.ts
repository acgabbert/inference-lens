import { handleN8nStatusRequest } from "../../../../../services/api/src";
import { runtimeRequestPolicy } from "../../../credential-store";

export const runtime = "nodejs";

export function GET(incoming: Request): Response {
  return handleN8nStatusRequest(incoming, process.env, runtimeRequestPolicy());
}
