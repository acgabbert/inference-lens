import { createEntityId } from "./types.ts";
import type {
  ConversationMessage,
  RunState,
  ToolCall,
} from "./types.ts";

function textContent(text: string) {
  return text ? [{ type: "text" as const, text }] : [];
}

/**
 * Projects the effective, provider-neutral transcript of a run. The result is
 * derived entirely from durable run state, so imported traces produce the same
 * message IDs and content as their live counterparts.
 */
export function transcriptFromRunState(state: RunState): ConversationMessage[] {
  if (!state.input) return [];

  const suffix = state.runId.slice("run_".length);
  const transcript = [...state.input.messages];

  state.turns.forEach((turn, turnIndex) => {
    const attempt = [...turn.attempts]
      .reverse()
      .find(({ status }) => status === "completed");
    if (!attempt) return;

    const callsById = new Map<ToolCall["id"], ToolCall>(
      (attempt.completedToolCalls ?? []).map((call) => [call.id, call]),
    );
    transcript.push({
      id: createEntityId("message", `${suffix}-t${turnIndex + 1}-assistant`),
      role: "assistant",
      content: textContent(attempt.text),
      ...(attempt.completedToolCalls?.length
        ? { toolCalls: attempt.completedToolCalls }
        : {}),
    });

    state.toolResults
      .filter((result) => callsById.has(result.toolCallId))
      .forEach((result, resultIndex) => {
        transcript.push({
          id: createEntityId(
            "message",
            `${suffix}-t${turnIndex + 1}-r${resultIndex + 1}`,
          ),
          role: "tool",
          toolCallId: result.toolCallId,
          name: callsById.get(result.toolCallId)?.name,
          content: result.content,
        });
      });
  });

  return transcript;
}
