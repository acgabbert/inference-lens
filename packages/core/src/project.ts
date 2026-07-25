import { z } from "zod";

import type {
  ConnectionRequirementId,
  ConversationId,
  ConversationMessage,
  ConversationRevision,
  ConversationRevisionId,
  InferenceOptions,
  JsonObject,
  JsonValue,
  MessageContentPart,
  ProjectId,
  PromptTemplateId,
  PromptTemplateRevisionId,
  ToolDefinition,
  ToolId,
  ToolMockId,
} from "./run-kernel/types.ts";
import { createEntityId } from "./run-kernel/types.ts";
import type {
  InferenceMessage,
  InferenceRequest,
  ProviderCapabilityOverrides,
} from "./types.ts";

export const PROJECT_FILE_NAME = "trace-lens.project.json";
export const PROJECT_SCHEMA_VERSION = 2;

export interface ConnectionRequirement {
  id: ConnectionRequirementId;
  name: string;
  provider: "openai-compatible";
  protocol: "openai-compatible-chat-completions";
  endpoint: string;
  capabilityOverrides?: ProviderCapabilityOverrides;
}

export interface ProjectConversation {
  id: ConversationId;
  name: string;
}

export interface ToolMockResultTemplate {
  content: MessageContentPart[];
  isError?: boolean;
}

/**
 * A project-owned replacement for a real tool execution. It controls the
 * result value only; tool exposure and run stepping are separate decisions.
 */
export interface ToolMock {
  id: ToolMockId;
  toolId: ToolId;
  name: string;
  enabled: boolean;
  match: { kind: "always" };
  result: ToolMockResultTemplate;
}

export type PromptTemplateContent =
  | { kind: "fragment"; text: string }
  | {
      kind: "messages";
      messages: Array<{
        role: "system" | "user" | "assistant";
        content: string;
      }>;
    };

export interface PromptTemplateRevision {
  id: PromptTemplateRevisionId;
  createdAt: string;
  content: PromptTemplateContent;
  variableDefaults: Record<string, string>;
}

export interface PromptTemplate {
  id: PromptTemplateId;
  name: string;
  currentRevisionId: PromptTemplateRevisionId;
  revisions: PromptTemplateRevision[];
}

export interface ProjectDefaults {
  conversationRevisionId: ConversationRevisionId;
  target: {
    connectionRequirementId: ConnectionRequirementId;
    model: string;
  };
  options: InferenceOptions;
  enabledToolIds: ToolId[];
}

/**
 * Portable, credential-free project definition. Run traces and shell-local
 * selections deliberately live outside this document.
 */
export interface ProjectFileV2 {
  schemaVersion: 2;
  projectId: ProjectId;
  name: string;
  connectionRequirements: ConnectionRequirement[];
  conversations: ProjectConversation[];
  conversationRevisions: ConversationRevision[];
  tools: ToolDefinition[];
  toolMocks: ToolMock[];
  promptTemplates: PromptTemplate[];
  defaults: ProjectDefaults;
}

const entityId = <Kind extends Parameters<typeof createEntityId>[0]>(
  kind: Kind,
) =>
  z
    .string()
    .regex(
      new RegExp(`^${kind}_.+`),
      `Expected an identifier beginning with "${kind}_".`,
    )
    .transform((value) => value as `${Kind}_${string}`);

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

const jsonObjectSchema = z.record(z.string(), jsonValueSchema) as z.ZodType<JsonObject>;

const capabilityOverridesSchema = z
  .object({
    chatCompletions: z.boolean().optional(),
    responsesApi: z.boolean().optional(),
    streaming: z.boolean().optional(),
    modelDiscovery: z.boolean().optional(),
    tools: z.boolean().optional(),
    parallelToolCalls: z.boolean().optional(),
    structuredOutput: z.boolean().optional(),
    vision: z.boolean().optional(),
    embeddings: z.boolean().optional(),
  })
  .strict();

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

