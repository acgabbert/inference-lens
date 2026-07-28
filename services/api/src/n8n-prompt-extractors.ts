import {
  createExternalPromptCandidate,
  type AuthoredPromptField,
  type ExternalInvocationRef,
  type ExternalPromptCandidate,
  type ExternalPromptCandidateEvidence,
  type ExpressionBinding,
  type ImportWarning,
  type ResolvedPromptSnapshot,
} from "../../../packages/core/src/external-prompt-import.ts";

import type {
  N8nExecutionDetail,
  N8nWorkflowDetail,
} from "./n8n-integration.ts";

const BASIC_LLM_CHAIN_TYPE = "@n8n/n8n-nodes-langchain.chainLlm";
const BASIC_LLM_CHAIN_VERSION = 1.9;
const OPENAI_CHAT_MODEL_TYPE = "@n8n/n8n-nodes-langchain.lmChatOpenAi";
const OPENAI_CHAT_MODEL_VERSION = 1.2;
const AUTHORED_TEXT_PATH = "parameters.text";

export interface N8nNodeSnapshot {
  id: string;
  name: string;
  type: string;
  typeVersion?: number;
  parameters: Record<string, unknown>;
}

export interface N8nWorkflowSnapshot {
  id: string;
  name: string;
  nodes: N8nNodeSnapshot[];
  connections: Record<string, unknown>;
}

export interface N8nExtractionContext {
  workflow: N8nWorkflowSnapshot;
  execution: N8nExecutionDetail;
  workflowSnapshotSource: "execution" | "current-workflow";
}

export type N8nPromptExtraction =
  | {
      status: "candidate";
      candidate: ExternalPromptCandidate;
    }
  | {
      status: "unsupported";
      invocation: ExternalInvocationRef;
      code:
        | "unsupported-node-version"
        | "unsupported-node-configuration"
        | "incompatible-node-snapshot";
      message: string;
    };

export interface N8nPromptExtractor {
  readonly id: string;
  recognizes(node: N8nNodeSnapshot): boolean;
  supports(node: N8nNodeSnapshot): boolean;
  extract(
    context: N8nExtractionContext,
    node: N8nNodeSnapshot,
  ): Promise<N8nPromptExtraction[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseNode(value: unknown): N8nNodeSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.type !== "string" ||
    !isRecord(value.parameters)
  ) {
    return undefined;
  }
  if (
    value.typeVersion !== undefined &&
    typeof value.typeVersion !== "number"
  ) {
    return undefined;
  }
  return {
    id: value.id,
    name: value.name,
    type: value.type,
    ...(value.typeVersion === undefined
      ? {}
      : { typeVersion: value.typeVersion }),
    parameters: value.parameters,
  };
}

export function parseN8nWorkflowSnapshot(
  value: unknown,
): N8nWorkflowSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !Array.isArray(value.nodes) ||
    !isRecord(value.connections)
  ) {
    return undefined;
  }
  const nodes = value.nodes.map(parseNode);
  if (nodes.some((node) => !node)) return undefined;
  return {
    id: value.id,
    name: value.name,
    nodes: nodes as N8nNodeSnapshot[],
    connections: value.connections,
  };
}

function executionWorkflowSnapshot(
  execution: N8nExecutionDetail,
): N8nWorkflowSnapshot | undefined {
  if (!isRecord(execution.data)) return undefined;
  return parseN8nWorkflowSnapshot(execution.data.workflowData);
}

function currentWorkflowSnapshot(
  workflow: N8nWorkflowDetail,
): N8nWorkflowSnapshot | undefined {
  return parseN8nWorkflowSnapshot(workflow);
}

function invocationFor(
  node: N8nNodeSnapshot,
  runIndex?: number,
  itemIndex?: number,
): ExternalInvocationRef {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    ...(node.typeVersion === undefined
      ? {}
      : { version: String(node.typeVersion) }),
    ...(runIndex === undefined ? {} : { runIndex }),
    ...(itemIndex === undefined ? {} : { itemIndex }),
  };
}

