/**
 * Run traces are diagnostic evidence, not authored project state. The parser
 * validates the versioned envelope and reconstructs canonical state from its
 * event stream. Incompatible or internally inconsistent artifacts are
 * rejected instead of being displayed as trustworthy evidence.
 */
export class RunTraceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunTraceValidationError";
  }
}
