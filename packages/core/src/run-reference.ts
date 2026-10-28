import type { ProjectId, RunId } from "./run-kernel/types.ts";
import { traceFileName } from "./run-trace.ts";

/** Independent of project and trace serialization versions, providers and hosts. */
export interface RunReferenceV1 { version: 1; projectId: ProjectId; runId: RunId }
export type RunReferenceResult =
  | { kind: "valid"; reference: RunReferenceV1 }
  | { kind: "invalid" | "unsupported-version"; message: string };
/** 16 Ki UTF-16 code units, including the encoded payload/outer URL. */
export const MAX_RUN_LINK_LENGTH = 16_384;

export function validateRunReference(value: unknown): RunReferenceResult {
  if (!value || typeof value !== "object") return { kind: "invalid", message: "Invalid run reference." };
  const ref = value as Record<string, unknown>;
  if (ref.version !== 1) return { kind: "unsupported-version", message: "This run link needs a newer version of Inference Lens." };
  // Same project-ID semantics as the existing project schema; never a UUID assumption.
  if (typeof ref.projectId !== "string" || !/^project_.+/.test(ref.projectId) || typeof ref.runId !== "string") return { kind: "invalid", message: "The link needs valid project and run IDs." };
  try { traceFileName(ref.runId as RunId); }
  catch { return { kind: "invalid", message: "The link contains an invalid run ID." }; }
  const reference: RunReferenceV1 = { version: 1, projectId: ref.projectId as ProjectId, runId: ref.runId as RunId };
  const payload = formatRunReferenceUnchecked(reference);
  if (payload.length > MAX_RUN_LINK_LENGTH) return { kind: "invalid", message: "The run link is too long." };
  if (new URLSearchParams(payload.slice(payload.indexOf("?") + 1)).get("project") !== reference.projectId) {
    return { kind: "invalid", message: "The project ID cannot be represented in a run link." };
  }
  return { kind: "valid", reference };
}
function formatRunReferenceUnchecked(ref: RunReferenceV1): string {
  return `run/v1?${new URLSearchParams({ project: ref.projectId, run: ref.runId })}`;
}
export function formatRunReference(ref: RunReferenceV1): string {
  const result = validateRunReference(ref);
  if (result.kind !== "valid") throw new Error(result.message);
  return formatRunReferenceUnchecked(ref);
}
export function parseRunReference(payload: string): RunReferenceResult {
  const invalid = (message: string): RunReferenceResult => ({ kind: "invalid", message });
  if (payload.length > MAX_RUN_LINK_LENGTH) return invalid("The run link is too long.");
  const match = /^run\/v([^/?#]+)\?([^#]*)$/.exec(payload);
  if (!match) return invalid("This is not a saved run link.");
  if (match[1] !== "1") return { kind: "unsupported-version", message: "This run link needs a newer version of Inference Lens." };
  try {
    // URLSearchParams tolerates malformed escapes; reject them before its one decode.
    for (const part of match[2]!.split(/[&=]/)) decodeURIComponent(part.replace(/\+/g, " "));
  } catch { return invalid("The run link has malformed URL encoding."); }
  const params = new URLSearchParams(match[2]);
  if ([...params.keys()].some(key => key !== "project" && key !== "run") || params.getAll("project").length !== 1 || params.getAll("run").length !== 1) return invalid("The link needs exactly one project and run ID and no extra parameters.");
  return validateRunReference({ version: 1, projectId: params.get("project"), runId: params.get("run") });
}
