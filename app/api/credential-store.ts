import { existsSync, readFileSync } from "node:fs";

import {
  detectContainerRuntime,
  EnvironmentCredentialStore,
  parseAllowedHosts,
} from "../../services/api/src";
import type { WorkbenchRequestPolicy } from "../../services/api/src";

/**
 * HTTP-framework adapter for the Compose credential source. The rest of the
 * execution service receives only the CredentialStore interface.
 */
export function runtimeCredentialStore(): EnvironmentCredentialStore {
  return new EnvironmentCredentialStore(process.env);
}

/**
 * Extra `Host` names an operator has put this service behind. Parsed per
 * request so the source of truth stays the environment rather than a cache
 * that a restart is needed to clear.
 */
export function runtimeRequestPolicy(): WorkbenchRequestPolicy {
  return { allowedHosts: parseAllowedHosts(process.env.INFERENCE_LENS_ALLOWED_HOSTS) };
}

/**
 * Container detection is filesystem work that cannot change while the process
 * lives, so it is resolved once rather than on every request.
 */
let containerized: boolean | undefined;

export function isContainerizedRuntime(): boolean {
  containerized ??= detectContainerRuntime({
    environment: process.env,
    fileExists: (path) => existsSync(path),
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
  });
  return containerized;
}
