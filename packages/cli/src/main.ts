import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  DEFAULT_REPETITION_COUNT,
  MAX_REPETITION_COUNT,
  MIN_REPETITION_COUNT,
} from "../../runner/src/repeated-start.ts";
import { startHeadlessEvaluation } from "./evaluation-run.ts";
import type { HeadlessConcurrency, HeadlessRun, HeadlessRunOptions } from "./headless-experiment.ts";
import { startHeadlessRepeat } from "./repeated-run.ts";
import { formatHeadlessRepeatedSummary, formatHeadlessSummary, EXIT_SETUP } from "./summary.ts";
import { parseToolGrants } from "./tool-grants.ts";
import { createInProcessTransport, isContainerizedProcess } from "./transport.ts";

export const USAGE = `Usage: inference-lens run <project-folder> [options]
       inference-lens repeat <project-folder> [options]

Runs work from a project folder with no browser and no server, writing the
same plan, result, and trace files the app writes. Never writes project.json.

  run      Runs one evaluation suite.
  repeat   Repeats the project's current conversation, as last saved, with
           its saved model, temperature, and enabled tools.

Options for run:
  --suite <id-or-name>   Suite to run. Optional when the project has one suite.
  --case <id-or-name>    Run only this case. Repeatable. Every case by default.
  --configuration <id-or-name>
                         Run only this configuration. Repeatable. Every
                         configuration by default.

Options for repeat:
  --repetitions <n>      How many times, from ${MIN_REPETITION_COUNT} to ${MAX_REPETITION_COUNT}. Default ${DEFAULT_REPETITION_COUNT}.
  --response-mode streaming|buffered
                         Default buffered, where TTFO is the time to the
                         whole response. Streaming needs a connection that
                         declares it.

Options for both:
  --no-auth <id>         Call connection <id> without a key. Repeatable.
  --concurrency <n>      Run up to <n> repetitions at once, on any one
                         connection or across several. Default 1.
  --connection-concurrency <id>=<n>
                         Run at most <n> of them at once on connection <id>.
                         Repeatable. Cannot exceed --concurrency.
  --allow-tool <tool>=command:<id>
  --allow-tool <tool>=mcp:<server-id>
                         Let tool <tool> run the declared command <id>, or
                         call it on the declared MCP server, for this run
                         only. Repeatable. Outranks an enabled project mock.
  --retry-rate-limits    Retry a request the provider refuses with HTTP 429,
                         up to 2 times per provider turn, after the wait it
                         asks for. Off by default; the result records it.
  --json                 Print a machine-readable summary on stdout.
  -h, --help             Show this help.

Credentials (environment only):
  INFERENCE_LENS_CONNECTION_<ID>_API_KEY    Key for one connection.
  INFERENCE_LENS_CONNECTION_<ID>_ENDPOINT   Optional endpoint override for it.
  INFERENCE_LENS_API_KEY, INFERENCE_LENS_API_ENDPOINT
                                            Key for any connection on that origin.
  <ID> is the connection ID without its "connection_" prefix, upper-cased,
  with every other character replaced by "_".

Tool catalogs (environment only; what --allow-tool may name):
  INFERENCE_LENS_COMMAND_TOOLS   Path to the command catalog.
  INFERENCE_LENS_MCP_SERVERS     Path to the MCP server catalog.

Exit codes:
  0  run: every case that ran passed. repeat: every repetition completed.
  1  It ran to completion, and a case failed (run) or a repetition failed
     other than by rate limiting (repeat).
  2  Usage or setup error. Nothing was sent and no plan was written.
  3  The run started but did not complete, or its only shortfall was rate
     limiting.
`;

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  environment: Readonly<Record<string, string | undefined>>;
  /** Registers a handler for an interrupt; returns its removal. */
  onInterrupt?(handler: () => void): () => void;
}

const SHARED_OPTIONS = {
  "no-auth": { type: "string", multiple: true },
  concurrency: { type: "string" },
  "connection-concurrency": { type: "string", multiple: true },
  "allow-tool": { type: "string", multiple: true },
  "retry-rate-limits": { type: "boolean", default: false },
  json: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
} as const;

