import type {
  ProviderExecution,
  ProviderTransportEvent,
} from "../../core/src/run-kernel/index.ts";
import type { ProviderCapabilities } from "../../core/src/types.ts";

/** The stable browser-to-service paths for the local workbench. */
export const INFERENCE_API_PATH = "/api/inference";
export const MODELS_API_PATH = "/api/models";

/**
 * Selects where the API service obtains a credential. Values are deliberately
 * absent from the normal environment-backed request so the browser never sees
 * a configured container secret. A provided credential is session-only UI
 * input for the local workbench and must never be persisted.
 */
export type CredentialSelection =
  | { kind: "environment-default" }
  /** No credential is sent. Intended for local, explicitly unauthenticated endpoints. */
  | { kind: "none" }
  | { kind: "provided"; apiKey: string }
  /** An opaque credential reference resolved only by a native desktop host. */
  | { kind: "native-keychain"; profileId: string };

export interface ProviderTurnRequest {
  execution: ProviderExecution;
  credential: CredentialSelection;
}

export interface ModelDiscoveryRequest {
  endpoint: string;
  /** Snapshot from the selected profile; unsupported discovery is never sent. */
  capabilities?: ProviderCapabilities;
  credential: CredentialSelection;
}

export interface ModelDiscoveryResponse {
  models: string[];
}

export interface ProviderTurnStream {
  status: number;
  headers: Headers;
  events: AsyncIterable<ProviderTransportEvent>;
}

/**
 * The UI's only dependency on execution. Browser HTTP, Tauri IPC, and
 * Electron IPC can each implement this without changing UI components.
 */
export interface ProviderTurnTransport {
  discoverModels(
    request: ModelDiscoveryRequest,
    signal?: AbortSignal,
  ): Promise<ModelDiscoveryResponse>;
  executeTurn(
    request: ProviderTurnRequest,
    signal?: AbortSignal,
  ): Promise<ProviderTurnStream>;
}
