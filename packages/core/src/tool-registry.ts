import { z } from "zod";

import type {
  JsonObject,
  JsonValue,
  ToolDefinition,
  ToolId,
} from "./run-kernel/types.ts";

export const TOOL_REGISTRY_SCHEMA_VERSION = 1;

export type RegistryToolId = `registry-tool_${string}`;

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

export function emptyToolRegistry(): ToolRegistryV1 {
  return { schemaVersion: TOOL_REGISTRY_SCHEMA_VERSION, tools: [] };
}

export function parseToolRegistry(value: unknown): ToolRegistryV1 {
  const parsed = toolRegistrySchema.safeParse(value);
  return parsed.success ? parsed.data : emptyToolRegistry();
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
