import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import type { CommandToolDeclaration } from "../../../packages/core/src/command-tool-catalog.ts";
import type { CommandProcessResult } from "../../../packages/core/src/command-tool-outcome.ts";

/**
 * Spawning, and nothing else.
 *
 * Every judgement about what a finished process *means* lives in
 * `command-tool-outcome.ts`, which is pure and shell-independent. This module
 * owns only the parts that cannot be: starting the process, bounding what it
 * may produce, and making sure it is gone afterwards.
 */

/** How long a terminated command has to exit before it is killed outright. */
const TERMINATION_GRACE_MS = 2_000;

/**
 * Variables a command may see.
 *
 * The service's own environment holds provider credentials and, in a
 * container, whatever else the operator injected. None of it is a command
 * tool's business, so the child gets an explicitly constructed environment
 * rather than an inherited one with the known-bad names removed — the same
 * reason `toolExecutorIdentity` is a construction rather than a deletion.
 */
const INHERITED_VARIABLES = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TEMP",
  "TMP",
  // Windows needs these to resolve an interpreter at all.
  "SystemRoot",
  "COMSPEC",
  "PATHEXT",
];

function childEnvironment(
  environment: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const child: Record<string, string> = {};
  for (const name of INHERITED_VARIABLES) {
    const value = environment[name];
    if (value !== undefined) child[name] = value;
  }
  // `ProcessEnv` is augmented with required keys in this project; a child's
  // environment is a constructed subset by design, so it is asserted rather
  // than filled in with values the command has no business seeing.
  return child as NodeJS.ProcessEnv;
}

/**
 * Live children, so a shutdown does not leave a spawned tool running.
 *
 * A command is started in its own process group, which is what makes killing
 * its *tree* possible when it spawns helpers of its own — but it also means a
 * Ctrl-C aimed at the terminal's foreground group no longer reaches it. That
 * is the trade this set pays for.
 */
const liveCommands = new Set<ChildProcess>();
let shutdownHooksInstalled = false;

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    // Negative pid addresses the group the child leads, so anything it started
    // goes with it. Windows has no process groups; taskkill-style teardown is
    // out of scope for a shell that cannot host this service anyway.
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-pid, signal);
  } catch {
    // Already gone, or never started. Either way there is nothing to kill.
  }
}

function terminate(child: ChildProcess): void {
  killTree(child, "SIGTERM");
  const grace = setTimeout(() => killTree(child, "SIGKILL"), TERMINATION_GRACE_MS);
  grace.unref();
  child.once("close", () => clearTimeout(grace));
}

/** Best effort: kill every live command, synchronously. */
export function terminateCommandTools(): void {
  for (const child of liveCommands) killTree(child, "SIGKILL");
  liveCommands.clear();
}

function installShutdownHooks(): void {
  if (shutdownHooksInstalled) return;
  shutdownHooksInstalled = true;
  process.on("exit", terminateCommandTools);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, function handler() {
      terminateCommandTools();
      // Re-raise so the host's own shutdown is unchanged: without this,
      // registering a listener would suppress Node's default termination and
      // a Ctrl-C would stop killing the dev server.
      process.removeListener(signal, handler);
      process.kill(process.pid, signal);
    });
  }
}

export interface CommandToolRunOptions {
  signal?: AbortSignal;
  environment?: Record<string, string | undefined>;
}

/**
 * Runs one declared command to completion, cancellation, or timeout.
 *
 * Never a shell: the executable and its arguments are passed as a vector, so
 * an argument that happens to contain `;` or `$(…)` is an argument. The
 * model's arguments do not reach the vector at all — they go in on stdin.
 */
export function runCommandTool(
  declaration: CommandToolDeclaration,
  stdin: string,
  options: CommandToolRunOptions = {},
): Promise<CommandProcessResult> {
  const { signal, environment = process.env } = options;
  if (signal?.aborted) {
    return Promise.resolve({ status: "cancelled" });
  }
  installShutdownHooks();

  return new Promise<CommandProcessResult>((resolvePromise) => {
    let child: ChildProcess;
    try {
      child = spawn(declaration.executable, declaration.args, {
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        env: childEnvironment(environment),
      });
    } catch (error) {
      resolvePromise({
        status: "spawn_failed",
        message: error instanceof Error ? error.message : "unknown error",
      });
      return;
    }

    liveCommands.add(child);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let outcome: "exited" | "timeout" | "cancelled" | "output_limit_exceeded" =
      "exited";

    function stderrText(): string {
      return Buffer.concat(stderrChunks).toString("utf8");
    }

    function settle(result: CommandProcessResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      liveCommands.delete(child);
      resolvePromise(result);
    }

    function stop(reason: typeof outcome): void {
      if (settled || outcome !== "exited") return;
      outcome = reason;
      terminate(child);
    }

    const timer = setTimeout(() => stop("timeout"), declaration.timeoutMs);
    timer.unref();

    function onAbort(): void {
      stop("cancelled");
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > declaration.maxOutputBytes) {
        stop("output_limit_exceeded");
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      // Bounded independently of stdout: stderr never becomes a result, and an
      // excerpt is all the failure evidence carries.
      if (stderrBytes > 64_000) return;
      stderrBytes += chunk.length;
      stderrChunks.push(chunk);
    });

    child.once("error", (error: Error) => {
      settle({ status: "spawn_failed", message: error.message });
    });

    // `close` rather than `exit`: stdout is only complete once its pipe has.
    child.once("close", (code, closeSignal) => {
      if (outcome === "cancelled") settle({ status: "cancelled" });
      else if (outcome === "timeout") settle({ status: "timeout", stderr: stderrText() });
      else if (outcome === "output_limit_exceeded") {
        settle({ status: "output_limit_exceeded", stderr: stderrText() });
      } else {
        settle({
          status: "exited",
          exitCode: code,
          signal: closeSignal,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: stderrText(),
        });
      }
    });

    // A command that never reads stdin closes the pipe first; that is normal,
    // not a failure of the run.
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdin);
  });
}
