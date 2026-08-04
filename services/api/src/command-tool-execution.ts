import type { CommandToolExecutionRequest } from "../../../packages/contracts/src/index.ts";
import { findCommandDeclaration } from "../../../packages/core/src/command-tool-catalog.ts";
import {
  commandToolStdin,
  interpretCommandToolResult,
} from "../../../packages/core/src/command-tool-outcome.ts";
import type { ToolExecutionOutcome } from "../../../packages/core/src/run-kernel/index.ts";
import {
  COMMAND_TOOLS_VARIABLE,
  readCommandToolCatalog,
} from "./command-tool-catalog-source.ts";
import type { CommandToolCatalogSource } from "./command-tool-catalog-source.ts";
import { runCommandTool } from "./command-tool-runner.ts";
import { WorkbenchRequestError } from "./request-security.ts";

/**
 * The service half of the command executor: resolve a declared command by id,
 * run it, classify it.
 *
 * A request that names something undeclared is refused as
 * `rejected` — a policy refusal, not an execution that went wrong. That
 * distinction is the whole reason `rejected` was in the T1 vocabulary before
 * anything could produce it.
 */

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new WorkbenchRequestError(`Field "${field}" must be a string.`, 400);
  }
  return value;
}

export function resolveCommandToolExecutionRequest(
  body: unknown,
): CommandToolExecutionRequest {
  if (!body || typeof body !== "object") {
    throw new WorkbenchRequestError("A command execution request is required.", 400);
  }
  const value = body as Record<string, unknown>;
  const commandId = requireString(value.commandId, "commandId").trim();
  if (!commandId) {
    throw new WorkbenchRequestError('Field "commandId" must not be empty.', 400);
  }
  return {
    commandId,
    tool: requireString(value.tool, "tool"),
    toolCallId: requireString(value.toolCallId, "toolCallId"),
    arguments: requireString(value.arguments, "arguments"),
  };
}

function rejection(message: string): ToolExecutionOutcome {
  return { status: "failed", failure: { kind: "rejected", message } };
}

export interface ExecuteCommandToolOptions {
  signal?: AbortSignal;
  environment?: Record<string, string | undefined>;
  /** Injected by tests; production reads the operator's catalog per request. */
  catalog?: CommandToolCatalogSource;
}

export async function executeCommandTool(
  request: CommandToolExecutionRequest,
  options: ExecuteCommandToolOptions = {},
): Promise<ToolExecutionOutcome> {
  const environment = options.environment ?? process.env;
  const source = options.catalog ?? readCommandToolCatalog(environment);

  if (!source.available) {
    return rejection(
      source.problem ??
        `This service runs no command tools. Set ${COMMAND_TOOLS_VARIABLE} to a command catalog to declare some.`,
    );
  }

  const declaration = findCommandDeclaration(
    { schemaVersion: 1, commands: source.commands },
    request.commandId,
  );
  if (!declaration) {
    return rejection(
      `No command “${request.commandId}” is declared on this service. It may have been removed from the catalog.`,
    );
  }

  const result = await runCommandTool(
    declaration,
    commandToolStdin({
      tool: request.tool,
      toolCallId: request.toolCallId,
      arguments: request.arguments,
    }),
    { signal: options.signal, environment },
  );
  return interpretCommandToolResult(result, declaration);
}
