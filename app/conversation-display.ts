import type { ConversationMessage } from "../packages/core/src/run-kernel";

/** Returns the human-readable text from the structured message contract. */
export function conversationMessageText(message: ConversationMessage): string {
  return message.content.map(({ text }) => text).join("");
}
