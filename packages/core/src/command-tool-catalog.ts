import { z } from "zod";

/**
 * The operator's declaration of what may be executed on this device.
 *
 * A command binding is device-local, and the executable path is the part of it
 * that must never be authored by the page: this service can be reached by
 * anyone who can load its UI, and the roadmap points straight at rendering
 * third-party MCP tool descriptions in the same window. So the catalog is a
 * ceiling rather than a convenience — a page can ask for a declared command by
 * id and nothing else, and the argument vector is fixed by whoever wrote the
 * file.
 *
 * Parsing lives in core because a misconfigured catalog has to be explained in
 * the UI, and the explanation is the same sentence in every shell.
 */

export const COMMAND_TOOL_CATALOG_SCHEMA_VERSION = 1;

/** Long enough for a local script, short enough that a hang is visible. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
export const MAX_COMMAND_TIMEOUT_MS = 600_000;

/**
 * Output above this is refused rather than truncated. A truncated JSON envelope
 * is undecodable anyway, and silently shortening a text result would hand the
 * model a sentence the tool never finished.
 */
export const DEFAULT_COMMAND_MAX_OUTPUT_BYTES = 1_048_576;
export const MAX_COMMAND_MAX_OUTPUT_BYTES = 16_777_216;

/**
 * How stdout is read.
 *
 * `json` is the contract a purpose-built tool should use: it is the only form
 * that can report a tool error, and the only one that can carry non-text
 * content. `text` exists so an existing script becomes a fixture with no
 * wrapper — it always completes successfully, which is exactly why it cannot
 * be the default.
 */
export type CommandResultFormat = "json" | "text";

export interface CommandToolDeclaration {
  /** Stable, operator-chosen, and the only part of a binding a page may send. */
  id: string;
  label: string;
  description?: string;
  /** Absolute, or relative to the catalog file's own directory. */
  executable: string;
  args: string[];
  timeoutMs: number;
  maxOutputBytes: number;
  resultFormat: CommandResultFormat;
}

export interface CommandToolCatalog {
  schemaVersion: typeof COMMAND_TOOL_CATALOG_SCHEMA_VERSION;
  commands: CommandToolDeclaration[];
}

export class CommandToolCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandToolCatalogError";
  }
}

const commandIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

const declarationSchema = z
  .object({
    id: z
      .string()
      .regex(
        commandIdPattern,
        "A command id may contain letters, digits, dot, dash, and underscore, and must not start with a separator.",
      ),
    label: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
    executable: z.string().trim().min(1, "A command needs an executable."),
    args: z.array(z.string()).optional(),
    timeoutMs: z.number().int().positive().max(MAX_COMMAND_TIMEOUT_MS).optional(),
    maxOutputBytes: z
      .number()
      .int()
      .positive()
      .max(MAX_COMMAND_MAX_OUTPUT_BYTES)
      .optional(),
    resultFormat: z.enum(["json", "text"]).optional(),
  })
  .strict();

const catalogSchema = z
  .object({
    schemaVersion: z.literal(COMMAND_TOOL_CATALOG_SCHEMA_VERSION),
    commands: z.array(declarationSchema),
  })
  .strict()
  .superRefine((catalog, context) => {
    const seen = new Set<string>();
    catalog.commands.forEach((command, index) => {
      if (seen.has(command.id)) {
        context.addIssue({
          code: "custom",
          path: ["commands", index, "id"],
          message: `Duplicate command id "${command.id}".`,
        });
      }
      seen.add(command.id);
    });
  });

function issueText(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

/**
 * Throws rather than falling back to an empty catalog.
 *
 * The project's other registries recover from unreadable data because losing a
 * malformed tool definition costs nothing. Here the file *is* the permission,
 * so a typo that silently disabled every command would read in the UI as "the
 * operator declared nothing" — and the operator would go looking in the wrong
 * place.
 */
export function parseCommandToolCatalog(value: unknown): CommandToolCatalog {
  const parsed = catalogSchema.safeParse(value);
  if (!parsed.success) {
    throw new CommandToolCatalogError(issueText(parsed.error));
  }
  return {
    schemaVersion: COMMAND_TOOL_CATALOG_SCHEMA_VERSION,
    commands: parsed.data.commands.map((command) => ({
      id: command.id,
      label: command.label ?? command.id,
      ...(command.description === undefined
        ? {}
        : { description: command.description }),
      executable: command.executable,
      args: command.args ?? [],
      timeoutMs: command.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      maxOutputBytes: command.maxOutputBytes ?? DEFAULT_COMMAND_MAX_OUTPUT_BYTES,
      resultFormat: command.resultFormat ?? "json",
    })),
  };
}

export function findCommandDeclaration(
  catalog: CommandToolCatalog,
  commandId: string,
): CommandToolDeclaration | undefined {
  return catalog.commands.find((command) => command.id === commandId);
}
