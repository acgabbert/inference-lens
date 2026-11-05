import { z } from "zod";
import {
  parseProjectFile,
  PROJECT_SCHEMA_VERSION,
  ProjectValidationError,
  sensitiveFieldPaths,
  serializeProjectFile,
} from "./project.ts";
import type {
  ChatPromptTemplate,
  DecisionPromptTemplate,
  ProjectFile,
  ProjectFileV18,
} from "./project.ts";

/**
 * Staged format: the application and CLI use the active ProjectFileV18, which
 * carries prompt environments (v16, docs/PROMPT_ENVIRONMENTS_PLAN.md),
 * whole-file prompt imports (v17) and linked prompt sources (v18). This format
 * derives from it and carries all three.
 */
export const SHARED_PROJECT_SCHEMA_VERSION = 19;

export type SharedPromptTemplate =
  | Omit<ChatPromptTemplate, "draft">
  | Omit<DecisionPromptTemplate, "draft">;

export interface SharedProjectFileV19 extends Omit<ProjectFileV18, "schemaVersion" | "promptTemplates"> {
  schemaVersion: 19;
  promptTemplates: SharedPromptTemplate[];
}

const versionGate = z.object({ schemaVersion: z.literal(SHARED_PROJECT_SCHEMA_VERSION) }).passthrough();

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/**
 * Strict v19 only. Reuse v18's unchanged saved-content and reference validation
 * after fencing out drafts. This is not a public v19-to-v18 export operation.
 * Legacy input must go through the migration planner so drafts cannot be lost.
 */
export function parseSharedProjectFile(value: unknown): SharedProjectFileV19 {
  const gated = versionGate.safeParse(value);
  if (!gated.success) throw new ProjectValidationError(gated.error.issues);
  const issues: z.core.$ZodIssue[] = [];
  const templates = gated.data.promptTemplates;
  if (Array.isArray(templates)) {
    templates.forEach((template: unknown, index) => {
      if (record(template) && "draft" in record(template)!) {
        issues.push({
          code: "custom", path: ["promptTemplates", index, "draft"],
          message: "Personal prompt drafts are not shared Project v19 fields.",
        });
      }
    });
  }
  // v18 checks these provider options but stops at arrays; v19 does not.
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
  const parsed = parseProjectFile({ ...gated.data, schemaVersion: 18 });
  return structuredClone({ ...parsed, schemaVersion: SHARED_PROJECT_SCHEMA_VERSION });
}

export function parseSharedProjectJson(text: string): SharedProjectFileV19 {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProjectValidationError([{ code: "custom", path: [], message: "File is not valid JSON." }]);
  }
  return parseSharedProjectFile(value);
}

export function serializeSharedProjectFile(project: SharedProjectFileV19): string {
  const validated = parseSharedProjectFile(project);
  // Preserve the existing deterministic field order and authored subtrees.
  const ordered = JSON.parse(serializeProjectFile({ ...validated, schemaVersion: 18 }));
  ordered.schemaVersion = SHARED_PROJECT_SCHEMA_VERSION;
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * A v19 document as the active in-memory `ProjectFile` (I1). The content is
 * unchanged: only the version label moves, and v19 carries no template draft.
 * The app's manifest boundary and the CLI, which reads and never writes, share
 * it.
 */
export function sharedProjectAsActive(shared: SharedProjectFileV19): ProjectFile {
  return { ...shared, schemaVersion: PROJECT_SCHEMA_VERSION } as unknown as ProjectFile;
}

/** The `schemaVersion` a document declares, before any codec reads it. */
export function declaredProjectSchemaVersion(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && "schemaVersion" in value ? value.schemaVersion : undefined;
  } catch {
    return undefined;
  }
}
