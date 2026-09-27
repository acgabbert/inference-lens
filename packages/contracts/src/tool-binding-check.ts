export const TOOL_BINDING_CHECK_API_PATH = "/api/tool-bindings/check";

/**
 * One local binding, named the way the host can verify it. It carries no
 * endpoint, command line, credential, or timeout: the host resolves those from
 * the operator's catalogs.
 */
export type ToolBindingCheckItem =
  | { toolId: string; kind: "command"; commandId: string }
  | {
      toolId: string;
      kind: "mcp";
      serverId: string;
      remoteToolName: string;
      discoveryFingerprint: string;
    };

export type ToolBindingUnavailableReason =
  | "declaration_missing"
  | "not_executable"
  | "tool_missing"
  | "fingerprint_changed"
  | "server_unreachable";

export interface ToolBindingCheckResult {
  toolId: string;
  status: "ready" | "unavailable";
  /** Present exactly when unavailable. */
  reason?: ToolBindingUnavailableReason;
  /** A sentence safe to show; never an endpoint or raw transport error. */
  message?: string;
}

export interface ToolBindingCheckRequest {
  bindings: ToolBindingCheckItem[];
}

export interface ToolBindingCheckResponse {
  results: ToolBindingCheckResult[];
}
