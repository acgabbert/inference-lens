import { z } from "zod";
import {
  parseProjectFile,
  ProjectValidationError,
  sensitiveFieldPaths,
  serializeProjectFile,
} from "./project.ts";
import type {
  ChatPromptTemplate,
  DecisionPromptTemplate,
  ProjectFileV15,
} from "./project.ts";

/**
 * Staged format: the application and CLI still use ProjectFileV15. Version 16
 * is reserved for the active format that adds prompt environments
 * (docs/PROMPT_ENVIRONMENTS_PLAN.md); this format carries them once it lands.
 */
export const SHARED_PROJECT_SCHEMA_VERSION = 17;

export type SharedPromptTemplate =
  | Omit<ChatPromptTemplate, "draft">
  | Omit<DecisionPromptTemplate, "draft">;

export interface SharedProjectFileV17 extends Omit<ProjectFileV15, "schemaVersion" | "promptTemplates"> {
  schemaVersion: 17;
  promptTemplates: SharedPromptTemplate[];
}

const versionGate = z.object({ schemaVersion: z.literal(SHARED_PROJECT_SCHEMA_VERSION) }).passthrough();

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/**
 * Strict v17 only. Reuse v15's unchanged saved-content and reference validation
 * after fencing out drafts. This is not a public v17-to-v15 export operation.
 * Legacy input must go through the migration planner so drafts cannot be lost.
 */
export function parseSharedProjectFile(value: unknown): SharedProjectFileV17 {
  const gated = versionGate.safeParse(value);
  if (!gated.success) throw new ProjectValidationError(gated.error.issues);
  const issues: z.core.$ZodIssue[] = [];
  const templates = gated.data.promptTemplates;
  if (Array.isArray(templates)) {
    templates.forEach((template: unknown, index) => {
      if (record(template) && "draft" in record(template)!) {
        issues.push({
          code: "custom", path: ["promptTemplates", index, "draft"],
          message: "Personal prompt drafts are not shared Project v17 fields.",
        });
      }
    });
  }
  // v15 checks these provider options but stops at arrays; v17 does not.
  const providerOptions: Array<[unknown, Array<string | number>]> = [
    [record(record(record(gated.data.defaults)?.options))?.providerOptions, ["defaults", "options", "providerOptions"]],
  ];
  if (Array.isArray(gated.data.tools)) {
    gated.data.tools.forEach((tool: unknown, index) => providerOptions.push([record(tool)?.providerOptions, ["tools", index, "providerOptions"]]));
  }
  for (const [options, path] of providerOptions) {
    for (const secretPath of sensitiveFieldPaths(options, path)) {
      issues.push({ code: "custom", path: secretPath, message: "Secret-bearing fields are not portable project data." });
    }
  }
  if (issues.length) throw new ProjectValidationError(issues);
  const parsed = parseProjectFile({ ...gated.data, schemaVersion: 15 });
  return structuredClone({ ...parsed, schemaVersion: SHARED_PROJECT_SCHEMA_VERSION });
}

export function parseSharedProjectJson(text: string): SharedProjectFileV17 {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProjectValidationError([{ code: "custom", path: [], message: "File is not valid JSON." }]);
  }
  return parseSharedProjectFile(value);
}

export function serializeSharedProjectFile(project: SharedProjectFileV17): string {
  const validated = parseSharedProjectFile(project);
  // Preserve the existing deterministic field order and authored subtrees.
  const ordered = JSON.parse(serializeProjectFile({ ...validated, schemaVersion: 15 }));
  ordered.schemaVersion = SHARED_PROJECT_SCHEMA_VERSION;
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
