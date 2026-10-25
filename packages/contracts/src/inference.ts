import type {
  ProviderExecution,
  ProviderTransportEvent,
  ProviderWireProtocol,
} from "../../core/src/run-kernel/index.ts";
import type {
  DecisionExecution,
  DecisionTransportEvent,
} from "../../core/src/decision.ts";
import type { ConnectionProtocol } from "../../core/src/provider-protocols.ts";
import type { ProviderCapabilities } from "../../core/src/types.ts";

/** The stable browser-to-service paths for the local workbench. */
export const INFERENCE_API_PATH = "/api/inference";
export const MODELS_API_PATH = "/api/models";
export const DECISIONS_API_PATH = "/api/decisions";

/**
 * Selects where the API service obtains a credential. Values are deliberately
 * absent from the normal environment-backed request so the browser never sees
 * a configured container secret. A provided credential is session-only UI
 * input for the local workbench and must never be persisted.
 */
export type CredentialSelection =
  | {
      kind: "environment-default";
      /**
       * Which server-held connection's key. Absent means `default`, the one
       * the `INFERENCE_LENS_API_*` variables describe, so every request made
       * before there could be several stays valid.
       */
      connectionId?: string;
    }
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
  /**
   * Decides how the credential is presented. Absent means chat completions,
   * which every caller before protocols existed meant. `systemone` asks for
   * the decision models, following whichever marker the server's listings
   * carry (D10-B).
   */
  protocol?: ConnectionProtocol;
  /** Snapshot from the selected profile; unsupported discovery is never sent. */
  capabilities?: ProviderCapabilities;
  credential: CredentialSelection;
}

export interface ModelDiscoveryResponse {
  models: string[];
  /** A decision listing in which nothing marked decision models apart. */
  unfiltered?: true;
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

export interface DecisionExecutionRequest {
  execution: DecisionExecution;
  credential: CredentialSelection;
}

export interface DecisionStream {
  status: number;
  headers: Headers;
  events: AsyncIterable<DecisionTransportEvent>;
}

/**
 * Executes decision (System One) exchanges (D12). Separate from
 * ProviderTurnTransport so a conversation cannot reach a decision endpoint;
 * the same host classes implement both, and discovery stays on the turn
 * transport.
 */
export interface DecisionTransport {
  executeDecision(
    request: DecisionExecutionRequest,
    signal?: AbortSignal,
  ): Promise<DecisionStream>;
}
