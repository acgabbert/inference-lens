import { existsSync, readFileSync } from "node:fs";

import type {
  CredentialSelection,
  ProviderTurnRequest,
  ProviderTurnStream,
  ProviderTurnTransport,
} from "../../contracts/src/index.ts";
import type { CredentialStore } from "../../../services/api/src/credential-store.ts";
import { resolveProviderTurnRequest } from "../../../services/api/src/inference-request.ts";
import { executeProviderTurn } from "../../../services/api/src/run-executor.ts";
import { detectContainerRuntime } from "../../../services/api/src/runtime-environment.ts";

/**
 * Releases only what the CLI already resolved and origin-bound. There is no
 * environment default to fall back on here: every connection was resolved to
 * a provided key or an explicit "none" before the plan was saved.
 */
const preparedCredentialStore: CredentialStore = {
  resolve(selection: CredentialSelection): string {
    if (selection.kind === "none") return "";
    if (selection.kind === "provided") return selection.apiKey;
    throw new Error(`The headless runner cannot resolve a ${selection.kind} credential.`);
  },
};

export function isContainerizedProcess(environment: Record<string, string | undefined> = process.env): boolean {
  return detectContainerRuntime({
    environment,
    fileExists: (path) => existsSync(path),
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
  });
}

/**
 * The server's provider path, called in process instead of over HTTP.
 *
 * The request still crosses `resolveProviderTurnRequest`, so a headless turn is
 * validated exactly as one the browser sends to the service.
 */
export function createInProcessTransport(options: { containerized: boolean }): ProviderTurnTransport {
  return {
    async discoverModels() {
      throw new Error("Model discovery is not available in a headless run.");
    },
    async executeTurn(request: ProviderTurnRequest, signal?: AbortSignal): Promise<ProviderTurnStream> {
      const resolved = resolveProviderTurnRequest(request, preparedCredentialStore);
      return {
        status: 200,
        headers: new Headers(),
        events: executeProviderTurn(resolved.execution, resolved.apiKey, signal, {
          containerized: options.containerized,
        }),
      };
    },
  };
}
