import type {
  MessageContentPart,
  RunEvent,
  ToolCall,
  ToolCallId,
  ToolContentProjection,
  ToolContentProjectionNote,
  ToolDefinition,
  ToolExecutionContentPart,
  ToolExecutionFailure,
  ToolExecutionId,
  ToolExecutionOutcome,
  ToolExecutorIdentity,
  ToolExecutorKind,
  ToolId,
} from "./run-kernel/types.ts";

/**
 * The executor seam.
 *
 * A `ToolDefinition` is a portable descriptor: it says what a tool is called
 * and what it accepts, and it travels in projects, plans, and traces. A
 * `ToolBinding` says how that tool is served *on this device* — which mock,
 * which executable, which server — and it travels nowhere. The only part of a
 * binding that may be persisted is its `ToolExecutorIdentity`, produced by
 * `toolExecutorIdentity` below.
 *
 * Keeping the split here rather than inside each executor is what lets a
 * command tool and an MCP client arrive later without reshaping the run model:
 * the kernel only ever sees an identity and a normalized outcome.
 */

/** Device-local configuration for one executor kind. */
export type ToolBindingConfig =
  | {
      kind: "mock";
      executorId: string;
      label?: string;
      result: {
        content: ToolExecutionContentPart[];
        isError?: boolean;
      };
    }
  /**
   * A command declared by whoever runs this service, referenced by id.
   *
   * The executable and its argument vector are deliberately absent: they live
   * in the host's catalog, and a binding that carried them would let the page
   * choose what runs. Referencing a declaration by id makes the operator's
   * file the ceiling, and leaves the binding safe to keep in browser storage.
   */
  | {
      kind: "command";
      /** The declared command's id. Also the persisted executor identity. */
      executorId: string;
      label?: string;
      /** When the user granted this tool the right to run that command. */
      grantedAt: string;
    };

export type ToolBinding = ToolBindingConfig & { toolId: ToolId };

export interface ToolInvocation {
  toolCallId: ToolCallId;
  /** The immutable descriptor snapshot the call was made against. */
  tool: ToolDefinition;
  call: ToolCall;
}

export interface ToolExecutorRuntime {
  signal?: AbortSignal;
}

export interface ToolExecutor {
  readonly kind: ToolExecutorKind;
  execute(
    invocation: ToolInvocation,
    runtime: ToolExecutorRuntime,
  ): Promise<ToolExecutionOutcome>;
}

export type ToolExecutorResolver = (
  binding: ToolBinding,
) => ToolExecutor | undefined;

/**
 * Projects a binding down to what may be recorded. This is the redaction seam,
 * and it is written as an explicit construction rather than a field deletion so
 * that a binding kind added later cannot leak its configuration by default —
 * it has to be given an identity here first.
 */
export function toolExecutorIdentity(
  binding: ToolBindingConfig,
): ToolExecutorIdentity {
  switch (binding.kind) {
    case "mock":
      return {
        kind: "mock",
        executorId: binding.executorId,
        ...(binding.label === undefined ? {} : { label: binding.label }),
      };
    // The command id and its label are the operator's own words and travel;
    // the executable path, its arguments, and the grant timestamp do not. A
    // trace says which declared command answered, never where it lives on
    // whichever machine happened to run it.
    case "command":
      return {
        kind: "command",
        executorId: binding.executorId,
        ...(binding.label === undefined ? {} : { label: binding.label }),
      };
  }
}

export function resolveToolBinding(
  bindings: readonly ToolBinding[],
  toolId: ToolId,
): ToolBinding | undefined {
  return bindings.find((binding) => binding.toolId === toolId);
}

function placeholderFor(part: Exclude<ToolExecutionContentPart, { type: "text" }>): string {
  switch (part.type) {
    case "image":
      return `[image content not sent — ${part.mimeType}]`;
    case "audio":
      return `[audio content not sent — ${part.mimeType}]`;
    case "resource":
      return `[resource content not sent — ${part.uri}]`;
  }
}

