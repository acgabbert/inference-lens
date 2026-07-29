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

/**
 * A node that could not be read as a full snapshot but still carries enough
 * identity to be reported to the user.
 */
export interface N8nUnparsedNode {
  id: string;
  name: string;
  type: string;
}

export interface N8nWorkflowSnapshot {
  id: string;
  name: string;
  nodes: N8nNodeSnapshot[];
  /**
   * Nodes skipped by {@link parseN8nWorkflowSnapshot}. A workflow may legally
   * contain nodes this importer cannot read; those must not make the rest of
   * the workflow unimportable.
   */
  unparsedNodes: N8nUnparsedNode[];
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
  /**
   * Whether this extractor handles the node's kind at all. Implementations must
   * depend only on `node.type`, so recognition can also be tested against a
   * node whose parameters could not be read.
   */
  recognizes(node: N8nNodeSnapshot): boolean;
  /**
   * Whether this extractor handles the node's specific `typeVersion`. Several
   * extractors may recognize one type while each supports a different version.
   */
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

function parseUnparsedNode(value: unknown): N8nUnparsedNode | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.type !== "string" ||
    !value.id ||
    !value.name ||
    !value.type
  ) {
    return undefined;
  }
  return { id: value.id, name: value.name, type: value.type };
}

/**
 * Reads the workflow envelope. An unreadable envelope is a genuine
 * incompatibility, but an individual unreadable node is not: workflows mix node
 * types freely and only the ones an extractor recognizes are ever inspected.
 * Unreadable nodes are therefore collected rather than failing the workflow.
 */
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
  const nodes: N8nNodeSnapshot[] = [];
  const unparsedNodes: N8nUnparsedNode[] = [];
  for (const entry of value.nodes) {
    const node = parseNode(entry);
    if (node) {
      nodes.push(node);
      continue;
    }
    const identity = parseUnparsedNode(entry);
    if (identity) unparsedNodes.push(identity);
  }
  return {
    id: value.id,
    name: value.name,
    nodes,
    unparsedNodes,
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
  const externalExpression = text.startsWith("=");
  return {
    path: AUTHORED_TEXT_PATH,
    role: "user",
    syntax: externalExpression ? "external-expression" : "literal",
    text,
    ...(externalExpression
      ? {
          contentSpan: {
            startOffset: 1,
            endOffset: text.length,
          },
        }
      : {}),
  };
}

type ExpressionScanMode =
  | { kind: "code"; braceDepth: number; templateExpression: boolean }
  | { kind: "single-quote" | "double-quote" | "template" }
  | { kind: "line-comment" | "block-comment" };

export interface N8nExpressionRegionScan {
  bindings: ExpressionBinding[];
  invalid: boolean;
}

/**
 * Finds n8n expression regions without evaluating JavaScript. The scanner
 * understands strings, template literals, comments, and nested object braces;
 * malformed input fails closed instead of inventing a partial projection.
 */
