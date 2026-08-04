import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import {
  CommandToolCatalogError,
  parseCommandToolCatalog,
} from "../../../packages/core/src/command-tool-catalog.ts";
import type {
  CommandToolCatalog,
  CommandToolDeclaration,
} from "../../../packages/core/src/command-tool-catalog.ts";

/**
 * The operator's declaration of what this service may spawn.
 *
 * Nothing is executable until this variable names a readable catalog, so the
 * default posture of every deployment — including the containerized one — is
 * that command tools do not exist.
 */
export const COMMAND_TOOLS_VARIABLE = "INFERENCE_LENS_COMMAND_TOOLS";

export interface CommandToolCatalogSource {
  available: boolean;
  /** Set only when a catalog was configured and could not be used. */
  problem?: string;
  /** Empty whenever `available` is false. */
  commands: CommandToolDeclaration[];
}

function resolveExecutables(
  catalog: CommandToolCatalog,
  catalogPath: string,
): CommandToolDeclaration[] {
  const base = dirname(catalogPath);
  return catalog.commands.map((command) => ({
    ...command,
    // Relative paths resolve against the catalog rather than the service's
    // working directory: a catalog and its scripts are one thing an operator
    // moves around together, and the service's cwd is not something they chose.
    executable: isAbsolute(command.executable)
      ? command.executable
      : resolve(base, command.executable),
  }));
}

/**
 * Read per call rather than cached, matching how the request policy reads its
 * allowlist. An operator editing the catalog is changing a permission, and
 * needing to remember which changes require a restart is exactly how a
 * revoked command stays runnable.
 */
export function readCommandToolCatalog(
  environment: Record<string, string | undefined> = process.env,
): CommandToolCatalogSource {
  const catalogPath = environment[COMMAND_TOOLS_VARIABLE]?.trim();
  if (!catalogPath) return { available: false, commands: [] };

  let contents: string;
  try {
    contents = readFileSync(catalogPath, "utf8");
  } catch (error) {
    return {
      available: false,
      commands: [],
      problem: `${COMMAND_TOOLS_VARIABLE} names a catalog that could not be read: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    };
  }

  try {
    const catalog = parseCommandToolCatalog(JSON.parse(contents));
    return {
      available: true,
      commands: resolveExecutables(catalog, resolve(catalogPath)),
    };
  } catch (error) {
    return {
      available: false,
      commands: [],
      problem:
        error instanceof CommandToolCatalogError
          ? `${COMMAND_TOOLS_VARIABLE} names an invalid catalog. ${error.message}`
          : `${COMMAND_TOOLS_VARIABLE} names a file that is not JSON: ${
              error instanceof Error ? error.message : "unknown error"
            }`,
    };
  }
}
