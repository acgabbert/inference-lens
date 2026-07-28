import { z } from "zod";

import type {
  JsonObject,
  JsonValue,
  ToolDefinition,
  ToolId,
} from "./run-kernel/types.ts";

export const TOOL_REGISTRY_SCHEMA_VERSION = 1;
export const TOOL_REGISTRY_FILE_NAME = "tool-registry.json";

export type RegistryToolId = `registry-tool_${string}`;
/**
 * Host-issued compare-and-swap token. Consumers must preserve and return this
 * value without deriving meaning from its contents.
 */
export type ToolRegistryRevision = string;

export interface RegistryTool {
  id: RegistryToolId;
  name: string;
  description?: string;
  inputSchema: JsonObject;
  providerOptions?: JsonObject;
  createdAt: string;
  updatedAt: string;
}

export interface ToolRegistryV1 {
  schemaVersion: 1;
  tools: RegistryTool[];
}

/**
 * A null revision represents a registry that does not exist yet. This is
 * intentionally distinct from an existing, empty registry so legacy clients
 * can migrate with create-only compare-and-swap semantics.
 */
export interface ToolRegistrySnapshot {
  registry: ToolRegistryV1;
  revision: ToolRegistryRevision | null;
}

/**
 * Provider-neutral persistence boundary implemented by the web and native
 * hosts. `replace` must be atomic and refuse the write when `expectedRevision`
 * no longer matches the host's current revision.
 */
export interface ToolRegistryStore {
  load(): Promise<ToolRegistrySnapshot>;
  replace(
    registry: ToolRegistryV1,
    expectedRevision: ToolRegistryRevision | null,
  ): Promise<ToolRegistrySnapshot>;
}

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const jsonObjectSchema = z.record(
  z.string(),
  jsonValueSchema,
) as z.ZodType<JsonObject>;

const registryToolSchema: z.ZodType<RegistryTool> = z
  .object({
    id: z
      .string()
      .regex(/^registry-tool_.+/, 'Expected an identifier beginning with "registry-tool_".')
      .transform((value) => value as RegistryToolId),
    name: z.string().trim().min(1),
    description: z.string().optional(),
    inputSchema: jsonObjectSchema,
    providerOptions: jsonObjectSchema.optional(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

const toolRegistrySchema: z.ZodType<ToolRegistryV1> = z
  .object({
    schemaVersion: z.literal(TOOL_REGISTRY_SCHEMA_VERSION),
    tools: z.array(registryToolSchema),
  })
  .strict()
  .superRefine((registry, context) => {
    const ids = new Set<string>();
    const sensitiveFieldNames = new Set([
      "apikey",
      "authorization",
      "cookie",
      "setcookie",
      "accesstoken",
      "refreshtoken",
      "password",
      "secret",
      "clientsecret",
    ]);

    function rejectSensitiveFields(
      value: JsonValue | undefined,
      path: Array<string | number>,
    ): void {
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      Object.entries(value).forEach(([key, item]) => {
        const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
        if (sensitiveFieldNames.has(normalized)) {
          context.addIssue({
            code: "custom",
            path: [...path, key],
            message: "Secret-bearing fields are not valid registry data.",
          });
        } else {
          rejectSensitiveFields(item, [...path, key]);
        }
      });
    }

    registry.tools.forEach((tool, index) => {
      if (ids.has(tool.id)) {
        context.addIssue({
          code: "custom",
          path: ["tools", index, "id"],
          message: `Duplicate registry tool identifier "${tool.id}".`,
        });
      }
      ids.add(tool.id);
      rejectSensitiveFields(tool.providerOptions, [
        "tools",
        index,
        "providerOptions",
      ]);
    });
  });

export class ToolRegistryValidationError extends Error {
  readonly issues: z.core.$ZodIssue[];

  constructor(issues: z.core.$ZodIssue[]) {
    const summary = issues
      .slice(0, 3)
      .map(({ path, message }) => `${path.join(".") || "registry"}: ${message}`)
      .join("; ");
    super(`Invalid Inference Lens tool registry. ${summary}`);
    this.name = "ToolRegistryValidationError";
    this.issues = issues;
  }
}

export class ToolRegistryConflictError extends Error {
  readonly expectedRevision: ToolRegistryRevision | null;
  readonly actualRevision: ToolRegistryRevision | null;

  constructor(
    expectedRevision: ToolRegistryRevision | null,
    actualRevision: ToolRegistryRevision | null,
  ) {
    super(
      "The tool registry changed after it was loaded. Reload it before saving.",
    );
    this.name = "ToolRegistryConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export function emptyToolRegistry(): ToolRegistryV1 {
  return { schemaVersion: TOOL_REGISTRY_SCHEMA_VERSION, tools: [] };
}

/**
 * Best-effort parser retained for the legacy browser-local registry. New host
 * persistence must use `parseToolRegistryFile` or `parseToolRegistryJson` so a
 * corrupt file is surfaced instead of silently replaced with an empty value.
 */
export function parseToolRegistry(value: unknown): ToolRegistryV1 {
  const parsed = toolRegistrySchema.safeParse(value);
  return parsed.success ? parsed.data : emptyToolRegistry();
}

export function parseToolRegistryFile(value: unknown): ToolRegistryV1 {
  const parsed = toolRegistrySchema.safeParse(value);
  if (!parsed.success) {
    throw new ToolRegistryValidationError(parsed.error.issues);
  }
  return parsed.data;
}

export function parseToolRegistryJson(contents: string): ToolRegistryV1 {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new ToolRegistryValidationError([
      {
        code: "custom",
        path: [],
        message: "File is not valid JSON.",
      },
    ]);
  }
  return parseToolRegistryFile(value);
}

const preferredFieldOrder = new Map(
  [
    "schemaVersion",
    "tools",
    "id",
    "name",
    "description",
    "inputSchema",
    "providerOptions",
    "createdAt",
    "updatedAt",
  ].map((field, index) => [field, index]),
);

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => {
        const leftOrder = preferredFieldOrder.get(left);
        const rightOrder = preferredFieldOrder.get(right);
        if (leftOrder !== undefined || rightOrder !== undefined) {
          return (
            (leftOrder ?? Number.MAX_SAFE_INTEGER) -
            (rightOrder ?? Number.MAX_SAFE_INTEGER)
          );
        }
        return left.localeCompare(right);
      })
      .map(([key, item]) => [key, stableJsonValue(item)]),
  );
}

export function serializeToolRegistry(registry: ToolRegistryV1): string {
  const validated = parseToolRegistryFile(registry);
  return `${JSON.stringify(stableJsonValue(validated), null, 2)}\n`;
}

export function createRegistryTool(
  id: RegistryToolId,
  now: string,
  index: number,
): RegistryTool {
  return {
    id,
    name: `tool_${index + 1}`,
    description: "",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    createdAt: now,
    updatedAt: now,
  };
}

/** Create a detached snapshot suitable for a project or one resolved run. */
export function snapshotRegistryTool(
  source: RegistryTool,
  id: ToolId,
): ToolDefinition {
  return {
    id,
    name: source.name,
    ...(source.description === undefined
      ? {}
      : { description: source.description }),
    inputSchema: structuredClone(source.inputSchema),
    ...(source.providerOptions === undefined
      ? {}
      : { providerOptions: structuredClone(source.providerOptions) }),
  };
}
