import type { RunReferenceV1 } from "./run-reference.ts";
import { isTraceEntryName, parseSavedRunTraceJson, traceFileName, type SavedRunTrace } from "./run-trace.ts";

export interface RunReferenceStorage {
  readTrace(fileName: string): Promise<string>;
  listTraces(): Promise<Array<{ fileName: string; contents: string; readError?: string }>>;
}
export interface ResolvedRunEvidence { fileName: string; saved: SavedRunTrace }
export class RunReferenceResolutionError extends Error {
  readonly kind: "missing" | "invalid" | "ambiguous";
  constructor(kind: "missing" | "invalid" | "ambiguous", message: string) { super(message); this.kind = kind; }
}
function missing(error: unknown): boolean {
  return error instanceof Error && error.name === "NotFoundError";
}
export async function resolveRunReference(ref: RunReferenceV1, storage: RunReferenceStorage, isCurrent = () => true): Promise<ResolvedRunEvidence> {
  function parse(fileName: string, contents: string): ResolvedRunEvidence {
    const saved = parseSavedRunTraceJson(contents);
    if (saved.trace.runId !== ref.runId) throw new Error("The trace contains a different run ID.");
    return { fileName, saved };
  }
  const canonical = traceFileName(ref.runId);
  let contents: string;
  try { contents = await storage.readTrace(canonical); }
  catch (error) {
    if (!missing(error)) throw new RunReferenceResolutionError("invalid", `Cannot read ${canonical}: ${error instanceof Error ? error.message : String(error)}`);
    const files = await storage.listTraces();
    if (!isCurrent()) throw new Error("Run lookup cancelled.");
    const matches: ResolvedRunEvidence[] = []; let unreadable = 0;
    for (const file of files) {
      if (!isTraceEntryName(file.fileName)) continue;
      try {
        if (file.readError) throw new Error(file.readError);
        const saved = parseSavedRunTraceJson(file.contents);
        if (saved.trace.runId === ref.runId) matches.push({ fileName: file.fileName, saved });
      } catch { unreadable++; }
    }
    if (matches.length > 1) throw new RunReferenceResolutionError("ambiguous", "Multiple renamed traces contain this run ID. Remove duplicate evidence from the folder and retry.");
    if (!matches.length) throw new RunReferenceResolutionError("missing", `The saved run was not found in this project.${unreadable ? ` ${unreadable} trace files could not be validated.` : ""} Git may exclude run history. Restore the trace into this project folder and retry.`);
    return matches[0]!;
  }
  try { return parse(canonical, contents); }
  catch (error) { throw new RunReferenceResolutionError("invalid", `Invalid canonical trace ${canonical}: ${error instanceof Error ? error.message : String(error)}`); }
}
