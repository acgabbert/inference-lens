/** A transport failure whose HTTP status is safe to use for retry policy. */
export class InferenceTransportError extends Error {
  readonly status?: number;

  constructor(
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = "InferenceTransportError";
    this.status = status;
  }
}
