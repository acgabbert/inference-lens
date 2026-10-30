import { readFileSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type {
  SourceFileReadResult,
  SourceFileReference,
  SourceRootFileListResponse,
} from "../../../packages/contracts/src/source-roots.ts";
import { decodePromptFile } from "../../../packages/core/src/file-prompt-import.ts";
import {
  parseSourceRootCatalog,
  SourceRootCatalogError,
  sourceFilePathProblem,
} from "../../../packages/core/src/source-root-rules.ts";
import { WorkbenchRequestError } from "./request-security.ts";

/**
 * The operator's declaration of which folders linked prompts may be read
 * from. Unset, no folder is readable, so the container's default posture is
 * that linked sources do not exist.
 */
export const SOURCE_ROOTS_VARIABLE = "INFERENCE_LENS_SOURCE_ROOTS";

/** Prompt files are small; anything larger is refused rather than truncated. */
export const SOURCE_FILE_MAX_BYTES = 1_048_576;
export const SOURCE_FILE_READ_BATCH_LIMIT = 200;
const LISTING_MAX_FILES = 5_000;
const LISTING_MAX_DEPTH = 16;

export interface ResolvedSourceRoot {
  name: string;
  label?: string;
  /** Absolute host path. Never sent to a page. */
  path: string;
}

export interface SourceRootCatalogSource {
  available: boolean;
  /** Set only when a catalog was configured and could not be used. */
  problem?: string;
  /** Empty whenever `available` is false. */
  roots: ResolvedSourceRoot[];
}

/**
 * Read per call, like the command tool catalog: removing a root is revoking a
 * permission, and it must not wait for a restart.
 */
export function readSourceRootCatalog(
  environment: Record<string, string | undefined> = process.env,
): SourceRootCatalogSource {
  const catalogPath = environment[SOURCE_ROOTS_VARIABLE]?.trim();
  if (!catalogPath) return { available: false, roots: [] };
  let contents: string;
  try {
    contents = readFileSync(catalogPath, "utf8");
  } catch (error) {
    return {
      available: false,
      roots: [],
      problem: `${SOURCE_ROOTS_VARIABLE} names a catalog that could not be read: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    };
  }
  try {
    const catalog = parseSourceRootCatalog(JSON.parse(contents));
    const base = dirname(resolve(catalogPath));
    return {
      available: true,
      roots: catalog.roots.map(({ name, label, path }) => ({
        name,
        ...(label ? { label } : {}),
        // Relative to the catalog, which an operator moves with its folders.
        path: isAbsolute(path) ? path : resolve(base, path),
      })),
    };
  } catch (error) {
    return {
      available: false,
      roots: [],
      problem: error instanceof SourceRootCatalogError
        ? `${SOURCE_ROOTS_VARIABLE} names an invalid catalog. ${error.message}`
        : `${SOURCE_ROOTS_VARIABLE} names a file that is not JSON: ${error instanceof Error ? error.message : "unknown error"}`,
    };
  }
}

function inside(rootRealPath: string, candidate: string): boolean {
  const offset = relative(rootRealPath, candidate);
  return offset !== "" && !offset.startsWith(`..${sep}`) && offset !== ".." && !isAbsolute(offset);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}

async function rootRealPath(source: SourceRootCatalogSource, name: string): Promise<string | SourceFileReadResult> {
  const root = source.roots.find((entry) => entry.name === name);
  if (!root) return { ok: false, reason: "unknown-root", message: `This server does not declare a source folder named “${name}”.` };
  try {
    return await realpath(root.path);
  } catch {
    return { ok: false, reason: "root-unavailable", message: `The source folder “${name}” is declared but not available on this server.` };
  }
}

/**
 * Resolves the real path of the root and of the file, so a symlink inside the
 * root cannot lead out of it. Messages name the root and relative path only.
 */
async function readOne(source: SourceRootCatalogSource, { root, path }: SourceFileReference): Promise<SourceFileReadResult> {
  const pathProblem = sourceFilePathProblem(path);
  if (pathProblem) return { ok: false, reason: "invalid-path", message: pathProblem };
  const base = await rootRealPath(source, root);
  if (typeof base !== "string") return base;
  let real: string;
  try {
    real = await realpath(join(base, ...path.split("/")));
  } catch (error) {
    return errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR"
      ? { ok: false, reason: "missing", message: `${root}/${path} does not exist.` }
      : { ok: false, reason: "unreadable", message: `${root}/${path} could not be read.` };
  }
  if (!inside(base, real)) return { ok: false, reason: "outside-root", message: `${root}/${path} leads outside its source folder.` };
  try {
    const info = await stat(real);
    if (!info.isFile()) return { ok: false, reason: "not-a-file", message: `${root}/${path} is not a file.` };
    if (info.size > SOURCE_FILE_MAX_BYTES) {
      return { ok: false, reason: "too-large", message: `${root}/${path} is larger than ${SOURCE_FILE_MAX_BYTES / 1_048_576} MiB.` };
    }
    const bytes = await readFile(real);
    try {
      return { ok: true, text: decodePromptFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer) };
    } catch {
      return { ok: false, reason: "not-utf8", message: `${root}/${path} is not UTF-8 text.` };
    }
  } catch {
    return { ok: false, reason: "unreadable", message: `${root}/${path} could not be read.` };
  }
}

export async function readSourceRootFiles(
  source: SourceRootCatalogSource,
  files: readonly SourceFileReference[],
): Promise<SourceFileReadResult[]> {
  return Promise.all(files.map((file) => readOne(source, file)));
}

export function resolveSourceFileReadRequest(value: unknown): { files: SourceFileReference[] } {
  const files = typeof value === "object" && value !== null && "files" in value ? value.files : undefined;
  if (!Array.isArray(files) || files.some((file) =>
    typeof file !== "object" || file === null ||
    typeof (file as SourceFileReference).root !== "string" || typeof (file as SourceFileReference).path !== "string")) {
    throw new WorkbenchRequestError("Expected { files: [{ root, path }] }.", 400);
  }
  if (files.length > SOURCE_FILE_READ_BATCH_LIMIT) {
    throw new WorkbenchRequestError(`Read at most ${SOURCE_FILE_READ_BATCH_LIMIT} source files at once.`, 400);
  }
  return { files: files.map(({ root, path }: SourceFileReference) => ({ root, path })) };
}

/**
 * The `.md` and `.txt` files a link may name, without following directory
 * symlinks (which could loop) or offering hidden entries or anything outside.
 */
export async function listSourceRootFiles(
  source: SourceRootCatalogSource,
  rootName: string,
  { maxFiles = LISTING_MAX_FILES }: { maxFiles?: number } = {},
): Promise<SourceRootFileListResponse> {
  const base = await rootRealPath(source, rootName);
  if (typeof base !== "string") throw new WorkbenchRequestError(base.ok ? "" : base.message, 404);
  const files: string[] = [];
  async function walk(directory: string, prefix: string, depth: number): Promise<void> {
    if (depth > LISTING_MAX_DEPTH) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, relativePath, depth + 1);
      } else if ((entry.isFile() || entry.isSymbolicLink()) && !sourceFilePathProblem(relativePath)) {
        if (entry.isSymbolicLink()) {
          try {
            const real = await realpath(absolute);
            if (!inside(base as string, real) || !(await stat(real)).isFile()) continue;
          } catch {
            continue;
          }
        }
        files.push(relativePath);
      }
    }
  }
  await walk(base, "", 0);
  files.sort();
  return { files: files.slice(0, maxFiles), truncated: files.length > maxFiles };
}
