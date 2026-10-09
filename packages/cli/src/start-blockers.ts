import { protocolLabel } from "../../core/src/provider-protocols.ts";
import type {
  EvaluationBatchLimit,
  EvaluationBatchSize,
} from "../../runner/src/evaluation-batch-limits.ts";
import type {
  EvaluationResolvedLocalTarget,
  EvaluationStartBlocker,
} from "../../runner/src/evaluation-start.ts";

function describeBatchLimit(limit: EvaluationBatchLimit, size: EvaluationBatchSize): string {
  switch (limit.kind) {
    case "repetitions_invalid":
      return "The suite's repetitions must be a positive whole number.";
    case "repetitions_exceeded":
      return `Evaluations support at most ${limit.maximum} repetitions. Lower the suite's repetitions.`;
    case "calls_exceeded":
      return size.turnCeiling === 1
        ? `This suite would make ${size.worstCaseCalls} provider calls; the safety maximum is ${limit.maximum}. Reduce its cases or repetitions.`
        : `This suite exposes tools, so its ${size.plannedCalls} repetitions may make up to ${size.worstCaseCalls} provider calls; the safety maximum is ${limit.maximum}. Reduce its cases, repetitions, or turn ceiling.`;
  }
}

function connection(target: EvaluationResolvedLocalTarget): string {
  return `connection "${target.requirementName}" (${target.requirementId})`;
}

/**
 * The CLI's wording for a blocker. The app names the preflight control that
 * clears it; here the remedy is a field in `project.json`.
 */
export function describeStartBlocker(blocker: EvaluationStartBlocker): string {
  switch (blocker.kind) {
    case "suite_diagnostic":
      return blocker.message;
    case "no_configuration_selected":
      return "The suite has no configurations to run.";
    case "batch_limit":
      return describeBatchLimit(blocker.limit, blocker.size);
    case "unbound_tools": {
      const { toolNames } = blocker;
      const one = toolNames.length === 1;
      return `This suite exposes ${toolNames.join(", ")}, and headless runs can serve only enabled project mocks so far. ` +
        `Enable a mock for ${one ? "that tool" : "those tools"} in the app, or remove ${one ? "it" : "them"} from the suite.`;
    }
    case "profile_unmapped":
      return `No ${connection(blocker.target)} was resolved for configuration "${blocker.target.variantName}".`;
    case "endpoint_missing":
      return `The ${connection(blocker.target)} has no endpoint.`;
    case "model_missing":
      return `Configuration "${blocker.target.variantName}" has no model.`;
    case "protocol_disabled":
      return `Configuration "${blocker.target.variantName}" uses ${protocolLabel(blocker.target.protocol)}, but ${connection(blocker.target)} does not enable it. ` +
        "Enable it in that connection's capabilityOverrides, or choose another protocol for the configuration.";
    case "streaming_unsupported":
      return `Configuration "${blocker.target.variantName}" uses streaming, but ${connection(blocker.target)} does not enable it. ` +
        "Enable it in that connection's capabilityOverrides, or set the suite to buffered delivery.";
    case "tools_unsupported":
      return `Configuration "${blocker.target.variantName}" exposes tools, but ${connection(blocker.target)} does not enable them. ` +
        "Enable tools in that connection's capabilityOverrides, or remove the tools from the suite.";
  }
}