function authoredField(node: N8nNodeSnapshot): AuthoredPromptField | undefined {
  const text = node.parameters.text;
  if (typeof text !== "string") return undefined;
  return {
    path: AUTHORED_TEXT_PATH,
    role: "user",
    syntax: text.startsWith("=") ? "external-expression" : "literal",
    text,
  };
}

function sourceEvidence(
  context: N8nExtractionContext,
  node: N8nNodeSnapshot,
  authored: AuthoredPromptField,
  warnings: ImportWarning[],
  {
    runIndex,
    itemIndex,
    resolved,
    binding,
  }: {
    runIndex?: number;
    itemIndex?: number;
    resolved?: ResolvedPromptSnapshot;
    binding?: ExpressionBinding;
  } = {},
): ExternalPromptCandidateEvidence {
  return {
    source: {
      adapter: "n8n",
      resource: {
        kind: "workflow",
        id: context.workflow.id,
        name: context.workflow.name,
      },
      execution: {
        id: context.execution.id,
        ...(context.execution.startedAt
          ? { executedAt: context.execution.startedAt }
          : {}),
      },
    },
    invocation: invocationFor(node, runIndex, itemIndex),
    authored: [authored],
    ...(resolved ? { resolved } : {}),
    bindings: binding ? [binding] : [],
    fidelity: resolved ? "execution-reconstructed" : "authored-only",
    warnings,
  };
}

function warning(
  code: string,
  message: string,
  severity: ImportWarning["severity"] = "warning",
): ImportWarning {
  return { code, severity, message };
}

async function authoredOnlyCandidate(
  context: N8nExtractionContext,
  node: N8nNodeSnapshot,
  authored: AuthoredPromptField,
  code: string,
  message: string,
  runIndex?: number,
): Promise<N8nPromptExtraction> {
  const warnings = [warning(code, message)];
  if (context.workflowSnapshotSource === "current-workflow") {
    warnings.push(
      warning(
        "current-workflow-snapshot",
        "The saved execution did not contain a workflow snapshot, so the authored text comes from the current workflow and may differ from what ran.",
      ),
    );
  }
  const binding: ExpressionBinding | undefined =
    authored.syntax === "external-expression"
      ? {
          authoredPath: authored.path,
          expression: authored.text,
          source: { kind: "whole-field" },
          status: "missing",
        }
      : undefined;
  return {
    status: "candidate",
    candidate: await createExternalPromptCandidate(
      sourceEvidence(context, node, authored, warnings, {
        ...(runIndex === undefined ? {} : { runIndex }),
        ...(binding ? { binding } : {}),
      }),
    ),
  };
}

function runData(
  execution: N8nExecutionDetail,
): Record<string, unknown> | undefined {
  if (!isRecord(execution.data)) return undefined;
  const resultData = execution.data.resultData;
  if (!isRecord(resultData) || !isRecord(resultData.runData)) return undefined;
  return resultData.runData;
}

function connectedModelNodes(
  workflow: N8nWorkflowSnapshot,
  chain: N8nNodeSnapshot,
): N8nNodeSnapshot[] {
  return workflow.nodes.filter((node) => {
    const fromNode = workflow.connections[node.name];
    if (!isRecord(fromNode) || !Array.isArray(fromNode.ai_languageModel)) {
      return false;
    }
    return fromNode.ai_languageModel.some(
      (output) =>
        Array.isArray(output) &&
        output.some(
          (connection) =>
            isRecord(connection) &&
            connection.node === chain.name &&
            connection.type === "ai_languageModel",
        ),
    );
  });
}

function parentItemCount(run: unknown): number | undefined {
  if (!isRecord(run) || !isRecord(run.data)) return undefined;
  const main = run.data.main;
  if (
    !Array.isArray(main) ||
    !Array.isArray(main[0])
  ) {
    return undefined;
  }
  return main[0].length;
}

function modelRunsForParent(
  value: unknown,
  parentName: string,
  parentRunIndex: number,
): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.filter((run) => {
    if (!isRecord(run) || !Array.isArray(run.source)) return false;
    return run.source.some(
      (source) =>
        isRecord(source) &&
        source.previousNode === parentName &&
        source.previousNodeRun === parentRunIndex,
    );
  });
}

interface EffectiveModelInput {
  content: string;
  evidencePath: string;
  model?: string;
  temperature?: number;
}

