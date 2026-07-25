import type {
  CredentialSelection,
  ModelDiscoveryRequest,
  ProviderTurnRequest,
} from "../../../packages/contracts/src/index.ts";
import type {
  ResolvedInferenceRequest,
} from "../../../packages/core/src/types.ts";
import type {
  ProviderExecution,
} from "../../../packages/core/src/run-kernel/index.ts";
import {
  isProviderCapabilities,
  resolveProviderCapabilities,
} from "../../../packages/core/src/types.ts";
import type { CredentialStore } from "./credential-store.ts";

function parseCredential(value: unknown): CredentialSelection {
  if (!value || typeof value !== "object") {
    throw new Error("A credential selection is required.");
  }
  const credential = value as Partial<CredentialSelection>;
  if (credential.kind === "environment-default") {
    return { kind: "environment-default" };
  }
  if (credential.kind === "none") {
    return { kind: "none" };
  }
  if (credential.kind === "provided" && typeof credential.apiKey === "string") {
    return { kind: "provided", apiKey: credential.apiKey };
  }
  throw new Error("Credential selection is invalid.");
}

function parseProviderExecution(value: unknown): ProviderExecution {
  if (!value || typeof value !== "object") {
    throw new Error("Provider execution must be an object.");
  }
  const execution = value as Partial<ProviderExecution>;
  if (
    typeof execution.runId !== "string" ||
    typeof execution.turnId !== "string" ||
    typeof execution.exchangeId !== "string" ||
    execution.attempt !== 1
  ) {
    throw new Error("Provider execution identifiers are invalid.");
  }
  const input = execution.input;
  if (!input || typeof input !== "object") {
    throw new Error("Provider turn input is required.");
  }
  if (input.target?.protocol !== "openai-compatible-chat-completions") {
    throw new Error("Only OpenAI-compatible chat completions are supported.");
  }
  if (
    typeof input.target.endpoint !== "string" ||
    !input.target.endpoint.trim()
  ) {
    throw new Error("Endpoint is required.");
  }
  if (typeof input.target.model !== "string" || !input.target.model.trim()) {
    throw new Error("Model is required.");
  }
  if (!isProviderCapabilities(input.target.capabilities)) {
    throw new Error("Capabilities must contain only known boolean values.");
  }
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    throw new Error("At least one message is required.");
  }
  for (const candidate of input.messages) {
    if (
      !candidate ||
      !["system", "user", "assistant", "tool"].includes(candidate.role ?? "") ||
      !Array.isArray(candidate.content) ||
      !candidate.content.every(
        (part) => part?.type === "text" && typeof part.text === "string",
      )
    ) {
      throw new Error("Every message needs a valid role and text content.");
    }
  }
  if (!input.options || typeof input.options !== "object") {
    throw new Error("Provider options must be an object.");
  }
  if (
    input.options.temperature !== undefined &&
    (typeof input.options.temperature !== "number" ||
      input.options.temperature < 0 ||
      input.options.temperature > 2)
  ) {
    throw new Error("Temperature must be between 0 and 2.");
  }
  if (!Array.isArray(input.tools)) {
    throw new Error("Tools must be an array.");
  }
  for (const tool of input.tools) {
    if (
      !tool ||
      typeof tool.id !== "string" ||
      typeof tool.name !== "string" ||
      !tool.name.trim() ||
      !tool.inputSchema ||
      typeof tool.inputSchema !== "object" ||
      Array.isArray(tool.inputSchema)
    ) {
      throw new Error("Every tool needs an ID, name, and object input schema.");
    }
  }
  return execution as ProviderExecution;
}

export interface ResolvedProviderTurnRequest {
  execution: ProviderExecution;
  apiKey: string;
}

/** Parses a stateless provider-turn contract and resolves its credential. */
export function resolveProviderTurnRequest(
  value: unknown,
  credentials: CredentialStore,
): ResolvedProviderTurnRequest {
  if (!value || typeof value !== "object") {
    throw new Error("Request body must be an object.");
  }
  const body = value as Partial<ProviderTurnRequest>;
  const execution = parseProviderExecution(body.execution);
  const credential = parseCredential(body.credential);
  return {
    execution,
    apiKey: credentials.resolve(credential, execution.input.target.endpoint),
  };
}

export function resolveModelDiscoveryRequest(
  value: unknown,
  credentials: CredentialStore,
): Pick<ResolvedInferenceRequest, "endpoint" | "apiKey" | "capabilities"> {
  if (!value || typeof value !== "object") {
    throw new Error("Request body must be an object.");
  }
  const body = value as Partial<ModelDiscoveryRequest>;
  if (typeof body.endpoint !== "string" || !body.endpoint.trim()) {
    throw new Error("Endpoint is required.");
  }
  if (
    body.capabilities !== undefined &&
    !isProviderCapabilities(body.capabilities)
  ) {
    throw new Error("Capabilities must contain only known boolean values.");
  }
  return {
    endpoint: body.endpoint,
    capabilities:
      body.capabilities ?? resolveProviderCapabilities("openai-compatible"),
    apiKey: credentials.resolve(parseCredential(body.credential), body.endpoint),
  };
}
