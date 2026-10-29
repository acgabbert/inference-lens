"use client";

import type { PromptTemplateMessage } from "../../packages/core/src/project";

/** A prompt revision's messages, filling the dialog column it sits in. */
export function PromptMessagesPreview({ messages }: { messages: readonly PromptTemplateMessage[] }) {
  return (
    <div className="prompt-messages-preview wide-dialog-fill">
      <span className="eyebrow">Preview</span>
      {messages.map((message, index) => (
        <article key={`${message.role}-${index}`}>
          <strong>{message.role}</strong>
          <pre>{message.content}</pre>
        </article>
      ))}
    </div>
  );
}
