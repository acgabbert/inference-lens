import { experimentExposedTools } from "../../packages/core/src/experiment.ts";
import type { ExperimentPlanV4, ExperimentResult } from "../../packages/core/src/experiment.ts";

/**
 * Says why a batch stopped itself, for the repeated-run and evaluation result
 * surfaces alike. The failed repetition's trace holds the host's own reason;
 * this names the tool and where the batch stopped, so the reader knows which
 * repetition to open and that the rest were never sent.
 */
export function experimentStopDetail(
  plan: ExperimentPlanV4,
  result: ExperimentResult | undefined,
): string | undefined {
  const stop = result?.status === "stopped" ? result.stop : undefined;
  if (!stop) return undefined;
  const tool = experimentExposedTools(plan).find(({ id }) => id === stop.toolId)?.name ?? stop.toolId;
  const cell = plan.cells.find(({ cellId }) => cellId === stop.cellId);
  const notRun = result!.cells.filter(({ status }) => status === "not-run").length;
  const where = cell ? `in run ${cell.ordinal} of ${plan.cells.length}` : "during the batch";
  return `${tool} became unavailable ${where}, so ${notRun} remaining ${notRun === 1 ? "run was" : "runs were"} not sent. Open that run for the reason, then check the tool's server or grant.`;
}