function effectiveModelInput(
  run: unknown,
  modelName: string,
  modelRunIndex: number,
): EffectiveModelInput | undefined {
  if (!isRecord(run) || !isRecord(run.inputOverride)) return undefined;
  const languageModel = run.inputOverride.ai_languageModel;
  if (
    !Array.isArray(languageModel) ||
    !Array.isArray(languageModel[0]) ||
    !isRecord(languageModel[0][0]) ||
    !isRecord(languageModel[0][0].json)
  ) {
    return undefined;
  }
  const payload = languageModel[0][0].json;
  if (
    !Array.isArray(payload.messages) ||
    payload.messages.length !== 1 ||
    typeof payload.messages[0] !== "string" ||
    !payload.messages[0].startsWith("Human: ")
  ) {
    return undefined;
  }
  const options = isRecord(payload.options) ? payload.options : undefined;
  return {
    content: payload.messages[0].slice("Human: ".length),
    evidencePath:
      `data.resultData.runData[${JSON.stringify(modelName)}]` +
      `[${modelRunIndex}].inputOverride.ai_languageModel[0][0].json.messages[0]`,
    ...(typeof options?.model === "string" ? { model: options.model } : {}),
    ...(typeof options?.temperature === "number"
      ? { temperature: options.temperature }
      : {}),
  };
}

const basicLlmChainExtractor: N8nPromptExtractor = {
  id: "basic-llm-chain-1-9",

  recognizes(node) {
    return node.type === BASIC_LLM_CHAIN_TYPE;
  },

  supports(node) {
    return node.typeVersion === BASIC_LLM_CHAIN_VERSION;
  },

  async extract(context, node) {
    const authored = authoredField(node);
    if (!authored || node.parameters.promptType !== "define") {
      return [
        {
          status: "unsupported",
          invocation: invocationFor(node),
          code: "unsupported-node-configuration",
          message:
            'Basic LLM Chain import currently requires promptType "define" and a text parameter.',
        },
      ];
    }

    const allRunData = runData(context.execution);
    const parentRuns = allRunData?.[node.name];
    if (!Array.isArray(parentRuns) || parentRuns.length === 0) {
      return [
        await authoredOnlyCandidate(
          context,
          node,
          authored,
          "execution-detail-unavailable",
          "No saved run data was available for this node, so only its authored prompt can be reviewed.",
        ),
      ];
    }
    if (parentRuns.length !== 1) {
      return [
        await authoredOnlyCandidate(
          context,
          node,
          authored,
          "multiple-node-runs",
          `This node ran ${parentRuns.length} times. The initial importer cannot safely associate repeated runs with model evidence.`,
        ),
      ];
    }

    const parentRunIndex = 0;
    const items = parentItemCount(parentRuns[parentRunIndex]);
    if (items !== 1) {
      return [
        await authoredOnlyCandidate(
          context,
          node,
          authored,
          items === undefined
            ? "execution-detail-unavailable"
            : "multiple-input-items",
          items === undefined
            ? "The saved parent run did not contain a supported item shape, so only the authored prompt can be reviewed."
            : `This node processed ${items} items. n8n's saved model sub-runs do not identify item indexes, so the initial importer will not guess their association.`,
          parentRunIndex,
        ),
      ];
    }

    const connectedModels = connectedModelNodes(context.workflow, node);
    if (connectedModels.length !== 1) {
      return [
        await authoredOnlyCandidate(
          context,
          node,
          authored,
          "model-connection-ambiguous",
          `Expected one connected chat model but found ${connectedModels.length}.`,
          parentRunIndex,
        ),
      ];
    }
    const modelNode = connectedModels[0]!;
    if (
      modelNode.type !== OPENAI_CHAT_MODEL_TYPE ||
      modelNode.typeVersion !== OPENAI_CHAT_MODEL_VERSION
    ) {
      return [
        await authoredOnlyCandidate(
          context,
          node,
          authored,
          "unsupported-model-node",
          `The initial Basic LLM Chain importer supports only ${OPENAI_CHAT_MODEL_TYPE}@${OPENAI_CHAT_MODEL_VERSION}.`,
          parentRunIndex,
        ),
      ];
    }

    const allModelRuns = Array.isArray(allRunData?.[modelNode.name])
      ? allRunData![modelNode.name] as unknown[]
      : [];
    const matchingRuns = modelRunsForParent(
      allModelRuns,
      node.name,
      parentRunIndex,
    );
    if (matchingRuns.length !== 1) {
      return [
        await authoredOnlyCandidate(
          context,
          node,
          authored,
          "model-evidence-ambiguous",
          `Expected one attributable saved model sub-run but found ${matchingRuns.length}.`,
          parentRunIndex,
        ),
      ];
    }
    const modelRunIndex = allModelRuns.indexOf(matchingRuns[0]);
    const effective = effectiveModelInput(
      matchingRuns[0],
      modelNode.name,
      modelRunIndex,
    );
    if (!effective) {
      return [
        await authoredOnlyCandidate(
          context,
          node,
          authored,
          "model-evidence-incompatible",
          "The saved model sub-run did not contain the supported single Human message shape.",
          parentRunIndex,
        ),
      ];
    }

    const resolved: ResolvedPromptSnapshot = {
      messages: [{ role: "user", content: effective.content }],
      ...(effective.model ? { model: effective.model } : {}),
      ...(effective.temperature === undefined
        ? {}
        : { options: { temperature: effective.temperature } }),
    };
    const binding: ExpressionBinding | undefined =
      authored.syntax === "external-expression"
        ? {
            authoredPath: authored.path,
            expression: authored.text,
            source: { kind: "whole-field" },
            resolvedValue: effective.content,
            status: "resolved",
            valueEvidence: {
              kind: "saved-parameter-value",
              path: effective.evidencePath,
            },
          }
        : undefined;
    const warnings: ImportWarning[] = [
      warning(
        "provider-request-unavailable",
        "n8n saved the effective model message but not a raw provider request, so this prompt is reconstructed from execution evidence.",
        "info",
      ),
    ];
    if (authored.syntax === "external-expression") {
      warnings.push(
        warning(
          "whole-field-binding",
          "Individual n8n expression results are not attributable in the saved execution; the complete evaluated field is preserved as one opaque value.",
          "info",
        ),
      );
    }
    return [
      {
        status: "candidate",
        candidate: await createExternalPromptCandidate(
          sourceEvidence(context, node, authored, warnings, {
            runIndex: parentRunIndex,
            itemIndex: 0,
            resolved,
            ...(binding ? { binding } : {}),
          }),
        ),
      },
    ];
  },
};

