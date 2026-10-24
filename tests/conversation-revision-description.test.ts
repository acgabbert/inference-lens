import assert from "node:assert/strict";
import test from "node:test";

import {
  describeConversationRevision,
  REVISION_SUMMARY_LENGTH,
} from "../packages/core/src/conversation-revision-description.ts";
import { createProjectFile } from "../packages/core/src/project.ts";

function summaryOf(text: string): string {
  const project = createProjectFile({
    name: "Summary fixture",
    idSuffix: "summary",
    createdAt: "2026-10-24T12:00:00.000Z",
    request: {
      provider: "openai-compatible",
      endpoint: "https://provider.example.test/v1",
      model: "fixture-model",
      messages: [{ role: "user", content: text }],
    },
  });
  return describeConversationRevision(project, project.conversationRevisions[0]!).summary;
}

/** The whole-text collapse the summary is defined by. */
function expectedSummary(text: string): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  return collapsed.length > REVISION_SUMMARY_LENGTH
    ? `${collapsed.slice(0, REVISION_SUMMARY_LENGTH - 1).trimEnd()}…`
    : collapsed;
}

test("a revision summary collapses whitespace and shortens to its limit", () => {
  const word = "lorem ";
  const cases = [
    "",
    "   ",
    "Short prompt",
    "  leading\n\tand trailing  \n",
    "x".repeat(REVISION_SUMMARY_LENGTH),
    "x".repeat(REVISION_SUMMARY_LENGTH + 1),
    `${"x".repeat(REVISION_SUMMARY_LENGTH)}   `,
    `${"x".repeat(REVISION_SUMMARY_LENGTH - 1)} y`,
    `${"x".repeat(REVISION_SUMMARY_LENGTH - 2)}\n\n\nyz`,
    `${" ".repeat(50_000)}after a long run of spaces`,
    `one${"  ".repeat(40)}two`,
    "y".repeat(300_000),
    word.repeat(60_000),
  ];
  for (const text of cases) {
    assert.equal(summaryOf(text), expectedSummary(text), JSON.stringify(text.slice(0, 40)));
  }
});
