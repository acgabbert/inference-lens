import { protocolLabel } from "../../core/src/provider-protocols.ts";
import type {
  EvaluationBatchLimit,
  EvaluationBatchSize,
} from "../../runner/src/evaluation-batch-limits.ts";
import type {
  EvaluationResolvedLocalTarget,
  EvaluationStartBlocker,
} from "../../runner/src/evaluation-start.ts";
import type { RepeatedLocalConnection, RepeatedStartBlocker } from "../../runner/src/repeated-start.ts";

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
      return `This suite exposes ${toolNames.join(", ")}, and nothing in this run can answer ${one ? "it" : "them"}. ` +
        `Grant ${one ? "it" : "each"} with --allow-tool <tool>=command:<id> or --allow-tool <tool>=mcp:<server-id>, ` +
        `enable a mock for ${one ? "that tool" : "those tools"} in the app, or remove ${one ? "it" : "them"} from the suite.`;
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

function defaultConnection(connection: RepeatedLocalConnection): string {
  return `connection "${connection.requirementName}" (${connection.requirementId})`;
}

/** The CLI's wording for why `repeat` cannot start, naming the remedy in `project.json` or on the command line. */
export function describeRepeatedStartBlocker(blocker: RepeatedStartBlocker): string {
  switch (blocker.kind) {
    case "template_diagnostic":
      return blocker.message;
    case "endpoint_missing":
      return `The ${defaultConnection(blocker.connection)} has no endpoint.`;
    case "protocol_disabled":
      return `The project's defaults use ${protocolLabel(blocker.protocol)}, but ${defaultConnection(blocker.connection)} does not enable it. ` +
        "Enable it in that connection's capabilityOverrides, or choose another protocol for the project's defaults.";
    case "streaming_unsupported":
      return `--response-mode streaming was requested, but ${defaultConnection(blocker.connection)} does not enable streaming. ` +
        "Enable it in that connection's capabilityOverrides, or pass --response-mode buffered.";
    case "tools_unsupported":
      return `The project's defaults enable tools, but ${defaultConnection(blocker.connection)} does not enable them. ` +
        "Enable tools in that connection's capabilityOverrides, or disable the tools in the app.";
    case "unbound_tools": {
      const { toolNames } = blocker;
      const one = toolNames.length === 1;
      return `The project's defaults enable ${toolNames.join(", ")}, and nothing in this run can answer ${one ? "it" : "them"}. ` +
        `Grant ${one ? "it" : "each"} with --allow-tool <tool>=command:<id> or --allow-tool <tool>=mcp:<server-id>, ` +
        `or enable a mock for ${one ? "that tool" : "those tools"} in the app.`;
    }
  }
}
