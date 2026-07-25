import type {
  ConversationMessage,
  ExchangeId,
  ProviderTurnInput,
  ResolvedRunInput,
  RunConversationIdentity,
  RunId,
  ToolDefinition,
  TurnId,
} from "./types.ts";
import { createEntityId } from "./types.ts";
import {
  resolveProviderCapabilities,
} from "../types.ts";
import type { InferenceRequest, RichInferenceRequest } from "../types.ts";

export interface SingleTurnRunExecution {
  runId: RunId;
  turnId: TurnId;
  exchangeId: ExchangeId;
  attempt: 1;
  input: ResolvedRunInput;
  turnInput: ProviderTurnInput;
}

export function createSingleTurnRunExecution(
  request: InferenceRequest | RichInferenceRequest,
  identity: RunConversationIdentity,
  suffix: string = crypto.randomUUID(),
  resolvedAt: string = new Date().toISOString(),
  tools: ToolDefinition[] = [],
): SingleTurnRunExecution {
  const runId = createEntityId("run", suffix);
  const turnId = createEntityId("turn", `${suffix}-1`);
  const exchangeId = createEntityId("exchange", `${suffix}-1`);
  const messages: ConversationMessage[] = request.messages.map(
    (message, index) => {
      if ("id" in message) return message;
      const base = {
        id: createEntityId("message", `${suffix}-${index}`),
        content: [{ type: "text" as const, text: message.content }],
      };
      switch (message.role) {
        case "system":
          return { ...base, role: "system" };
        case "user":
          return { ...base, role: "user" };
        case "assistant":
          return { ...base, role: "assistant" };
        case "tool":
          return {
            ...base,
            role: "tool",
            toolCallId: createEntityId(
              "tool-call",
              `${suffix}-imported-${index}`,
            ),
          };
      }
    },
  );
  const turnInput: ProviderTurnInput = {
    target: {
      profileId: createEntityId("profile", "openai-compatible"),
      protocol: "openai-compatible-chat-completions",
      endpoint: request.endpoint,
      model: request.model,
      capabilities:
        request.capabilities ?? resolveProviderCapabilities(request.provider),
    },
    messages,
    options:
      request.temperature === undefined
        ? {}
        : { temperature: request.temperature },
    tools,
  };

  return {
    runId,
    turnId,
    exchangeId,
    attempt: 1,
    turnInput,
    input: {
      runId,
      ...identity,
      ...turnInput,
      resolvedAt,
    },
  };
}

export function createResolvedRunInput(
  request: InferenceRequest | RichInferenceRequest,
  identity: RunConversationIdentity,
  tools: ToolDefinition[] = [],
  suffix: string = crypto.randomUUID(),
  resolvedAt: string = new Date().toISOString(),
): ResolvedRunInput {
  return createSingleTurnRunExecution(
    request,
    identity,
    suffix,
    resolvedAt,
    tools,
  ).input;
}
