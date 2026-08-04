import type { CommandToolDeclaration } from "../../core/src/command-tool-catalog.ts";
import type { ToolExecutionOutcome } from "../../core/src/run-kernel/index.ts";

/** The stable browser-to-service paths for command tools. */
export const TOOL_COMMANDS_API_PATH = "/api/tool-commands";
export const TOOL_EXECUTION_API_PATH = "/api/tool-execution";

/**
 * What the service is willing to run, as the UI must show it.
 *
 * The declarations are returned whole, executable path included, because the
 * consent surface has to state exactly what a grant permits. They are the
 * operator's own configuration on the operator's own service, released only to
 * the same origin — but that does mean an argument vector is visible to anyone
 * who can open the UI, so a catalog is not a place for secrets.
 */
export interface CommandToolCatalogResponse {
  /** False when no catalog is configured, or when the configured one is unusable. */
  available: boolean;
  /** Set only when a catalog was configured and could not be used. */
  problem?: string;
  /** Named so the UI can tell an operator exactly what to set. */
  configurationVariable: string;
  commands: CommandToolDeclaration[];
}

export interface CommandToolExecutionRequest {
  /** A declared command id. The page may not name an executable. */
  commandId: string;
  /** The tool name the model called, passed through to the command's stdin. */
  tool: string;
  toolCallId: string;
  /** The model's argument text, verbatim, valid JSON or not. */
  arguments: string;
}

/**
 * The service answers with a normalized outcome, not an HTTP status.
 *
 * Every classification a command can produce is already in the T1 vocabulary,
 * so mapping them onto status codes and back would only create a second place
 * for the meaning of "failed" to drift.
 */
export type CommandToolExecutionResponse = ToolExecutionOutcome;