const RUN_OPTIONS = {
  ...SHARED_OPTIONS,
  suite: { type: "string" },
  case: { type: "string", multiple: true },
  configuration: { type: "string", multiple: true },
} as const;

const REPEAT_OPTIONS = {
  ...SHARED_OPTIONS,
  repetitions: { type: "string" },
  "response-mode": { type: "string" },
} as const;

type Outcome = { exitCode: number; error?: string; summary?: unknown };

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  // The command decides which options exist, so a flag that belongs to the
  // other command is refused rather than silently ignored.
  const command = argv[0]?.startsWith("-") ? undefined : argv[0];
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: command === "repeat" ? REPEAT_OPTIONS : command === "run" ? RUN_OPTIONS : SHARED_OPTIONS,
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
  const [, projectFolder, ...extra] = positionals;
  if ((command !== "run" && command !== "repeat") || !projectFolder || extra.length > 0) {
    io.stderr(`${command && command !== "run" && command !== "repeat" ? `Unknown command "${command}".\n\n` : ""}${USAGE}`);
    return EXIT_SETUP;
  }

  let shared: HeadlessRunOptions;
  try {
    shared = {
      projectDirectory: projectFolder,
      noAuth: new Set(values["no-auth"] ?? []),
      concurrency: parseConcurrency(values.concurrency, values["connection-concurrency"] ?? []),
      toolGrants: parseToolGrants(values["allow-tool"] ?? []),
      retryRateLimits: values["retry-rate-limits"],
      environment: io.environment,
      transport: createInProcessTransport({ containerized: isContainerizedProcess(io.environment) }),
      onProgress: (line) => io.stderr(`${line}\n`),
    };
  } catch (error) {
    io.stderr(`inference-lens: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_SETUP;
  }

  let run: HeadlessRun<Outcome>;
  let format: (summary: never) => string;
  if (command === "repeat") {
    const repeatValues = values as { repetitions?: string; "response-mode"?: string };
    let repetitions: number | undefined;
    let responseMode: "streaming" | "buffered" | undefined;
    try {
      repetitions = parseRepetitions(repeatValues.repetitions);
      responseMode = parseResponseMode(repeatValues["response-mode"]);
    } catch (error) {
      io.stderr(`inference-lens: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_SETUP;
    }
    run = startHeadlessRepeat({
      ...shared,
      ...(repetitions === undefined ? {} : { repetitions }),
      ...(responseMode === undefined ? {} : { responseMode }),
    });
    format = formatHeadlessRepeatedSummary;
  } else {
    const runValues = values as { suite?: string; case?: string[]; configuration?: string[] };
    run = startHeadlessEvaluation({
      ...shared,
      ...(runValues.suite === undefined ? {} : { suite: runValues.suite }),
      ...(runValues.case === undefined ? {} : { cases: runValues.case }),
      ...(runValues.configuration === undefined ? {} : { configurations: runValues.configuration }),
    });
    format = formatHeadlessSummary;
  }

  const limit = shared.concurrency?.limit ?? 1;
  let interrupts = 0;
  const removeInterrupt = io.onInterrupt?.(() => {
    interrupts += 1;
    if (interrupts === 1) {
      io.stderr(
        `Stopping after the current ${limit > 1 ? "requests" : "request"}. Interrupt again to quit immediately.\n`,
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
    else io.stdout(format(outcome.summary as never));
  }
  return outcome.exitCode;
}

function parseRepetitions(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const count = positiveWholeNumber(value);
  if (count === undefined || count < MIN_REPETITION_COUNT || count > MAX_REPETITION_COUNT) {
    throw new Error(`--repetitions must be a whole number from ${MIN_REPETITION_COUNT} to ${MAX_REPETITION_COUNT}, not "${value}".`);
  }
  return count;
}

function parseResponseMode(value: string | undefined): "streaming" | "buffered" | undefined {
  if (value === undefined || value === "streaming" || value === "buffered") return value;
  throw new Error(`--response-mode must be streaming or buffered, not "${value}".`);
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