function normalizedFieldName(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function endpointHasCredentials(value: string): boolean {
  try {
    const endpoint = new URL(value);
    return (
      Boolean(endpoint.username || endpoint.password) ||
      [...endpoint.searchParams.keys()].some((key) =>
        sensitiveFieldNames.has(normalizedFieldName(key)),
      )
    );
  } catch {
    return false;
  }
}

const contentPartSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .strict();

const toolCallSchema = z
  .object({
    id: entityId("tool-call"),
    providerCallId: z.string().optional(),
    name: z.string(),
    arguments: z
      .object({
        text: z.string(),
        parsed: jsonObjectSchema.optional(),
      })
      .strict(),
  })
  .strict();

const messageBase = {
  id: entityId("message"),
  content: z.array(contentPartSchema),
};

const conversationMessageSchema: z.ZodType<ConversationMessage> =
  z.discriminatedUnion("role", [
    z.object({ ...messageBase, role: z.literal("system") }).strict(),
    z.object({ ...messageBase, role: z.literal("user") }).strict(),
    z
      .object({
        ...messageBase,
        role: z.literal("assistant"),
        toolCalls: z.array(toolCallSchema).optional(),
      })
      .strict(),
    z
      .object({
        ...messageBase,
        role: z.literal("tool"),
        toolCallId: entityId("tool-call"),
        name: z.string().optional(),
      })
      .strict(),
  ]);

const inferenceOptionsSchema: z.ZodType<InferenceOptions> = z
  .object({
    temperature: z.number().finite().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    seed: z.number().int().optional(),
    stop: z.array(z.string()).optional(),
    providerOptions: jsonObjectSchema.optional(),
  })
  .strict();

const connectionRequirementSchema: z.ZodType<ConnectionRequirement> = z
  .object({
    id: entityId("connection"),
    name: z.string().trim().min(1),
    provider: z.literal("openai-compatible"),
    protocol: z.literal("openai-compatible-chat-completions"),
    endpoint: z
      .url()
      .refine(
        (value) => value.startsWith("https://") || value.startsWith("http://"),
        "Endpoint must use HTTP or HTTPS.",
      )
      .refine(
        (value) => !endpointHasCredentials(value),
        "Endpoint must not contain credentials or secret query parameters.",
      ),
    capabilityOverrides: capabilityOverridesSchema.optional(),
  })
  .strict();

const projectConversationSchema: z.ZodType<ProjectConversation> = z
  .object({
    id: entityId("conversation"),
    name: z.string().trim().min(1),
  })
  .strict();

const conversationRevisionSchema: z.ZodType<ConversationRevision> = z
  .object({
    id: entityId("revision"),
    conversationId: entityId("conversation"),
    parentRevisionId: entityId("revision").optional(),
    messages: z.array(conversationMessageSchema),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();

const toolDefinitionSchema: z.ZodType<ToolDefinition> = z
  .object({
    id: entityId("tool"),
    name: z.string().trim().min(1),
    description: z.string().optional(),
    inputSchema: jsonObjectSchema,
    providerOptions: jsonObjectSchema.optional(),
  })
  .strict();

const toolMockSchema: z.ZodType<ToolMock> = z
  .object({
    id: entityId("tool-mock"),
    toolId: entityId("tool"),
    name: z.string().trim().min(1),
    enabled: z.boolean(),
    match: z.object({ kind: z.literal("always") }).strict(),
    result: z
      .object({
        content: z.array(contentPartSchema),
        isError: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

const variableName = /^[A-Za-z_][A-Za-z0-9_]*$/;

const promptTemplateRevisionSchema: z.ZodType<PromptTemplateRevision> = z
  .object({
    id: entityId("template-revision"),
    createdAt: z.iso.datetime({ offset: true }),
    content: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("fragment"), text: z.string() }).strict(),
      z
        .object({
          kind: z.literal("messages"),
          messages: z.array(
            z
              .object({
                role: z.enum(["system", "user", "assistant"]),
                content: z.string(),
              })
              .strict(),
          ),
        })
        .strict(),
    ]),
    variableDefaults: z.record(
      z.string().regex(variableName, "Invalid template variable name."),
      z.string(),
    ),
  })
  .strict();

const promptTemplateSchema: z.ZodType<PromptTemplate> = z
  .object({
    id: entityId("template"),
    name: z.string().trim().min(1),
    currentRevisionId: entityId("template-revision"),
    revisions: z.array(promptTemplateRevisionSchema).min(1),
  })
  .strict();

const projectFileV2Schema: z.ZodType<ProjectFileV2> = z
  .object({
    schemaVersion: z.literal(PROJECT_SCHEMA_VERSION),
    projectId: entityId("project"),
    name: z.string().trim().min(1),
    connectionRequirements: z.array(connectionRequirementSchema).min(1),
    conversations: z.array(projectConversationSchema).min(1),
    conversationRevisions: z.array(conversationRevisionSchema).min(1),
    tools: z.array(toolDefinitionSchema),
    toolMocks: z.array(toolMockSchema),
    promptTemplates: z.array(promptTemplateSchema),
    defaults: z
      .object({
        conversationRevisionId: entityId("revision"),
        target: z
          .object({
            connectionRequirementId: entityId("connection"),
            model: z.string().trim().min(1),
          })
          .strict(),
        options: inferenceOptionsSchema,
        enabledToolIds: z.array(entityId("tool")),
      })
      .strict(),
  })
  .strict()
  .superRefine(validateProjectReferences);

function addDuplicateIssues(
  values: string[],
  path: Array<string | number>,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      context.addIssue({
        code: "custom",
        path: [...path, index],
        message: `Duplicate identifier "${value}".`,
      });
    }
    seen.add(value);
  });
}