/**
 * Reduces executor content to the text-only vocabulary a provider message and a
 * run trace can carry, and reports what it stood in for.
 *
 * Nothing is dropped silently. A tool that answered with an image produces a
 * visible placeholder in the text the provider sees and a note the UI can show,
 * because a user comparing two runs must be able to tell "the tool returned an
 * image we cannot send" from "the tool returned nothing".
 */
export function projectToolExecutionContent(
  parts: readonly ToolExecutionContentPart[],
): { content: MessageContentPart[]; projection: ToolContentProjection } {
  const projectedParts: ToolContentProjectionNote[] = [];
  const content = parts.map((part) => {
    if (part.type === "text") return { type: "text" as const, text: part.text };
    const placeholder = placeholderFor(part);
    projectedParts.push({
      type: part.type,
      ...(part.type === "resource"
        ? { uri: part.uri, ...(part.mimeType === undefined ? {} : { mimeType: part.mimeType }) }
        : { mimeType: part.mimeType }),
      placeholder,
    });
    return { type: "text" as const, text: placeholder };
  });
  return { content, projection: { projectedParts } };
}

/**
 * What the coordinator contributes to an execution. Declared structurally so
 * the batch controller can drive an execution through the same function the
 * interactive session uses, and so tests can drive it without a coordinator.
 */
export interface ToolExecutionRecorder {
  startToolExecution(input: {
    toolCallId: ToolCallId;
    executor: ToolExecutorIdentity;
  }): { event: RunEvent; executionId: ToolExecutionId };
  completeToolExecution(input: {
    executionId: ToolExecutionId;
    toolCallId: ToolCallId;
    content: MessageContentPart[];
    projection: ToolContentProjection;
    isError: boolean;
  }): RunEvent;
  failToolExecution(input: {
    executionId: ToolExecutionId;
    toolCallId: ToolCallId;
    failure: ToolExecutionFailure;
  }): RunEvent;
}

export interface ToolExecutionAttempt {
  executionId: ToolExecutionId;
  outcome: ToolExecutionOutcome;
  events: RunEvent[];
}

function failureFromThrown(error: unknown, signal?: AbortSignal): ToolExecutionFailure {
  if (signal?.aborted) {
    return { kind: "cancelled", message: "The tool execution was cancelled." };
  }
  return {
    kind: "execution_failed",
    message:
      error instanceof Error ? error.message : "The tool execution failed.",
  };
}

/**
 * Runs one executor and records the evidence around it.
 *
 * An executor that throws, rather than returning a classified failure, is
 * still classified here: an unhandled rejection must never leave an execution
 * open in the run state, because the run would then be permanently unable to
 * accept a result for that call.
 */
export async function executeToolCall(
  recorder: ToolExecutionRecorder,
  executor: ToolExecutor,
  binding: ToolBindingConfig,
  invocation: ToolInvocation,
  runtime: ToolExecutorRuntime = {},
): Promise<ToolExecutionAttempt> {
  const started = recorder.startToolExecution({
    toolCallId: invocation.toolCallId,
    executor: toolExecutorIdentity(binding),
  });
  const events: RunEvent[] = [started.event];

  let outcome: ToolExecutionOutcome;
  try {
    outcome = await executor.execute(invocation, runtime);
  } catch (error) {
    outcome = { status: "failed", failure: failureFromThrown(error, runtime.signal) };
  }

  if (outcome.status === "completed") {
    const { content, projection } = projectToolExecutionContent(outcome.content);
    events.push(
      recorder.completeToolExecution({
        executionId: started.executionId,
        toolCallId: invocation.toolCallId,
        content,
        projection,
        isError: outcome.isError,
      }),
    );
  } else {
    events.push(
      recorder.failToolExecution({
        executionId: started.executionId,
        toolCallId: invocation.toolCallId,
        failure: outcome.failure,
      }),
    );
  }

  return { executionId: started.executionId, outcome, events };
}
