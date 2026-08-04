import { z } from "zod";

import type {
  ToolExecutionContentPart,
  ToolExecutionOutcome,
} from "./run-kernel/types.ts";
import type { CommandToolDeclaration } from "./command-tool-catalog.ts";

/**
 * Turning a finished process into the T1 outcome vocabulary.
 *
 * This is the half of the command executor that has to be right, and it is
 * pure so it can be tested without spawning anything. The host contributes
 * bytes and an exit status; every judgement about what those mean is made
 * here, once, for every shell that ever grows a spawn implementation.
 */

/** What the host observed. Bytes only — no interpretation. */
export type CommandProcessResult =
  | {
      status: "exited";
      exitCode: number | null;
      signal?: string | null;
      stdout: string;
      stderr: string;
    }
  /** The command was still running when its own timeout elapsed. */
  | { status: "timeout"; stderr: string }
  /** The run was cancelled, or the app is shutting down. */
  | { status: "cancelled" }
  /** More than `maxOutputBytes` arrived on stdout; the process was killed. */
  | { status: "output_limit_exceeded"; stderr: string }
  /** The process never started: missing file, not executable, bad interpreter. */
  | { status: "spawn_failed"; message: string };

const contentPartSchema: z.ZodType<ToolExecutionContentPart> = z.union([
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z
    .object({
      type: z.literal("image"),
      mimeType: z.string().min(1),
      data: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("audio"),
      mimeType: z.string().min(1),
      data: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("resource"),
      uri: z.string().min(1),
      mimeType: z.string().min(1).optional(),
      text: z.string().optional(),
    })
    .strict(),
]);

const envelopeSchema = z
  .object({
    content: z.array(contentPartSchema).min(1),
    isError: z.boolean().optional(),
  })
  .strict();

/**
 * How much of stderr is worth keeping.
 *
 * Some is essential — a command that exits 3 with no explanation is a support
 * ticket. All of it is not: this text lands in a run trace that gets shared,
 * so it is bounded here and documented as trace-visible for operators writing
 * commands.
 */
const STDERR_EXCERPT_LIMIT = 500;

function stderrExcerpt(stderr: string): string | undefined {
  const trimmed = stderr.trim();
  if (!trimmed) return undefined;
  return trimmed.length > STDERR_EXCERPT_LIMIT
    ? `${trimmed.slice(0, STDERR_EXCERPT_LIMIT)}…`
    : trimmed;
}

/**
 * How the command is named in evidence.
 *
 * Never the executable path. A failure message travels into a run trace, and a
 * trace is a portable artifact a teammate opens: the whole point of keeping
 * bindings device-local is undone if `/Users/someone/work/secret-client/bin/x`
 * is written into one by an error string.
 */
function commandName(declaration: CommandToolDeclaration): string {
  return `“${declaration.label}”`;
}

export function interpretCommandToolResult(
  result: CommandProcessResult,
  declaration: CommandToolDeclaration,
): ToolExecutionOutcome {
  const name = commandName(declaration);

  if (result.status === "cancelled") {
    return {
      status: "failed",
      failure: {
        kind: "cancelled",
        message: `The command tool ${name} was cancelled.`,
      },
    };
  }

  if (result.status === "spawn_failed") {
    return {
      status: "failed",
      failure: {
        kind: "execution_failed",
        message: `The command tool ${name} could not be started: ${result.message}`,
      },
    };
  }

  if (result.status === "timeout") {
    const excerpt = stderrExcerpt(result.stderr);
    return {
      status: "failed",
      failure: {
        kind: "timeout",
        message: `The command tool ${name} did not finish within ${declaration.timeoutMs}ms and was stopped.`,
        details: {
          timeoutMs: declaration.timeoutMs,
          ...(excerpt === undefined ? {} : { stderr: excerpt }),
        },
      },
    };
  }

  if (result.status === "output_limit_exceeded") {
    return {
      status: "failed",
      failure: {
        kind: "invalid_result",
        message: `The command tool ${name} produced more than ${declaration.maxOutputBytes} bytes on stdout and was stopped.`,
        details: { maxOutputBytes: declaration.maxOutputBytes },
      },
    };
  }

  const excerpt = stderrExcerpt(result.stderr);

  // A nonzero exit is an execution failure, never a tool error. The difference
  // is load-bearing: a tool error is a result the model is entitled to reason
  // about, and it is claimed by saying `isError` in the envelope. Reading it
  // off the exit code instead would let a crashed process answer the model.
  if (result.exitCode !== 0 || result.signal) {
    return {
      status: "failed",
      failure: {
        kind: "execution_failed",
        message: result.signal
          ? `The command tool ${name} was terminated by signal ${result.signal}.`
          : `The command tool ${name} exited with status ${result.exitCode}.`,
        details: {
          ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
          ...(result.signal ? { signal: result.signal } : {}),
          ...(excerpt === undefined ? {} : { stderr: excerpt }),
        },
      },
    };
  }

  if (!result.stdout.trim()) {
    return {
      status: "failed",
      failure: {
        kind: "invalid_result",
        message: `The command tool ${name} exited successfully but wrote nothing to stdout.`,
        ...(excerpt === undefined ? {} : { details: { stderr: excerpt } }),
      },
    };
  }

  if (declaration.resultFormat === "text") {
    return {
      status: "completed",
      content: [{ type: "text", text: result.stdout }],
      isError: false,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    return {
      status: "failed",
      failure: {
        kind: "invalid_result",
        message: `The command tool ${name} did not write a JSON result: ${
          error instanceof Error ? error.message : "the output could not be parsed"
        }`,
      },
    };
  }

  const envelope = envelopeSchema.safeParse(parsed);
  if (!envelope.success) {
    return {
      status: "failed",
      failure: {
        kind: "invalid_result",
        message:
          `The command tool ${name} wrote JSON that is not a tool result. ` +
          `Expected { "content": [ { "type": "text", "text": … } ], "isError"?: boolean }.`,
        details: {
          issues: envelope.error.issues.map((issue) =>
            issue.path.length
              ? `${issue.path.join(".")}: ${issue.message}`
              : issue.message,
          ),
        },
      },
    };
  }

  return {
    status: "completed",
    content: envelope.data.content,
    isError: envelope.data.isError ?? false,
  };
}

/**
 * What a command reads on stdin: the call's arguments, as the model produced
 * them, plus the tool's name so one executable can serve several tools.
 *
 * The raw argument text is passed through rather than re-serialized. A model
 * that emits invalid JSON is a real debugging case, and the tool should see
 * exactly what it emitted — this app exists to show what actually happened.
 */
export interface CommandToolStdinPayload {
  tool: string;
  toolCallId: string;
  arguments: string;
}

export function commandToolStdin(payload: CommandToolStdinPayload): string {
  return `${JSON.stringify(payload)}\n`;
}