function requireReference(
  exists: boolean,
  path: Array<string | number>,
  message: string,
  context: z.RefinementCtx,
): void {
  if (!exists) context.addIssue({ code: "custom", path, message });
}

function validateProjectReferences(
  project: ProjectFileV2,
  context: z.RefinementCtx,
): void {
  addDuplicateIssues(
    project.connectionRequirements.map(({ id }) => id),
    ["connectionRequirements"],
    context,
  );
  addDuplicateIssues(
    project.conversations.map(({ id }) => id),
    ["conversations"],
    context,
  );
  addDuplicateIssues(
    project.conversationRevisions.map(({ id }) => id),
    ["conversationRevisions"],
    context,
  );
  addDuplicateIssues(
    project.tools.map(({ id }) => id),
    ["tools"],
    context,
  );
  addDuplicateIssues(
    project.tools.map(({ name }) => name),
    ["tools"],
    context,
  );
  addDuplicateIssues(
    project.toolMocks.map(({ id }) => id),
    ["toolMocks"],
    context,
  );
  addDuplicateIssues(
    project.promptTemplates.map(({ id }) => id),
    ["promptTemplates"],
    context,
  );

  const connectionIds = new Set(
    project.connectionRequirements.map(({ id }) => id),
  );
  const conversationIds = new Set(project.conversations.map(({ id }) => id));
  const revisions = new Map(
    project.conversationRevisions.map((revision) => [revision.id, revision]),
  );
  const toolIds = new Set(project.tools.map(({ id }) => id));

  function rejectSensitiveFields(
    value: JsonValue | undefined,
    path: Array<string | number>,
  ): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    Object.entries(value).forEach(([key, item]) => {
      if (sensitiveFieldNames.has(normalizedFieldName(key))) {
        context.addIssue({
          code: "custom",
          path: [...path, key],
          message: "Secret-bearing fields are not portable project data.",
        });
      } else {
        rejectSensitiveFields(item, [...path, key]);
      }
    });
  }

  rejectSensitiveFields(project.defaults.options.providerOptions, [
    "defaults",
    "options",
    "providerOptions",
  ]);
  project.tools.forEach((tool, index) =>
    rejectSensitiveFields(tool.providerOptions, [
      "tools",
      index,
      "providerOptions",
    ]),
  );

  requireReference(
    connectionIds.has(project.defaults.target.connectionRequirementId),
    ["defaults", "target", "connectionRequirementId"],
    "Default target references an unknown connection requirement.",
    context,
  );
  requireReference(
    revisions.has(project.defaults.conversationRevisionId),
    ["defaults", "conversationRevisionId"],
    "Default conversation revision does not exist.",
    context,
  );

  project.defaults.enabledToolIds.forEach((id, index) =>
    requireReference(
      toolIds.has(id),
      ["defaults", "enabledToolIds", index],
      `Enabled tool "${id}" does not exist.`,
      context,
    ),
  );
  addDuplicateIssues(
    project.defaults.enabledToolIds,
    ["defaults", "enabledToolIds"],
    context,
  );

  project.conversationRevisions.forEach((revision, index) => {
    requireReference(
      conversationIds.has(revision.conversationId),
      ["conversationRevisions", index, "conversationId"],
      `Revision references unknown conversation "${revision.conversationId}".`,
      context,
    );
    if (revision.parentRevisionId) {
      const parent = revisions.get(revision.parentRevisionId);
      requireReference(
        Boolean(parent),
        ["conversationRevisions", index, "parentRevisionId"],
        `Parent revision "${revision.parentRevisionId}" does not exist.`,
        context,
      );
      if (parent && parent.conversationId !== revision.conversationId) {
        context.addIssue({
          code: "custom",
          path: ["conversationRevisions", index, "parentRevisionId"],
          message: "Parent revision belongs to a different conversation.",
        });
      }
    }
  });

  project.toolMocks.forEach((mock, index) =>
    requireReference(
      toolIds.has(mock.toolId),
      ["toolMocks", index, "toolId"],
      `Tool mock references unknown tool "${mock.toolId}".`,
      context,
    ),
  );

  const templateRevisionIds = new Set<string>();
  project.promptTemplates.forEach((template, templateIndex) => {
    const localRevisionIds = new Set(
      template.revisions.map(({ id }) => id),
    );
    requireReference(
      localRevisionIds.has(template.currentRevisionId),
      ["promptTemplates", templateIndex, "currentRevisionId"],
      "Current template revision does not belong to this template.",
      context,
    );
    template.revisions.forEach((revision, revisionIndex) => {
      Object.keys(revision.variableDefaults).forEach((name) => {
        if (sensitiveFieldNames.has(normalizedFieldName(name))) {
          context.addIssue({
            code: "custom",
            path: [
              "promptTemplates",
              templateIndex,
              "revisions",
              revisionIndex,
              "variableDefaults",
              name,
            ],
            message: "Secret values cannot have portable template defaults.",
          });
        }
      });
      if (templateRevisionIds.has(revision.id)) {
        context.addIssue({
          code: "custom",
          path: [
            "promptTemplates",
            templateIndex,
            "revisions",
            revisionIndex,
            "id",
          ],
          message: `Duplicate identifier "${revision.id}".`,
        });
      }
      templateRevisionIds.add(revision.id);
    });
  });
}

