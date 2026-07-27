import { createEntityId } from "../packages/core/src/run-kernel/index.ts";
import type {
  RunState,
  ToolCall,
  ToolResult,
} from "../packages/core/src/run-kernel/index.ts";
import type { ToolResultDraft } from "./tool-call-list.client";

export function isTerminalRunState(state: RunState | null): boolean {
  return Boolean(
    state && ["completed", "cancelled", "failed"].includes(state.status.kind),
  );
}

export function isRetryableTransportFailure(
  error: unknown,
  status?: number,
): boolean {
  return !(error instanceof SyntaxError) && (
    status === undefined || status === 408 || status === 429 ||
    (status >= 500 && status <= 599)
  );
}

export function pendingToolResultDrafts(
  state: RunState,
  resolveDraft: (call: ToolCall) => ToolResultDraft | undefined,
): Record<string, ToolResultDraft> {
  if (state.status.kind !== "awaiting_tool_results") return {};
  const status = state.status;
  const pending = new Set(status.pendingToolCallIds);
  const calls = state.turns.find(({ turnId }) => turnId === status.turnId)
    ?.attempts.at(-1)?.completedToolCalls ?? [];
  return Object.fromEntries(
    calls.flatMap((call) => {
      if (!pending.has(call.id)) return [];
      return [[call.id, resolveDraft(call) ?? {
        text: "", resolution: { kind: "manual" as const },
      }]];
    }),
  );
}

export function toolResultsFromDrafts(
  state: RunState,
  drafts: Record<string, ToolResultDraft>,
): ToolResult[] {
  if (state.status.kind !== "awaiting_tool_results") return [];
  const status = state.status;
  const calls = state.turns.find(({ turnId }) => turnId === status.turnId)
    ?.attempts.at(-1)?.completedToolCalls ?? [];
  const byId = new Map(calls.map((call) => [call.id, call]));
  return status.pendingToolCallIds.map((toolCallId) => {
    const draft = drafts[toolCallId];
    if (!draft) throw new Error(`Tool call ${toolCallId} has no result.`);
    return {
      id: createEntityId("tool-result", crypto.randomUUID()),
      toolCallId,
      content: [{ type: "text", text: draft.text }],
      resolution: draft.resolution,
      ...(byId.has(toolCallId) ? {} : { isError: true }),
    };
  });
}