export function scanN8nExpressionRegions(
  authored: AuthoredPromptField,
): N8nExpressionRegionScan {
  if (authored.syntax !== "external-expression") {
    return { bindings: [], invalid: false };
  }
  const contentStart = authored.contentSpan?.startOffset ?? 0;
  const contentEnd = authored.contentSpan?.endOffset ?? authored.text.length;
  const bindings: ExpressionBinding[] = [];
  let cursor = contentStart;

  while (cursor < contentEnd) {
    const startOffset = authored.text.indexOf("{{", cursor);
    if (startOffset < 0 || startOffset >= contentEnd) break;
    const modes: ExpressionScanMode[] = [
      { kind: "code", braceDepth: 0, templateExpression: false },
    ];
    let index = startOffset + 2;
    let endOffset: number | undefined;

    while (index < contentEnd) {
      const mode = modes.at(-1)!;
      const character = authored.text[index]!;
      const next = authored.text[index + 1];

      if (mode.kind === "single-quote" || mode.kind === "double-quote") {
        const quote = mode.kind === "single-quote" ? "'" : '"';
        if (character === "\\") {
          index += 2;
        } else if (character === quote) {
          modes.pop();
          index += 1;
        } else {
          index += 1;
        }
        continue;
      }

      if (mode.kind === "template") {
        if (character === "\\") {
          index += 2;
        } else if (character === "`") {
          modes.pop();
          index += 1;
        } else if (character === "$" && next === "{") {
          modes.push({
            kind: "code",
            braceDepth: 0,
            templateExpression: true,
          });
          index += 2;
        } else {
          index += 1;
        }
        continue;
      }

      if (mode.kind === "line-comment") {
        if (character === "\n" || character === "\r") modes.pop();
        index += 1;
        continue;
      }

      if (mode.kind === "block-comment") {
        if (character === "*" && next === "/") {
          modes.pop();
          index += 2;
        } else {
          index += 1;
        }
        continue;
      }

      if (mode.kind !== "code") {
        throw new Error("Unreachable n8n expression scanner mode.");
      }
      if (
        !mode.templateExpression &&
        mode.braceDepth === 0 &&
        character === "}" &&
        next === "}"
      ) {
        endOffset = index + 2;
        break;
      }
      if (character === "'") {
        modes.push({ kind: "single-quote" });
        index += 1;
      } else if (character === '"') {
        modes.push({ kind: "double-quote" });
        index += 1;
      } else if (character === "`") {
        modes.push({ kind: "template" });
        index += 1;
      } else if (character === "/" && next === "/") {
        modes.push({ kind: "line-comment" });
        index += 2;
      } else if (character === "/" && next === "*") {
        modes.push({ kind: "block-comment" });
        index += 2;
      } else if (character === "{") {
        mode.braceDepth += 1;
        index += 1;
      } else if (character === "}") {
        if (mode.braceDepth > 0) {
          mode.braceDepth -= 1;
          index += 1;
        } else if (mode.templateExpression) {
          modes.pop();
          index += 1;
        } else {
          index += 1;
        }
      } else {
        index += 1;
      }
    }

    if (endOffset === undefined) {
      return { bindings: [], invalid: true };
    }
    bindings.push({
      authoredPath: authored.path,
      expression: authored.text.slice(startOffset, endOffset),
      source: { kind: "expression-span", startOffset, endOffset },
      status: "missing",
    });
    cursor = endOffset;
  }

  return { bindings, invalid: false };
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
    bindings = [],
  }: {
    runIndex?: number;
    itemIndex?: number;
    resolved?: ResolvedPromptSnapshot;
    bindings?: ExpressionBinding[];
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
    bindings,
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
  const expressionScan = scanN8nExpressionRegions(authored);
  if (expressionScan.invalid) {
    warnings.push(
      warning(
        "invalid-expression-regions",
        "The authored n8n expression regions could not be parsed safely, so reusable template import is unavailable.",
      ),
    );
  }
  return {
    status: "candidate",
    candidate: await createExternalPromptCandidate(
      sourceEvidence(context, node, authored, warnings, {
        ...(runIndex === undefined ? {} : { runIndex }),
        bindings: expressionScan.bindings,
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
    const expressionScan = scanN8nExpressionRegions(authored);
    const semanticText = authored.text.slice(
      authored.contentSpan?.startOffset ?? 0,
      authored.contentSpan?.endOffset ?? authored.text.length,
    );
    const soleExpression = expressionScan.bindings[0];
    const bindings =
      !expressionScan.invalid &&
      expressionScan.bindings.length === 1 &&
      soleExpression &&
      semanticText.trim() === soleExpression.expression
        ? [
            {
              ...soleExpression,
              resolvedValue: effective.content,
              status: "resolved" as const,
              valueEvidence: {
                kind: "saved-parameter-value" as const,
                path: effective.evidencePath,
              },
            },
          ]
        : expressionScan.bindings;
    const warnings: ImportWarning[] = [
      warning(
        "provider-request-unavailable",
        "n8n saved the effective model message but not a raw provider request, so this prompt is reconstructed from execution evidence.",
        "info",
      ),
    ];
    if (
      authored.syntax === "external-expression" &&
      bindings.some(({ status }) => status !== "resolved")
    ) {
      warnings.push(
        warning(
          "expression-values-unavailable",
          "Individual n8n expression results are not attributable in the saved execution; unresolved regions will become native template variables without saved values.",
          "info",
        ),
      );
    }
    if (expressionScan.invalid) {
      warnings.push(
        warning(
          "invalid-expression-regions",
          "The authored n8n expression regions could not be parsed safely, so reusable template import is unavailable.",
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
            bindings,
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
    const recognized = extractors.filter((candidate) =>
      candidate.recognizes(node),
    );
    if (recognized.length === 0) continue;
    // Extractors are registered per node version, so recognition of the type
    // must not shadow a sibling extractor that supports this exact version.
    const extractor = recognized.find((candidate) => candidate.supports(node));
    if (!extractor) {
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
  for (const node of workflow.unparsedNodes) {
    // Only surface unreadable nodes an extractor would have inspected;
    // reporting every unreadable node in the workflow would be noise.
    const probe: N8nNodeSnapshot = { ...node, parameters: {} };
    if (!extractors.some((candidate) => candidate.recognizes(probe))) continue;
    results.push({
      status: "unsupported",
      invocation: { id: node.id, name: node.name, type: node.type },
      code: "incompatible-node-snapshot",
      message: `${node.type} could not be read from the saved workflow snapshot, so its prompt cannot be reviewed.`,
    });
  }
  return results;
}
