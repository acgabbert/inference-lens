import assert from "node:assert/strict";
import type { ProjectDecisionRequestRevision, PromptTemplate } from "../packages/core/src/project.ts";

export function inlineRevision(revision: ProjectDecisionRequestRevision | undefined) {
  assert.ok(revision?.kind === "inline", "Expected an inline request revision");
  return revision;
}
export function chatTemplate(template: PromptTemplate | undefined) {
  assert.ok(template?.kind === "chat", "Expected a chat template");
  return template;
}

/** A historical fixture must omit the discriminators introduced in schema v15. */
export function legacyContent(project: import("../packages/core/src/project.ts").ProjectFile) {
  const omitKind = (entry: object) => Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "kind"));
  return { ...project,
    promptTemplates: project.promptTemplates.map(omitKind),
    decisionRequestRevisions: project.decisionRequestRevisions.map(omitKind),
  };
}
