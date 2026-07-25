import assert from "node:assert/strict";
import test from "node:test";

import { removeDraftMessage } from "../app/use-request-draft.client.ts";
import { createEntityId } from "../packages/core/src/run-kernel/types.ts";
import type {
  AssistantMessage,
  ConversationMessage,
  ToolMessage,
} from "../packages/core/src/run-kernel/types.ts";

test("deleting an assistant message also removes its dependent tool results", () => {
  const messages: ConversationMessage[] = [
    {
      id: createEntityId("message", "assistant"),
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "" }],
      toolCalls: [
        {
          id: createEntityId("tool-call", "lookup"),
          name: "lookup",
          arguments: { text: "{}" },
        },
      ],
    },
    {
      id: createEntityId("message", "tool"),
      role: "tool" as const,
      toolCallId: createEntityId("tool-call", "lookup"),
      content: [{ type: "text" as const, text: "result" }],
    },
    {
      id: createEntityId("message", "user"),
      role: "user" as const,
      content: [{ type: "text" as const, text: "next" }],
    },
  ];

  assert.deepEqual(
    removeDraftMessage(messages, "message_assistant"),
    [messages[2]],
  );
});

test("deleting a tool result removes its matching assistant tool call", () => {
  const assistant: AssistantMessage = {
    id: createEntityId("message", "assistant"),
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "" }],
    toolCalls: [
      {
        id: createEntityId("tool-call", "lookup"),
        name: "lookup",
        arguments: { text: "{}" },
      },
    ],
  };
  const tool: ToolMessage = {
    id: createEntityId("message", "tool"),
    role: "tool" as const,
    toolCallId: createEntityId("tool-call", "lookup"),
    content: [{ type: "text" as const, text: "result" }],
  };

  assert.deepEqual(removeDraftMessage([assistant, tool], tool.id), [
    { id: assistant.id, role: "assistant", content: assistant.content },
  ]);
});