export class ProjectValidationError extends Error {
  readonly issues: z.core.$ZodIssue[];

  constructor(issues: z.core.$ZodIssue[]) {
    const summary = issues
      .slice(0, 3)
      .map(({ path, message }) => `${path.join(".") || "project"}: ${message}`)
      .join("; ");
    super(`Invalid Trace Lens project. ${summary}`);
    this.name = "ProjectValidationError";
    this.issues = issues;
  }
}

export function parseProjectFile(value: unknown): ProjectFileV2 {
  const parsed = projectFileV2Schema.safeParse(value);
  if (!parsed.success) throw new ProjectValidationError(parsed.error.issues);
  return parsed.data;
}

const preferredFieldOrder = new Map(
  [
    "schemaVersion",
    "projectId",
    "name",
    "connectionRequirements",
    "conversations",
    "conversationRevisions",
    "tools",
    "toolMocks",
    "promptTemplates",
    "defaults",
    "id",
    "provider",
    "protocol",
    "endpoint",
    "capabilityOverrides",
    "conversationId",
    "parentRevisionId",
    "messages",
    "createdAt",
    "role",
    "content",
    "text",
    "description",
    "inputSchema",
    "providerOptions",
    "toolId",
    "enabled",
    "match",
    "result",
    "isError",
    "currentRevisionId",
    "revisions",
    "variableDefaults",
    "conversationRevisionId",
    "target",
    "connectionRequirementId",
    "model",
    "options",
    "enabledToolIds",
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

export function serializeProjectFile(project: ProjectFileV2): string {
  const validated = parseProjectFile(project);
  return `${JSON.stringify(stableJsonValue(validated), null, 2)}\n`;
}

export function parseProjectJson(text: string): ProjectFileV2 {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProjectValidationError([
      {
        code: "custom",
        path: [],
        message: "File is not valid JSON.",
      },
    ]);
  }
  return parseProjectFile(value);
}

export interface ProjectDraft {
  connectionRequirement: ConnectionRequirement;
  messages: InferenceMessage[];
  model: string;
  temperature?: number;
  tools: ToolDefinition[];
  toolMocks: ToolMock[];
  enabledToolIds: ToolId[];
}

export interface UpdateProjectDraft {
  messages: InferenceMessage[];
  model: string;
  temperature?: number;
  tools: ToolDefinition[];
  toolMocks: ToolMock[];
  enabledToolIds: ToolId[];
}

function messageText(message: ConversationMessage): string {
  return message.content
    .filter((part): part is MessageContentPart => part.type === "text")
    .map(({ text }) => text)
    .join("");
}

export function projectDraft(project: ProjectFileV2): ProjectDraft {
  const revision = project.conversationRevisions.find(
    ({ id }) => id === project.defaults.conversationRevisionId,
  );
  const connectionRequirement = project.connectionRequirements.find(
    ({ id }) => id === project.defaults.target.connectionRequirementId,
  );
  if (!revision || !connectionRequirement) {
    throw new ProjectValidationError([
      {
        code: "custom",
        path: ["defaults"],
        message: "Project defaults are incomplete.",
      },
    ]);
  }
  return {
    connectionRequirement,
    messages: revision.messages.map((message) => ({
      role: message.role,
      content: messageText(message),
    })),
    model: project.defaults.target.model,
    temperature: project.defaults.options.temperature,
    tools: project.tools,
    toolMocks: project.toolMocks,
    enabledToolIds: project.defaults.enabledToolIds,
  };
}

/**
 * Updates the active authored draft without touching project-owned tools,
 * mocks, templates, other conversations, or connection requirements.
 */
export function updateProjectDraft(
  project: ProjectFileV2,
  draft: UpdateProjectDraft,
  idSuffix: string = crypto.randomUUID(),
): ProjectFileV2 {
  const activeRevisionIndex = project.conversationRevisions.findIndex(
    ({ id }) => id === project.defaults.conversationRevisionId,
  );
  if (activeRevisionIndex < 0) return parseProjectFile(project);
  const activeRevision = project.conversationRevisions[activeRevisionIndex];
  const messages = draft.messages.map((message, index): ConversationMessage => {
    const existing = activeRevision.messages[index];
    const base = {
      id:
        existing?.id ??
        createEntityId("message", `${idSuffix}-draft-${index}`),
      content: [{ type: "text" as const, text: message.content }],
    };
    switch (message.role) {
      case "system":
        return { ...base, role: "system" };
      case "user":
        return { ...base, role: "user" };
      case "assistant":
        return {
          ...base,
          role: "assistant",
          ...(existing?.role === "assistant" && existing.toolCalls
            ? { toolCalls: existing.toolCalls }
            : {}),
        };
      case "tool":
        return {
          ...base,
          role: "tool",
          toolCallId:
            existing?.role === "tool"
              ? existing.toolCallId
              : createEntityId("tool-call", `${idSuffix}-draft-${index}`),
          ...(existing?.role === "tool" && existing.name
            ? { name: existing.name }
            : {}),
        };
    }
  });
  const conversationRevisions = [...project.conversationRevisions];
  conversationRevisions[activeRevisionIndex] = {
    ...activeRevision,
    messages,
  };
  return parseProjectFile({
    ...project,
    tools: draft.tools,
    toolMocks: draft.toolMocks,
    conversationRevisions,
    defaults: {
      ...project.defaults,
      target: {
        ...project.defaults.target,
        model: draft.model,
      },
      options: {
        ...project.defaults.options,
        ...(draft.temperature === undefined
          ? { temperature: undefined }
          : { temperature: draft.temperature }),
      },
      enabledToolIds: draft.enabledToolIds,
    },
  });
}

export interface CreateProjectOptions {
  name: string;
  request: InferenceRequest;
  idSuffix?: string;
  createdAt?: string;
}

export function createProjectFile({
  name,
  request,
  idSuffix = crypto.randomUUID(),
  createdAt = new Date().toISOString(),
}: CreateProjectOptions): ProjectFileV2 {
  const projectId = createEntityId("project", idSuffix);
  const connectionId = createEntityId("connection", `${idSuffix}-default`);
  const conversationId = createEntityId("conversation", `${idSuffix}-default`);
  const revisionId = createEntityId("revision", `${idSuffix}-initial`);
  const project: ProjectFileV2 = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    projectId,
    name: name.trim() || "Untitled Trace Lens project",
    connectionRequirements: [
      {
        id: connectionId,
        name: "Default connection",
        provider: request.provider,
        protocol: "openai-compatible-chat-completions",
        endpoint: request.endpoint,
        capabilityOverrides: request.capabilities,
      },
    ],
    conversations: [
      {
        id: conversationId,
        name: "Main conversation",
      },
    ],
    conversationRevisions: [
      {
        id: revisionId,
        conversationId,
        messages: request.messages.map((message, index) => ({
          id: createEntityId("message", `${idSuffix}-${index}`),
          role: message.role,
          content: [{ type: "text", text: message.content }],
          ...(message.role === "tool"
            ? {
                toolCallId: createEntityId(
                  "tool-call",
                  `${idSuffix}-imported-${index}`,
                ),
              }
            : {}),
        })) as ConversationMessage[],
        createdAt,
      },
    ],
    tools: [],
    toolMocks: [],
    promptTemplates: [],
    defaults: {
      conversationRevisionId: revisionId,
      target: {
        connectionRequirementId: connectionId,
        model: request.model,
      },
      options:
        request.temperature === undefined
          ? {}
          : { temperature: request.temperature },
      enabledToolIds: [],
    },
  };
  return parseProjectFile(project);
}
