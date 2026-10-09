import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { startHeadlessEvaluation } from "./evaluation-run.ts";
import type { HeadlessConcurrency } from "./evaluation-run.ts";
import { formatHeadlessSummary, EXIT_SETUP } from "./summary.ts";
import { createInProcessTransport, isContainerizedProcess } from "./transport.ts";

export const USAGE = `Usage: inference-lens run <project-folder> [options]

Runs one evaluation suite with no browser and no server, writing the same
plan, result, and trace files the app writes.

Options:
  --suite <id-or-name>   Suite to run. Optional when the project has one suite.
  --no-auth <id>         Call connection <id> without a key. Repeatable.
  --concurrency <n>      Run up to <n> repetitions at once, on any one
                         connection or across several. Default 1.
  --connection-concurrency <id>=<n>
                         Run at most <n> of them at once on connection <id>.
                         Repeatable. Cannot exceed --concurrency.
  --json                 Print a machine-readable summary on stdout.
  -h, --help             Show this help.

Credentials (environment only):
  INFERENCE_LENS_CONNECTION_<ID>_API_KEY    Key for one connection.
  INFERENCE_LENS_CONNECTION_<ID>_ENDPOINT   Optional endpoint override for it.
  INFERENCE_LENS_API_KEY, INFERENCE_LENS_API_ENDPOINT
                                            Key for any connection on that origin.
  <ID> is the connection ID without its "connection_" prefix, upper-cased,
  with every other character replaced by "_".

Exit codes:
  0  The suite passed.
  1  The suite ran to completion and at least one case failed.
  2  Usage or setup error. Nothing was sent and no plan was written.
  3  The run started but did not complete.
`;

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  environment: Readonly<Record<string, string | undefined>>;
  /** Registers a handler for an interrupt; returns its removal. */
  onInterrupt?(handler: () => void): () => void;
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        suite: { type: "string" },
        "no-auth": { type: "string", multiple: true },
        concurrency: { type: "string" },
        "connection-concurrency": { type: "string", multiple: true },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return EXIT_SETUP;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout(USAGE);
    return 0;
  }
  const [command, projectFolder, ...extra] = positionals;
  if (command !== "run" || !projectFolder || extra.length > 0) {
    io.stderr(`${command && command !== "run" ? `Unknown command "${command}".\n\n` : ""}${USAGE}`);
    return EXIT_SETUP;
  }

  let concurrency: HeadlessConcurrency;
  try {
    concurrency = parseConcurrency(values.concurrency, values["connection-concurrency"] ?? []);
  } catch (error) {
    io.stderr(`inference-lens: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_SETUP;
  }

  const run = startHeadlessEvaluation({
    projectDirectory: projectFolder,
    ...(values.suite === undefined ? {} : { suite: values.suite }),
    noAuth: new Set(values["no-auth"] ?? []),
    concurrency,
    environment: io.environment,
    transport: createInProcessTransport({ containerized: isContainerizedProcess(io.environment) }),
    onProgress: (line) => io.stderr(`${line}\n`),
  });
  let interrupts = 0;
  const removeInterrupt = io.onInterrupt?.(() => {
    interrupts += 1;
    if (interrupts === 1) {
      io.stderr(
        `Stopping after the current ${(concurrency.limit ?? 1) > 1 ? "requests" : "request"}. Interrupt again to quit immediately.\n`,
      );
      run.cancel();
    } else {
      process.exit(130);
    }
  });
  const outcome = await run.done.finally(() => removeInterrupt?.());

  if (outcome.error) io.stderr(`inference-lens: ${outcome.error}\n`);
  if (outcome.summary) {
    if (values.json) io.stdout(`${JSON.stringify(outcome.summary, null, 2)}\n`);
    else io.stdout(formatHeadlessSummary(outcome.summary));
  }
  return outcome.exitCode;
}

function parseConcurrency(limit: string | undefined, connections: readonly string[]): HeadlessConcurrency {
  const parsed: { limit?: number; connections: Map<string, number> } = { connections: new Map() };
  if (limit !== undefined) {
    const value = positiveWholeNumber(limit);
    if (value === undefined) throw new Error(`--concurrency must be a positive whole number, not "${limit}".`);
    parsed.limit = value;
  }
  for (const entry of connections) {
    const separator = entry.lastIndexOf("=");
    const id = entry.slice(0, Math.max(separator, 0));
    const value = positiveWholeNumber(entry.slice(separator + 1));
    if (separator <= 0 || value === undefined) {
      throw new Error(`--connection-concurrency takes <connection-id>=<positive whole number>, not "${entry}".`);
    }
    if (parsed.connections.has(id)) throw new Error(`--connection-concurrency names ${id} more than once.`);
    parsed.connections.set(id, value);
  }
  return parsed;
}

function positiveWholeNumber(text: string): number | undefined {
  if (!/^[1-9][0-9]*$/.test(text)) return undefined;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : undefined;
}

const invokedDirectly = Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  const exitCode = await runCli(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    environment: process.env,
    onInterrupt(handler) {
      process.on("SIGINT", handler);
      process.on("SIGTERM", handler);
      return () => {
        process.off("SIGINT", handler);
        process.off("SIGTERM", handler);
      };
    },
  });
  process.exitCode = exitCode;
}
