import { z } from "zod";
import { stableJsonValue } from "./stable-json.ts";
import type { EvaluationCaseId, EvaluationSuiteId, ExperimentCellId, RunId } from "./run-kernel/types.ts";

export const EVALUATION_CASE_SOURCES_FILE_NAME = "evaluation-case-sources.json";

export interface EvaluationCaseSource {
  suiteId: EvaluationSuiteId;
  caseId: EvaluationCaseId;
  runId: RunId;
  capturedAt: string;
  experimentCellId?: ExperimentCellId;
}

export interface EvaluationCaseSourcesFileV1 {
  schemaVersion: 1;
  sources: EvaluationCaseSource[];
}

const sourceSchema = z.object({
  suiteId: z.string().regex(/^evaluation-suite_.+/),
  caseId: z.string().regex(/^evaluation-case_.+/),
  runId: z.string().regex(/^run_.+/),
  capturedAt: z.string().datetime(),
  experimentCellId: z.string().regex(/^experiment-cell_.+/).optional(),
}).strict();
const fileSchema = z.object({ schemaVersion: z.literal(1), sources: z.array(sourceSchema) }).strict().superRefine((file, context) => {
  const seen = new Set<string>();
  file.sources.forEach((source, index) => {
    const key = `${source.suiteId}::${source.caseId}`;
    if (seen.has(key)) context.addIssue({ code: "custom", path: ["sources", index], message: "Each evaluation case can have only one source annotation." });
    seen.add(key);
  });
});

export class EvaluationCaseSourcesValidationError extends Error {
  constructor(message: string) { super(message); this.name = "EvaluationCaseSourcesValidationError"; }
}

export function emptyEvaluationCaseSources(): EvaluationCaseSourcesFileV1 { return { schemaVersion: 1, sources: [] }; }

export function parseEvaluationCaseSourcesJson(contents: string): EvaluationCaseSourcesFileV1 {
  let value: unknown;
  try { value = JSON.parse(contents); } catch { throw new EvaluationCaseSourcesValidationError("Evaluation case sources is not valid JSON."); }
  const parsed = fileSchema.safeParse(value);
  if (!parsed.success) throw new EvaluationCaseSourcesValidationError(`Invalid evaluation case sources: ${parsed.error.issues[0]?.message ?? "unknown error"}`);
  return parsed.data as EvaluationCaseSourcesFileV1;
}

export function serializeEvaluationCaseSources(file: EvaluationCaseSourcesFileV1): string {
  const parsed = fileSchema.safeParse(file);
  if (!parsed.success) throw new EvaluationCaseSourcesValidationError(`Invalid evaluation case sources: ${parsed.error.issues[0]?.message ?? "unknown error"}`);
  return `${JSON.stringify(stableJsonValue(parsed.data), null, 2)}\n`;
}

export function upsertEvaluationCaseSource(file: EvaluationCaseSourcesFileV1, source: EvaluationCaseSource): EvaluationCaseSourcesFileV1 {
  return { schemaVersion: 1, sources: [...file.sources.filter((item) => item.suiteId !== source.suiteId || item.caseId !== source.caseId), source] };
}
