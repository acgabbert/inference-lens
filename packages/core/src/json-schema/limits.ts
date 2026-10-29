import type { SchemaEvaluationLimits } from "./evaluator.ts";

/**
 * Calibrated limits for structured-output schema checks
 * (docs/JSON_SCHEMA_CALIBRATION.md). The output limit and work budget are
 * chosen together: any answer within the output limit indexes within half the
 * verdict budget, and any schema within the size limit preflights within the
 * schema budget. Like the charge table, these values become part of the check
 * vocabulary that ships them; changing them afterwards is a vocabulary change.
 */
export const MAX_SCHEMA_OUTPUT_CODE_UNITS = 150_000;

export const SCHEMA_CHECK_LIMITS: SchemaEvaluationLimits = Object.freeze({
  schema: Object.freeze({ workLimit: 600_000, storageLimit: 2_000_000, maxSchemaCodeUnits: 65_536, maxDepth: 64 }),
  verdict: Object.freeze({ workLimit: 750_000, storageLimit: 4_000_000 }),
  diagnostics: Object.freeze({ workLimit: 100_000, storageLimit: 1_000_000, maxIssues: 20 }),
  maxDataDepth: 64,
});
