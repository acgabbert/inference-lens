/**
 * Linked prompt source folders (docs/SHARED_ASSETS_PERSONAL_WORKBENCH_PLAN.md,
 * E3). A page learns root names and labels, never host paths.
 */

export const SOURCE_ROOTS_API_PATH = "/api/source-roots";
export const SOURCE_ROOT_FILES_API_PATH = "/api/source-roots/files";
export const SOURCE_ROOT_READ_API_PATH = "/api/source-roots/read";

export interface SourceRootSummary {
  name: string;
  label?: string;
}

export interface SourceRootCatalogResponse {
  /** False when no catalog is configured, or when the configured one is unusable. */
  available: boolean;
  /** Set only when a catalog was configured and could not be used. */
  problem?: string;
  /** Named so the UI can tell an operator exactly what to set. */
  configurationVariable: string;
  roots: SourceRootSummary[];
}

export interface SourceRootFileListResponse {
  /** `.md` and `.txt` paths relative to the root, sorted. */
  files: string[];
  /** True when the listing stopped at its limit. */
  truncated: boolean;
}

export interface SourceFileReference {
  root: string;
  path: string;
}

export interface SourceFileReadRequest {
  files: SourceFileReference[];
}

export type SourceFileProblem =
  | "unknown-root"
  | "root-unavailable"
  | "invalid-path"
  | "missing"
  | "outside-root"
  | "not-a-file"
  | "too-large"
  | "not-utf8"
  | "unreadable";

export type SourceFileReadResult =
  | { ok: true; text: string }
  | { ok: false; reason: SourceFileProblem; message: string };

export interface SourceFileReadResponse {
  /** One per requested file, in request order. */
  results: SourceFileReadResult[];
}
