import { z } from "zod";
import {
  parseProjectFile,
  ProjectValidationError,
  serializeProjectFile,
} from "./project.ts";
import type {
  ChatPromptTemplate,
  DecisionPromptTemplate,
  ProjectFileV15,
} from "./project.ts";

/** Staged format: the application and CLI still use ProjectFileV15. */
export const SHARED_PROJECT_SCHEMA_VERSION = 16;

export type SharedPromptTemplate =
  | Omit<ChatPromptTemplate, "draft">
  | Omit<DecisionPromptTemplate, "draft">;

export interface SharedProjectFileV16 extends Omit<ProjectFileV15, "schemaVersion" | "promptTemplates"> {
  schemaVersion: 16;
  promptTemplates: SharedPromptTemplate[];
}

const versionGate = z.object({ schemaVersion: z.literal(SHARED_PROJECT_SCHEMA_VERSION) }).passthrough();

/**
 * Strict v16 only. Reuse v15's unchanged saved-content and reference validation
 * after fencing out drafts. This is not a public v16-to-v15 export operation.
 * Legacy input must go through the migration planner so drafts cannot be lost.
 */
export function parseSharedProjectFile(value: unknown): SharedProjectFileV16 {
  const gated = versionGate.safeParse(value);
  if (!gated.success) throw new ProjectValidationError(gated.error.issues);
  const templates = gated.data.promptTemplates;
  if (Array.isArray(templates)) {
    const issues: z.core.$ZodIssue[] = [];
    templates.forEach((template: unknown, index) => {
      if (typeof template === "object" && template !== null && "draft" in template) {
        issues.push({
          code: "custom", path: ["promptTemplates", index, "draft"],
          message: "Personal prompt drafts are not shared Project v16 fields.",
        });
      }
    });
    if (issues.length) throw new ProjectValidationError(issues);
  }
  const parsed = parseProjectFile({ ...gated.data, schemaVersion: 15 });
  return structuredClone({ ...parsed, schemaVersion: SHARED_PROJECT_SCHEMA_VERSION });
}

export function parseSharedProjectJson(text: string): SharedProjectFileV16 {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProjectValidationError([{ code: "custom", path: [], message: "File is not valid JSON." }]);
  }
  return parseSharedProjectFile(value);
}

export function serializeSharedProjectFile(project: SharedProjectFileV16): string {
  const validated = parseSharedProjectFile(project);
  // Preserve the existing deterministic field order and authored subtrees.
  const ordered = JSON.parse(serializeProjectFile({ ...validated, schemaVersion: 15 }));
  ordered.schemaVersion = SHARED_PROJECT_SCHEMA_VERSION;
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
