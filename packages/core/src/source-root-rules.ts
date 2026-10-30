import { z } from "zod";

/**
 * Portable rules for linked prompt sources (docs/SHARED_ASSETS_PERSONAL_WORKBENCH_PLAN.md,
 * E3). A project names a source root and a path inside it; a deployment maps
 * the name to a real folder. These rules are shared by project validation, the
 * operator catalog and the service's confined reads, so they import nothing
 * from the project codec.
 */

export const SOURCE_ROOT_CATALOG_SCHEMA_VERSION = 1;
export const SOURCE_FILE_MAX_PATH_LENGTH = 1024;

const sourceRootNamePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function sourceRootNameProblem(name: string): string | undefined {
  return sourceRootNamePattern.test(name)
    ? undefined
    : "A source root name uses lowercase letters, digits and dash, starts with a letter or digit, and has at most 63 characters.";
}

/**
 * A path relative to its root, written the same way on every host. Hidden
 * segments are refused because a listing never offers them, and `..` because
 * a project must not be able to name a file outside its root.
 */
export function sourceFilePathProblem(path: string): string | undefined {
  if (!path) return "Choose a file path.";
  if (path.length > SOURCE_FILE_MAX_PATH_LENGTH) return `A source file path has at most ${SOURCE_FILE_MAX_PATH_LENGTH} characters.`;
  if (/[\\\u0000-\u001f\u007f]/.test(path)) return "A source file path uses / between folders and has no control characters.";
  if (path.startsWith("/")) return "A source file path is relative to its source root.";
  for (const segment of path.split("/")) {
    if (segment === "") return "A source file path has no empty folder names.";
    if (segment === "." || segment === "..") return "A source file path cannot contain . or .. segments.";
    if (segment.startsWith(".")) return "A source file path cannot name hidden files or folders.";
  }
  if (!/\.(md|txt)$/i.test(path)) return "A source file is a .md or .txt file.";
  return undefined;
}

export function sourceFileBasename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export const sourceRootNameSchema = z.string().superRefine((name, context) => {
  const problem = sourceRootNameProblem(name);
  if (problem) context.addIssue({ code: "custom", message: problem });
});

export const sourceFilePathSchema = z.string().superRefine((path, context) => {
  const problem = sourceFilePathProblem(path);
  if (problem) context.addIssue({ code: "custom", message: problem });
});

export interface SourceRootDeclaration {
  name: string;
  /** Absolute, or relative to the catalog file's own directory. Never sent to a page. */
  path: string;
  label?: string;
}

export interface SourceRootCatalog {
  schemaVersion: typeof SOURCE_ROOT_CATALOG_SCHEMA_VERSION;
  roots: SourceRootDeclaration[];
}

export class SourceRootCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceRootCatalogError";
  }
}

const catalogSchema = z
  .object({
    schemaVersion: z.literal(SOURCE_ROOT_CATALOG_SCHEMA_VERSION),
    roots: z.array(z.object({
      name: sourceRootNameSchema,
      path: z.string().trim().min(1, "A source root needs a path."),
      label: z.string().trim().min(1).optional(),
    }).strict()),
  })
  .strict()
  .superRefine((catalog, context) => {
    const seen = new Set<string>();
    catalog.roots.forEach(({ name }, index) => {
      if (seen.has(name)) {
        context.addIssue({ code: "custom", path: ["roots", index, "name"], message: `Duplicate source root "${name}".` });
      }
      seen.add(name);
    });
  });

/** Throws rather than falling back to no roots, so a typo is explained, not hidden. */
export function parseSourceRootCatalog(value: unknown): SourceRootCatalog {
  const parsed = catalogSchema.safeParse(value);
  if (!parsed.success) {
    throw new SourceRootCatalogError(parsed.error.issues
      .map(({ path, message }) => (path.length ? `${path.join(".")}: ${message}` : message))
      .join("; "));
  }
  return {
    schemaVersion: SOURCE_ROOT_CATALOG_SCHEMA_VERSION,
    roots: parsed.data.roots.map(({ name, path, label }) => ({ name, path, ...(label ? { label } : {}) })),
  };
}
