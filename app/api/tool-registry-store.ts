import { existsSync, statSync } from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";

import {
  FileToolRegistryStore,
  ToolRegistryStorageUnavailableError,
} from "../../services/api/src";

const DATA_DIRECTORY = "/data";

const filesystem = { readFile, writeFile, rename, unlink };
let store: FileToolRegistryStore | undefined;

/**
 * The filesystem is examined without creating /data so a normal local dev
 * server retains its browser-local registry behavior.
 */
export function runtimeToolRegistryStore(): FileToolRegistryStore {
  if (!existsSync(DATA_DIRECTORY)) throw new ToolRegistryStorageUnavailableError();
  try {
    if (!statSync(DATA_DIRECTORY).isDirectory()) {
      throw new ToolRegistryStorageUnavailableError();
    }
  } catch (error) {
    if (error instanceof ToolRegistryStorageUnavailableError) throw error;
    throw new ToolRegistryStorageUnavailableError();
  }
  store ??= new FileToolRegistryStore(DATA_DIRECTORY, filesystem);
  return store;
}
