import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  TOOL_REGISTRY_FILE_NAME,
  ToolRegistryConflictError,
  ToolRegistryValidationError,
  emptyToolRegistry,
  parseToolRegistryFile,
  parseToolRegistryJson,
  serializeToolRegistry,
} from "../../../packages/core/src/tool-registry.ts";
import type {
  ToolRegistryRevision,
  ToolRegistrySnapshot,
  ToolRegistryStore,
  ToolRegistryV1,
} from "../../../packages/core/src/tool-registry.ts";

export interface ToolRegistryFilesystem {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, contents: string, encoding: "utf8"): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface ReplaceToolRegistryRequest {
  registry: ToolRegistryV1;
  expectedRevision: ToolRegistryRevision | null;
}

export class ToolRegistryStorageUnavailableError extends Error {
  constructor() {
    super("The shared tool registry directory is unavailable.");
    this.name = "ToolRegistryStorageUnavailableError";
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "ENOENT";
}

function revision(contents: string): ToolRegistryRevision {
  return createHash("sha256").update(contents).digest("hex");
}

/** Strictly separates bad HTTP input from storage failures. */
export function resolveReplaceToolRegistryRequest(
  value: unknown,
): ReplaceToolRegistryRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolRegistryValidationError([{ code: "custom", path: [], message: "Request must be an object." }]);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || !("registry" in record) || !("expectedRevision" in record)) {
    throw new ToolRegistryValidationError([{ code: "custom", path: [], message: "Request must contain only registry and expectedRevision." }]);
  }
  if (record.expectedRevision !== null && typeof record.expectedRevision !== "string") {
    throw new ToolRegistryValidationError([{ code: "custom", path: ["expectedRevision"], message: "Expected a revision string or null." }]);
  }
  return {
    registry: parseToolRegistryFile(record.registry),
    expectedRevision: record.expectedRevision as ToolRegistryRevision | null,
  };
}

export class FileToolRegistryStore implements ToolRegistryStore {
  private readonly path: string;
  private pending: Promise<void> = Promise.resolve();
  private readonly fs: ToolRegistryFilesystem;

  constructor(directory: string, fs: ToolRegistryFilesystem) {
    this.path = join(directory, TOOL_REGISTRY_FILE_NAME);
    this.fs = fs;
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  private async loadUnlocked(): Promise<ToolRegistrySnapshot> {
    let contents: string;
    try {
      contents = await this.fs.readFile(this.path, "utf8");
    } catch (error) {
      if (isMissing(error)) return { registry: emptyToolRegistry(), revision: null };
      throw error;
    }
    return { registry: parseToolRegistryJson(contents), revision: revision(contents) };
  }

  load(): Promise<ToolRegistrySnapshot> {
    return this.serialized(() => this.loadUnlocked());
  }

  replace(registry: ToolRegistryV1, expectedRevision: ToolRegistryRevision | null): Promise<ToolRegistrySnapshot> {
    return this.serialized(async () => {
      const current = await this.loadUnlocked();
      if (current.revision !== expectedRevision) {
        throw new ToolRegistryConflictError(expectedRevision, current.revision);
      }
      const contents = serializeToolRegistry(registry);
      const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
      try {
        await this.fs.writeFile(temporaryPath, contents, "utf8");
        await this.fs.rename(temporaryPath, this.path);
      } finally {
        try {
          await this.fs.unlink(temporaryPath);
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
      return { registry: parseToolRegistryFile(registry), revision: revision(contents) };
    });
  }
}
