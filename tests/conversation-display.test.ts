import assert from "node:assert/strict";
import test from "node:test";

import { conversationMessageText } from "../app/conversation-display.ts";

test("converts structured message content into renderable transcript text", () => {
  assert.equal(
    conversationMessageText({
      id: "message_preview",
      role: "user",
      content: [
        { type: "text", text: "Classify " },
        { type: "text", text: "this request." },
      ],
    }),
    "Classify this request.",
  );
});