export const defaultN8nPromptExtractors: readonly N8nPromptExtractor[] = [
  basicLlmChainExtractor,
];

export async function extractN8nPromptCandidates(
  execution: N8nExecutionDetail,
  currentWorkflow?: N8nWorkflowDetail,
  extractors: readonly N8nPromptExtractor[] = defaultN8nPromptExtractors,
): Promise<N8nPromptExtraction[]> {
  const fromExecution = executionWorkflowSnapshot(execution);
  const selectedWorkflow =
    fromExecution ??
    (currentWorkflow ? currentWorkflowSnapshot(currentWorkflow) : undefined);
  if (!selectedWorkflow) return [];
  // The top-level public API field was already checked against the user's
  // selected workflow. Treat it as authoritative over the observed nested
  // execution snapshot.
  const workflow = {
    ...selectedWorkflow,
    id: execution.workflowId,
  };

  const context: N8nExtractionContext = {
    workflow,
    execution,
    workflowSnapshotSource: fromExecution ? "execution" : "current-workflow",
  };
  const results: N8nPromptExtraction[] = [];
  for (const node of workflow.nodes) {
    const extractor = extractors.find((candidate) =>
      candidate.recognizes(node),
    );
    if (!extractor) continue;
    if (!extractor.supports(node)) {
      results.push({
        status: "unsupported",
        invocation: invocationFor(node),
        code: "unsupported-node-version",
        message: `${node.type}@${node.typeVersion ?? "unknown"} is recognized, but this importer supports only a fixture-verified node version.`,
      });
      continue;
    }
    results.push(...(await extractor.extract(context, node)));
  }
  return results;
}
