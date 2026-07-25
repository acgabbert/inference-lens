export class WorkbenchRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "WorkbenchRequestError";
    this.status = status;
  }
}

/**
 * Keeps browser callers on the local workbench origin and requires a
 * non-simple JSON request so cross-origin pages cannot submit API work without
 * a CORS preflight.
 */
export function validateWorkbenchRequest(request: Request): void {
  const mediaType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    throw new WorkbenchRequestError(
      "Content-Type must be application/json.",
      415,
    );
  }

  const origin = request.headers.get("origin");
  if (!origin) return;

  let callerOrigin: string;
  try {
    callerOrigin = new URL(origin).origin;
  } catch {
    throw new WorkbenchRequestError("Request origin is invalid.", 403);
  }
  if (callerOrigin !== new URL(request.url).origin) {
    throw new WorkbenchRequestError(
      "Cross-origin API requests are not allowed.",
      403,
    );
  }
}
