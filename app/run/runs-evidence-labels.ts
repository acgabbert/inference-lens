import type { ExperimentPlanV3 } from "../../packages/core/src/experiment.ts";
import { protocolLabel } from "../../packages/core/src/provider-protocols.ts";
import type {
  ProviderProtocol,
  RunId,
  RunState,
} from "../../packages/core/src/run-kernel/types.ts";
import type { TraceStorageStatus } from "../response-output.client";

/** The protocol a run was sent over, as a row names it. */
export function protocolName(protocol: ProviderProtocol | undefined): string | undefined {
  if (!protocol) return undefined;
  return protocol === "mock" ? "Mock" : protocolLabel(protocol);
}

/**
 * Where the in-memory run lives, said so that an unsaved one is never mistaken
 * for history. Only the latest ordinary run is held, so anything not written
 * to a folder is gone as soon as another run starts.
 */
export function currentRunStorageLabel(
  status: RunState["status"]["kind"],
  storage: TraceStorageStatus | null,
): string {
  if (!["completed", "cancelled", "failed"].includes(status)) {
    return "Current session";
  }
  switch (storage?.kind) {
    case "saved":
      return "Saved to folder";
    case "saving":
      return "Saving to folder…";
    case "loaded":
      return `Opened from ${storage.fileName}`;
    case "downloaded":
      return `Exported as ${storage.fileName} · not in this folder`;
    case "error":
      return "Not saved · could not write to the folder";
    default:
      return "Not saved · replaced by the next run";
  }
}

/** Matches the title a saved batch carries in project history. */
export function batchTitle(plan: ExperimentPlanV3): string {
  return plan.kind === "evaluation"
    ? `Evaluation · ${plan.suite.name}`
    : `Repeated experiment · ${plan.commonInput.target.model}`;
}

/**
 * Names one run within its batch by what distinguishes it there: the case,
 * then the configuration and repetition only when the batch has more than one.
 */
export function batchMemberLabel(plan: ExperimentPlanV3, runId: RunId): string | undefined {
  if (plan.kind === "repeated-request") {
    const cell = plan.cells.find((candidate) => candidate.runId === runId);
    return cell ? `Repetition ${cell.ordinal}` : undefined;
  }
  const cell = plan.cells.find((candidate) => candidate.runId === runId);
  if (!cell) return undefined;
  const caseName = plan.suite.cases.find(({ caseId }) => caseId === cell.caseId)?.name ?? "Case";
  const variant = plan.suite.variants.length > 1
    ? plan.suite.variants.find(({ variantId }) => variantId === cell.variantId)?.name
    : undefined;
  return [
    caseName,
    ...(variant ? [variant] : []),
    ...(plan.repetitions > 1 ? [`repetition ${cell.repetition}`] : []),
  ].join(" · ");
}
