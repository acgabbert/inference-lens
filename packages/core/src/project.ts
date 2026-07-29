import { z } from "zod";

import {
  authoredPromptFieldSchema,
  expressionBindingSchema,
  externalInvocationRefSchema,
  externalPromptSourceSchema,
  importWarningSchema,
  validateAuthoredPromptBindings,
} from "./external-prompt-import.ts";
import type {
  AuthoredPromptField,
  ExpressionBinding,
  ExternalInvocationRef,
  ExternalPromptSource,
  ImportFidelity,
  ImportWarning,
} from "./external-prompt-import.ts";
import type {
  ConnectionRequirementId,
  ConversationId,
  ConversationMessage,
  ConversationRevisionId,
  ExternalImportId,
  InferenceOptions,
  JsonObject,
  JsonValue,
  MessageContentPart,
  MessageId,
  ProjectId,
  PromptTemplateId,
  PromptTemplateRevisionId,
  PromptTemplateUseId,
  ResolvedTemplateUse,
  ToolDefinition,
  ToolId,
  ToolMockId,
} from "./run-kernel/types.ts";
import { createEntityId } from "./run-kernel/types.ts";
import { randomUUID } from "./random-id.ts";
import {
  discoverTemplateVariables,
  renderTemplateContent,
  resolveTemplateValues,
} from "./template-engine.ts";
import type { TemplateDiagnostic } from "./template-engine.ts";
import type {
  InferenceRequest,
  RichInferenceRequest,
  ProviderCapabilityOverrides,
} from "./types.ts";

export const PROJECT_FILE_NAME = "inference-lens.project.json";
export const PROJECT_SCHEMA_VERSION = 5;

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

/**
 * A portable recommendation for the target a template was authored or verified
 * against. It never overrides the project/run target: one request may contain
 * several templates, while the provider accepts only one model.
 *
 * It belongs to the template rather than to a revision. Revisions are immutable
 * and uses pin them, so recording it per revision would make "I verified this
 * against another model" append a content-identical revision and unpin every
 * existing use.
 */
export interface PromptTemplateRecommendedTarget {
  connectionRequirementId: ConnectionRequirementId;
  model: string;
}

export interface PromptTemplateRevision {
  id: PromptTemplateRevisionId;
  createdAt: string;
  content: PromptTemplateContent;
  variableDefaults: Record<string, string>;
  externalImportId?: ExternalImportId;
}

export interface PromptTemplate {
  id: PromptTemplateId;
  name: string;
  currentRevisionId: PromptTemplateRevisionId;
  recommendedTarget?: PromptTemplateRecommendedTarget;
  revisions: PromptTemplateRevision[];
}

export interface PromptTemplateUse {
  id: PromptTemplateUseId;
  templateId: PromptTemplateId;
  templateRevisionId: PromptTemplateRevisionId;
  values: Record<string, string>;
  outputMessageIds: MessageId[];
  fragmentRole?: "system" | "user" | "assistant";
}

export type ProjectConversationItem =
  | {
      kind: "message";
      message: ConversationMessage;
      externalImportId?: ExternalImportId;
    }
  | {
      kind: "template-use";
      use: PromptTemplateUse;
    };

export interface ProjectConversationRevision {
  id: ConversationRevisionId;
  conversationId: ConversationId;
  parentRevisionId?: ConversationRevisionId;
  items: ProjectConversationItem[];
  createdAt: string;
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
 * Minimal durable provenance for imported literal messages. The selected
 * authored fields are retained for review; remote payloads, connection
 * details, credentials, and unrelated execution data are deliberately absent.
 */
export type ExternalImportProjection =
  | {
      kind: "literal-messages";
    }
  | {
      kind: "prompt-template";
      templateId: PromptTemplateId;
      templateRevisionId: PromptTemplateRevisionId;
      variables: Array<{
        bindingIndex: number;
        authoredPath: string;
        expression: string;
        variableName: string;
      }>;
    };

export interface ExternalImportReceipt {
  id: ExternalImportId;
  source: ExternalPromptSource;
  invocation: ExternalInvocationRef;
  authored: AuthoredPromptField[];
  bindings: ExpressionBinding[];
  importedAt: string;
  importerVersion: number;
  sourceDigest: string;
  fidelity: ImportFidelity;
  warnings: ImportWarning[];
  projection: ExternalImportProjection;
}

/**
 * Portable, credential-free project definition. Run traces and shell-local
 * selections deliberately live outside this document.
 */
interface ProjectReferenceValidationShape {
  projectId: ProjectId;
  name: string;
  connectionRequirements: ConnectionRequirement[];
  conversations: ProjectConversation[];
  conversationRevisions: Array<{
    id: ConversationRevisionId;
    conversationId: ConversationId;
    parentRevisionId?: ConversationRevisionId;
    messages: ConversationMessage[];
    createdAt: string;
  }>;
  tools: ToolDefinition[];
  toolMocks: ToolMock[];
  promptTemplates: PromptTemplate[];
  defaults: ProjectDefaults;
}

export interface ProjectFileV5 {
  schemaVersion: 5;
  projectId: ProjectId;
  name: string;
  connectionRequirements: ConnectionRequirement[];
  conversations: ProjectConversation[];
  conversationRevisions: ProjectConversationRevision[];
  tools: ToolDefinition[];
  toolMocks: ToolMock[];
  promptTemplates: PromptTemplate[];
  externalImports: ExternalImportReceipt[];
  defaults: ProjectDefaults;
}

export type ProjectFile = ProjectFileV5;

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

export function isSensitiveTemplateVariableName(value: string): boolean {
  return sensitiveFieldNames.has(normalizedFieldName(value));
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

const promptTemplateRecommendedTargetSchema: z.ZodType<PromptTemplateRecommendedTarget> =
  z
    .object({
      connectionRequirementId: entityId("connection"),
      model: z.string().trim().min(1),
    })
    .strict();

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
    externalImportId: entityId("external-import").optional(),
  })
  .strict();

const promptTemplateSchema: z.ZodType<PromptTemplate> = z
  .object({
    id: entityId("template"),
    name: z.string().trim().min(1),
    currentRevisionId: entityId("template-revision"),
    recommendedTarget: promptTemplateRecommendedTargetSchema.optional(),
    revisions: z.array(promptTemplateRevisionSchema).min(1),
  })
  .strict();

const promptTemplateUseSchema: z.ZodType<PromptTemplateUse> = z
  .object({
    id: entityId("template-use"),
    templateId: entityId("template"),
    templateRevisionId: entityId("template-revision"),
    values: z.record(
      z.string().regex(variableName, "Invalid template variable name."),
      z.string(),
    ),
    outputMessageIds: z.array(entityId("message")).min(1),
    fragmentRole: z.enum(["system", "user", "assistant"]).optional(),
  })
  .strict();

const projectConversationItemSchema: z.ZodType<ProjectConversationItem> =
  z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("message"),
        message: conversationMessageSchema,
        externalImportId: entityId("external-import").optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("template-use"),
        use: promptTemplateUseSchema,
      })
      .strict(),
  ]);

const projectConversationRevisionSchema: z.ZodType<ProjectConversationRevision> =
  z
    .object({
      id: entityId("revision"),
      conversationId: entityId("conversation"),
      parentRevisionId: entityId("revision").optional(),
      items: z.array(projectConversationItemSchema),
      createdAt: z.iso.datetime({ offset: true }),
    })
    .strict();

const externalImportReceiptSchema: z.ZodType<ExternalImportReceipt> = z
  .object({
    id: entityId("external-import"),
    source: externalPromptSourceSchema,
    invocation: externalInvocationRefSchema,
    authored: z.array(authoredPromptFieldSchema).min(1),
    bindings: z.array(expressionBindingSchema),
    importedAt: z.iso.datetime({ offset: true }),
    importerVersion: z.number().int().positive(),
    sourceDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/, "Expected a lowercase SHA-256 digest."),
    fidelity: z.enum([
      "provider-evidence",
      "execution-reconstructed",
      "authored-only",
    ]),
    warnings: z.array(importWarningSchema),
    projection: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("literal-messages") }).strict(),
      z
        .object({
          kind: z.literal("prompt-template"),
          templateId: entityId("template"),
          templateRevisionId: entityId("template-revision"),
          variables: z.array(
            z
              .object({
                bindingIndex: z.number().int().nonnegative(),
                authoredPath: z.string().trim().min(1),
                expression: z.string(),
                variableName: z.string().regex(variableName),
              })
              .strict(),
          ),
        })
        .strict(),
    ]),
  })
  .strict()
  .superRefine((receipt, context) => {
    validateAuthoredPromptBindings(receipt, context);
    if (receipt.projection.kind !== "prompt-template") return;
    if (receipt.projection.variables.length !== receipt.bindings.length) {
      context.addIssue({
        code: "custom",
        path: ["projection", "variables"],
        message:
          "Template projection must map every external expression binding.",
      });
    }
    const seenBindingIndexes = new Set<number>();
    receipt.projection.variables.forEach((variable, index) => {
      const binding = receipt.bindings[variable.bindingIndex];
      if (seenBindingIndexes.has(variable.bindingIndex)) {
        context.addIssue({
          code: "custom",
          path: ["projection", "variables", index, "bindingIndex"],
          message: "Template projection binding indexes must be unique.",
        });
      }
      seenBindingIndexes.add(variable.bindingIndex);
      if (
        !binding ||
        binding.authoredPath !== variable.authoredPath ||
        binding.expression !== variable.expression
      ) {
        context.addIssue({
          code: "custom",
          path: ["projection", "variables", index],
          message:
            "Template projection variable does not match its external binding.",
        });
      }
    });
  });

const projectFileV5Schema: z.ZodType<ProjectFileV5> = z
  .object({
    schemaVersion: z.literal(PROJECT_SCHEMA_VERSION),
    projectId: entityId("project"),
    name: z.string().trim().min(1),
    connectionRequirements: z.array(connectionRequirementSchema).min(1),
    conversations: z.array(projectConversationSchema).min(1),
    conversationRevisions: z.array(projectConversationRevisionSchema).min(1),
    tools: z.array(toolDefinitionSchema),
    toolMocks: z.array(toolMockSchema),
    promptTemplates: z.array(promptTemplateSchema),
    externalImports: z.array(externalImportReceiptSchema),
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

function validateSharedProjectReferences(
  project: ProjectReferenceValidationShape,
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

function validateProjectReferences(
  project: ProjectFileV5,
  context: z.RefinementCtx,
): void {
  validateSharedProjectReferences(
    {
      ...project,
      conversationRevisions: project.conversationRevisions.map(
        ({ items, ...revision }) => ({
          ...revision,
          messages: items.flatMap((item) =>
            item.kind === "message" ? [item.message] : [],
          ),
        }),
      ),
    },
    context,
  );

  const templates = new Map(
    project.promptTemplates.map((template) => [template.id, template]),
  );
  addDuplicateIssues(
    project.externalImports.map(({ id }) => id),
    ["externalImports"],
    context,
  );
  const externalImportIds = new Set(
    project.externalImports.map(({ id }) => id),
  );
  const referencedExternalImportIds = new Set<ExternalImportId>();
  const externalImportProjectionKinds = new Map(
    project.externalImports.map(({ id, projection }) => [id, projection.kind]),
  );

  project.promptTemplates.forEach((template, templateIndex) => {
    const { recommendedTarget } = template;
    if (recommendedTarget) {
      requireReference(
        project.connectionRequirements.some(
          ({ id }) => id === recommendedTarget.connectionRequirementId,
        ),
        [
          "promptTemplates",
          templateIndex,
          "recommendedTarget",
          "connectionRequirementId",
        ],
        "Template recommendation references an unknown connection requirement.",
        context,
      );
    }
    template.revisions.forEach((revision, revisionIndex) => {
      if (!revision.externalImportId) return;
      referencedExternalImportIds.add(revision.externalImportId);
      requireReference(
        externalImportIds.has(revision.externalImportId),
        [
          "promptTemplates",
          templateIndex,
          "revisions",
          revisionIndex,
          "externalImportId",
        ],
        `Template revision references unknown external import "${revision.externalImportId}".`,
        context,
      );
      requireReference(
        externalImportProjectionKinds.get(revision.externalImportId) ===
          "prompt-template",
        [
          "promptTemplates",
          templateIndex,
          "revisions",
          revisionIndex,
          "externalImportId",
        ],
        "Template revisions must reference a prompt-template import receipt.",
        context,
      );
    });
  });

  project.conversationRevisions.forEach((revision, revisionIndex) => {
    const itemPath = ["conversationRevisions", revisionIndex, "items"];
    addDuplicateIssues(
      revision.items.flatMap((item) =>
        item.kind === "message" ? [] : [item.use.id],
      ),
      itemPath,
      context,
    );
    addDuplicateIssues(
      revision.items.flatMap((item) =>
        item.kind === "message"
          ? [item.message.id]
          : item.use.outputMessageIds,
      ),
      itemPath,
      context,
    );

    revision.items.forEach((item, itemIndex) => {
      if (item.kind === "message") {
        if (item.externalImportId) {
          referencedExternalImportIds.add(item.externalImportId);
          requireReference(
            externalImportIds.has(item.externalImportId),
            [...itemPath, itemIndex, "externalImportId"],
            `Message references unknown external import "${item.externalImportId}".`,
            context,
          );
          requireReference(
            externalImportProjectionKinds.get(item.externalImportId) ===
              "literal-messages",
            [...itemPath, itemIndex, "externalImportId"],
            "Messages must reference a literal-messages import receipt.",
            context,
          );
        }
        return;
      }
      const path = [...itemPath, itemIndex, "use"];
      const template = templates.get(item.use.templateId);
      requireReference(
        Boolean(template),
        [...path, "templateId"],
        `Template use references unknown template "${item.use.templateId}".`,
        context,
      );
      const templateRevision = template?.revisions.find(
        ({ id }) => id === item.use.templateRevisionId,
      );
      requireReference(
        Boolean(templateRevision),
        [...path, "templateRevisionId"],
        "Pinned template revision does not belong to the referenced template.",
        context,
      );
      if (!templateRevision) return;

      const expectedMessageCount =
        templateRevision.content.kind === "fragment"
          ? 1
          : templateRevision.content.messages.length;
      if (item.use.outputMessageIds.length !== expectedMessageCount) {
        context.addIssue({
          code: "custom",
          path: [...path, "outputMessageIds"],
          message: `Template use must provide ${expectedMessageCount} output message ID${expectedMessageCount === 1 ? "" : "s"}.`,
        });
      }
      if (
        templateRevision.content.kind === "fragment" &&
        !item.use.fragmentRole
      ) {
        context.addIssue({
          code: "custom",
          path: [...path, "fragmentRole"],
          message: "Fragment template uses require an explicit message role.",
        });
      }
      if (
        templateRevision.content.kind === "messages" &&
        item.use.fragmentRole !== undefined
      ) {
        context.addIssue({
          code: "custom",
          path: [...path, "fragmentRole"],
          message: "Message-set template uses cannot specify a fragment role.",
        });
      }
      Object.keys(item.use.values).forEach((name) => {
        const revisionVariables = new Set(
          discoverTemplateVariables(templateRevision.content).variables.map(
            ({ name: variableName }) => variableName,
          ),
        );
        if (!revisionVariables.has(name)) {
          context.addIssue({
            code: "custom",
            path: [...path, "values", name],
            message: `Template use value "${name}" is not used by its pinned revision.`,
          });
        }
        if (sensitiveFieldNames.has(normalizedFieldName(name))) {
          context.addIssue({
            code: "custom",
            path: [...path, "values", name],
            message: "Secret values cannot be stored on portable template uses.",
          });
        }
      });
    });
  });

  project.externalImports.forEach((receipt, receiptIndex) => {
    if (!referencedExternalImportIds.has(receipt.id)) {
      context.addIssue({
        code: "custom",
        path: ["externalImports", receiptIndex, "id"],
        message:
          "External import receipts must be referenced by imported project content.",
      });
    }
    if (receipt.projection.kind !== "prompt-template") return;
    const projection = receipt.projection;
    const template = templates.get(projection.templateId);
    const revision = template?.revisions.find(
      ({ id }) => id === projection.templateRevisionId,
    );
    requireReference(
      Boolean(revision),
      ["externalImports", receiptIndex, "projection"],
      "Template import receipt references an unknown template revision.",
      context,
    );
    requireReference(
      revision?.externalImportId === receipt.id,
      ["externalImports", receiptIndex, "projection"],
      "Template import receipt does not match the revision provenance anchor.",
      context,
    );
    if (!revision) return;
    const variableByBindingIndex = new Map(
      projection.variables.map(({ bindingIndex, variableName }) => [
        bindingIndex,
        variableName,
      ]),
    );
    const messages = receipt.authored.map((field) => {
      if (!field.role) return undefined;
      const contentStart = field.contentSpan?.startOffset ?? 0;
      const contentEnd = field.contentSpan?.endOffset ?? field.text.length;
      const indexedBindings = receipt.bindings
        .map((binding, bindingIndex) => ({ binding, bindingIndex }))
        .filter(({ binding }) => binding.authoredPath === field.path);
      const wholeField = indexedBindings.find(
        ({ binding }) => binding.source.kind === "whole-field",
      );
      if (wholeField) {
        return {
          role: field.role,
          content: `{{${variableByBindingIndex.get(wholeField.bindingIndex) ?? ""}}}`,
        };
      }
      const ordered = indexedBindings.sort((left, right) => {
        const leftStart =
          left.binding.source.kind === "expression-span"
            ? left.binding.source.startOffset
            : 0;
        const rightStart =
          right.binding.source.kind === "expression-span"
            ? right.binding.source.startOffset
            : 0;
        return leftStart - rightStart;
      });
      let cursor = contentStart;
      const parts: string[] = [];
      ordered.forEach(({ binding, bindingIndex }) => {
        if (binding.source.kind !== "expression-span") return;
        parts.push(field.text.slice(cursor, binding.source.startOffset));
        parts.push(`{{${variableByBindingIndex.get(bindingIndex) ?? ""}}}`);
        cursor = binding.source.endOffset;
      });
      parts.push(field.text.slice(cursor, contentEnd));
      return { role: field.role, content: parts.join("") };
    });
    if (messages.some((message) => !message)) {
      context.addIssue({
        code: "custom",
        path: ["externalImports", receiptIndex, "authored"],
        message:
          "Template import receipt fields require explicit message roles.",
      });
      return;
    }
    const expectedContent: PromptTemplateContent =
      messages.length === 1
        ? { kind: "fragment", text: messages[0]!.content }
        : {
            kind: "messages",
            messages: messages as Array<{
              role: "system" | "user" | "assistant";
              content: string;
            }>,
          };
    requireReference(
      JSON.stringify(stableJsonValue(revision.content)) ===
        JSON.stringify(stableJsonValue(expectedContent)),
      ["externalImports", receiptIndex, "projection"],
      "Template import projection does not reproduce its anchored revision.",
      context,
    );
  });
}

export class ProjectValidationError extends Error {
  readonly issues: z.core.$ZodIssue[];

  constructor(issues: z.core.$ZodIssue[]) {
    const summary = issues
      .slice(0, 3)
      .map(({ path, message }) => `${path.join(".") || "project"}: ${message}`)
      .join("; ");
    super(`Invalid Inference Lens project. ${summary}`);
    this.name = "ProjectValidationError";
    this.issues = issues;
  }
}

export function parseProjectFile(value: unknown): ProjectFile {
  const parsed = projectFileV5Schema.safeParse(value);
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
    "externalImports",
    "defaults",
    "id",
    "provider",
    "protocol",
    "endpoint",
    "capabilityOverrides",
    "conversationId",
    "parentRevisionId",
    "items",
    "kind",
    "message",
    "externalImportId",
    "use",
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
    "recommendedTarget",
    "revisions",
    "templateId",
    "templateRevisionId",
    "values",
    "outputMessageIds",
    "fragmentRole",
    "variableDefaults",
    "projection",
    "bindingIndex",
    "authoredPath",
    "expression",
    "variableName",
    "adapter",
    "resource",
    "execution",
    "version",
    "invocation",
    "authored",
    "bindings",
    "importedAt",
    "importerVersion",
    "sourceDigest",
    "fidelity",
    "warnings",
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

export function serializeProjectFile(project: ProjectFile): string {
  const validated = parseProjectFile(project);
  return `${JSON.stringify(stableJsonValue(validated), null, 2)}\n`;
}

/**
 * Compares conversation messages by value rather than by serialized shape.
 *
 * Validation rebuilds every message through the schema, which emits keys in
 * declaration order, while messages read back off run state keep the order they
 * were constructed in. Both describe the same message, so any comparison of the
 * two must ignore key order — a raw `JSON.stringify` of each side reports a
 * difference that does not exist.
 */
export function sameConversationMessages(
  left: readonly ConversationMessage[],
  right: readonly ConversationMessage[],
): boolean {
  return (
    JSON.stringify(stableJsonValue(left)) ===
    JSON.stringify(stableJsonValue(right))
  );
}

export function parseProjectJson(text: string): ProjectFile {
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
  items: ProjectConversationItem[];
  messages: ConversationMessage[];
  templateResolutions: ResolvedTemplateUse[];
  templateDiagnostics: ProjectTemplateDiagnostic[];
  model: string;
  temperature?: number;
  tools: ToolDefinition[];
  toolMocks: ToolMock[];
  enabledToolIds: ToolId[];
}

export interface UpdateProjectDraft {
  messages: ConversationMessage[];
  items?: ProjectConversationItem[];
  model: string;
  temperature?: number;
  tools: ToolDefinition[];
  toolMocks: ToolMock[];
  enabledToolIds: ToolId[];
}

export type TemplateRunOverrides = Readonly<
  Partial<Record<PromptTemplateUseId, Readonly<Record<string, string>>>>
>;

function validateTemplateRunOverrides(
  revision: ProjectConversationRevision,
  runOverrides: TemplateRunOverrides,
): void {
  const useIds = new Set<string>(
    revision.items.flatMap((item) =>
      item.kind === "template-use" ? [item.use.id] : [],
    ),
  );
  const issues: z.core.$ZodIssue[] = [];
  Object.entries(runOverrides).forEach(([useId, values]) => {
    if (!useIds.has(useId)) {
      issues.push({
        code: "custom",
        path: ["runOverrides", useId],
        message: "Run override references an unknown template use.",
      });
    }
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      issues.push({
        code: "custom",
        path: ["runOverrides", useId],
        message: "Template run overrides must be string-valued records.",
      });
      return;
    }
    Object.entries(values).forEach(([name, value]) => {
      if (!variableName.test(name)) {
        issues.push({
          code: "custom",
          path: ["runOverrides", useId, name],
          message: "Invalid template variable name.",
        });
      } else if (isSensitiveTemplateVariableName(name)) {
        issues.push({
          code: "custom",
          path: ["runOverrides", useId, name],
          message: "Secret values cannot be supplied as template run overrides.",
        });
      }
      if (typeof value !== "string") {
        issues.push({
          code: "custom",
          path: ["runOverrides", useId, name],
          message: "Template run override values must be strings.",
        });
      }
    });
  });
  if (issues.length > 0) throw new ProjectValidationError(issues);
}

/**
 * One template diagnostic, located against the authored item that produced it
 * so a caller can point at the offending template use rather than at the
 * document as a whole.
 */
export interface ProjectTemplateDiagnostic {
  itemIndex: number;
  templateUseId: PromptTemplateUseId;
  diagnostic: TemplateDiagnostic;
}

export interface ResolvedProjectRevision {
  messages: ConversationMessage[];
  templateResolutions: ResolvedTemplateUse[];
  /**
   * A revision that still has unresolved variables is a normal authoring
   * state, not a corrupt document: values may arrive from a later edit or from
   * per-run overrides. Resolution always yields messages and reports what is
   * unresolved so opening and saving a project never depend on it being
   * finished.
   */
  diagnostics: ProjectTemplateDiagnostic[];
}

export type PreparedProjectRevisionRun =
  | {
      ok: true;
      messages: ConversationMessage[];
      templateResolutions: ResolvedTemplateUse[];
    }
  | {
      ok: false;
      diagnostics: ProjectTemplateDiagnostic[];
    };

export function resolveProjectRevision(
  project: ProjectFile,
  revision: ProjectConversationRevision,
  runOverrides: TemplateRunOverrides = {},
): ResolvedProjectRevision {
  validateTemplateRunOverrides(revision, runOverrides);
  const templates = new Map(
    project.promptTemplates.map((template) => [template.id, template]),
  );
  const messages: ConversationMessage[] = [];
  const templateResolutions: ResolvedTemplateUse[] = [];
  const diagnostics: ProjectTemplateDiagnostic[] = [];

  revision.items.forEach((item, itemIndex) => {
    if (item.kind === "message") {
      messages.push(item.message);
      return;
    }
    const template = templates.get(item.use.templateId);
    const templateRevision = template?.revisions.find(
      ({ id }) => id === item.use.templateRevisionId,
    );
    if (!template || !templateRevision) {
      throw new ProjectValidationError([
        {
          code: "custom",
          path: ["conversationRevisions", revision.id, "items", itemIndex],
          message: "Template use has an invalid pinned revision.",
        },
      ]);
    }
    const values = resolveTemplateValues(
      templateRevision.variableDefaults,
      item.use.values,
      runOverrides[item.use.id],
    );
    const rendered = renderTemplateContent(templateRevision.content, values);
    diagnostics.push(
      ...rendered.diagnostics.map((diagnostic) => ({
        itemIndex,
        templateUseId: item.use.id,
        // The engine reports only that a variable is unfilled. For a
        // secret-like name that is misleading: no level will accept a value, so
        // the author needs to know the name itself is the blocker.
        diagnostic:
          diagnostic.code === "missing-template-variable" &&
          isSensitiveTemplateVariableName(diagnostic.name)
            ? {
                ...diagnostic,
                message: `Template variable "${diagnostic.name}" is secret-like and can never be given a value. Rename it in the template; credentials are supplied through the connection, not the project.`,
              }
            : diagnostic,
      })),
    );
    if (rendered.content.kind === "fragment") {
      const role = item.use.fragmentRole;
      if (!role) throw new Error("Validated fragment use is missing a role.");
      messages.push({
        id: item.use.outputMessageIds[0]!,
        role,
        content: [{ type: "text", text: rendered.content.text }],
      });
      templateResolutions.push({
        templateUseId: item.use.id,
        templateId: template.id,
        templateRevisionId: templateRevision.id,
        templateName: template.name,
        content: structuredClone(templateRevision.content),
        variableDefaults: { ...templateRevision.variableDefaults },
        values,
        outputMessageIds: [...item.use.outputMessageIds],
        fragmentRole: role,
      });
      return;
    }
    rendered.content.messages.forEach((message, index) => {
      messages.push({
        id: item.use.outputMessageIds[index]!,
        role: message.role,
        content: [{ type: "text", text: message.content }],
      });
    });
    templateResolutions.push({
      templateUseId: item.use.id,
      templateId: template.id,
      templateRevisionId: templateRevision.id,
      templateName: template.name,
      content: structuredClone(templateRevision.content),
      variableDefaults: { ...templateRevision.variableDefaults },
      values,
      outputMessageIds: [...item.use.outputMessageIds],
    });
  });
  return { messages, templateResolutions, diagnostics };
}

/**
 * Applies execution policy to the tolerant authored-project resolver.
 *
 * Authoring callers use `resolveProjectRevision` so incomplete templates remain
 * visible and editable. Execution callers use this boundary so no provider can
 * receive a request while a template diagnostic remains unresolved.
 */
export function prepareProjectRevisionRun(
  project: ProjectFile,
  revision: ProjectConversationRevision,
  runOverrides: TemplateRunOverrides = {},
): PreparedProjectRevisionRun {
  const resolved = resolveProjectRevision(project, revision, runOverrides);
  if (resolved.diagnostics.length > 0) {
    return { ok: false, diagnostics: resolved.diagnostics };
  }
  return {
    ok: true,
    messages: resolved.messages,
    templateResolutions: resolved.templateResolutions,
  };
}

export function resolveProjectRevisionMessages(
  project: ProjectFile,
  revision: ProjectConversationRevision,
  runOverrides: TemplateRunOverrides = {},
): ConversationMessage[] {
  return resolveProjectRevision(project, revision, runOverrides).messages;
}

export function projectDraft(
  project: ProjectFile,
  runOverrides: TemplateRunOverrides = {},
): ProjectDraft {
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
  const resolved = resolveProjectRevision(project, revision, runOverrides);
  return {
    connectionRequirement,
    items: revision.items,
    messages: resolved.messages,
    templateResolutions: resolved.templateResolutions,
    templateDiagnostics: resolved.diagnostics,
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
  project: ProjectFile,
  draft: UpdateProjectDraft,
): ProjectFile {
  const activeRevisionIndex = project.conversationRevisions.findIndex(
    ({ id }) => id === project.defaults.conversationRevisionId,
  );
  if (activeRevisionIndex < 0) return parseProjectFile(project);
  const activeRevision = project.conversationRevisions[activeRevisionIndex];
  // Draft messages own their identity and complete rich payload. Existing and
  // newly inserted messages are intentionally handled identically by ID.
  let items = draft.items;
  if (!items) {
    const hasTemplateUse = activeRevision.items.some(
      (item) => item.kind === "template-use",
    );
    if (hasTemplateUse) {
      const resolved = resolveProjectRevisionMessages(project, activeRevision);
      if (!sameConversationMessages(resolved, draft.messages)) {
        throw new ProjectValidationError([
          {
            code: "custom",
            path: ["conversationRevisions", activeRevision.id, "items"],
            message:
              "A template-backed conversation must be edited through its authored items. Detach the template use before editing generated messages.",
          },
        ]);
      }
      items = activeRevision.items;
    } else {
      const externalImportByMessageId = new Map(
        activeRevision.items.flatMap((item) =>
          item.kind === "message" && item.externalImportId
            ? [[item.message.id, item.externalImportId] as const]
            : [],
        ),
      );
      items = draft.messages.map((message) => {
        const externalImportId = externalImportByMessageId.get(message.id);
        return {
          kind: "message" as const,
          message,
          ...(externalImportId ? { externalImportId } : {}),
        };
      });
    }
  }
  const conversationRevisions = [...project.conversationRevisions];
  conversationRevisions[activeRevisionIndex] = {
    ...activeRevision,
    items,
  };
  const referencedExternalImportIds = new Set(
    [
      ...conversationRevisions.flatMap((revision) =>
        revision.items.flatMap((item) =>
          item.kind === "message" && item.externalImportId
            ? [item.externalImportId]
            : [],
        ),
      ),
      ...project.promptTemplates.flatMap((template) =>
        template.revisions.flatMap(({ externalImportId }) =>
          externalImportId ? [externalImportId] : [],
        ),
      ),
    ],
  );
  return parseProjectFile({
    ...project,
    tools: draft.tools,
    toolMocks: draft.toolMocks,
    conversationRevisions,
    externalImports: project.externalImports.filter(({ id }) =>
      referencedExternalImportIds.has(id),
    ),
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

export interface CreateBranchRevisionOptions {
  conversationId: ConversationId;
  parentRevisionId: ConversationRevisionId;
  messages: ConversationMessage[];
  items?: ProjectConversationItem[];
  /**
   * The overrides the branched messages were produced with. Matching a
   * transcript against the parent requires resolving the parent the same way
   * the run did; without them an overridden variable reads as edited template
   * output and the branch is refused.
   */
  runOverrides?: TemplateRunOverrides;
  idSuffix?: string;
  createdAt?: string;
}

/**
 * Appends an immutable conversation revision and makes it the project's
 * active authored revision. The caller owns persistence of the returned file.
 */
export function createBranchRevision(
  project: ProjectFile,
  {
    conversationId,
    parentRevisionId,
    messages,
    items,
    runOverrides = {},
    idSuffix = randomUUID(),
    createdAt = new Date().toISOString(),
  }: CreateBranchRevisionOptions,
): ProjectFile {
  const parent = project.conversationRevisions.find(
    ({ id }) => id === parentRevisionId,
  );
  if (!parent || parent.conversationId !== conversationId) {
    throw new ProjectValidationError([
      {
        code: "custom",
        path: ["conversationRevisions", "parentRevisionId"],
        message: "Branch parent revision is missing or belongs to another conversation.",
      },
    ]);
  }
  const revision: ProjectConversationRevision = {
    id: createEntityId("revision", idSuffix),
    conversationId,
    parentRevisionId,
    items: items ?? authoredBranchItems(project, parent, messages, runOverrides),
    createdAt,
  };
  return parseProjectFile({
    ...project,
    conversationRevisions: [...project.conversationRevisions, revision],
    defaults: {
      ...project.defaults,
      conversationRevisionId: revision.id,
    },
  });
}

function authoredBranchItems(
  project: ProjectFile,
  parent: ProjectConversationRevision,
  messages: ConversationMessage[],
  runOverrides: TemplateRunOverrides = {},
): ProjectConversationItem[] {
  const resolved = resolveProjectRevision(project, parent, runOverrides);
  const resolvedById = new Map(
    resolved.messages.map((message) => [message.id, message]),
  );
  const templateByOutputId = new Map<
    MessageId,
    Extract<ProjectConversationItem, { kind: "template-use" }>
  >();
  parent.items.forEach((item) => {
    if (item.kind !== "template-use") return;
    item.use.outputMessageIds.forEach((messageId) => {
      templateByOutputId.set(messageId, item);
    });
  });

  const branchItems: ProjectConversationItem[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    const templateItem = templateByOutputId.get(message.id);
    if (templateItem) {
      const outputIds = templateItem.use.outputMessageIds;
      if (message.id !== outputIds[0]) {
        throw new ProjectValidationError([
          {
            code: "custom",
            path: ["conversationRevisions", parent.id, "items"],
            message:
              "A branch cannot begin or end inside a message-set template use. Detach the use before branching at that message.",
          },
        ]);
      }
      const emittedMessages = messages.slice(index, index + outputIds.length);
      const completeAndUnchanged =
        emittedMessages.length === outputIds.length &&
        emittedMessages.every((emitted, emittedIndex) => {
          const expectedId = outputIds[emittedIndex]!;
          const expected = resolvedById.get(expectedId);
          return (
            emitted.id === expectedId &&
            Boolean(expected) &&
            sameConversationMessages([emitted], [expected!])
          );
        });
      if (!completeAndUnchanged) {
        throw new ProjectValidationError([
          {
            code: "custom",
            path: ["conversationRevisions", parent.id, "items"],
            message:
              "A template use is atomic when branching and its generated text cannot be edited. Branch after its final message or detach it first.",
          },
        ]);
      }
      branchItems.push(structuredClone(templateItem));
      index += outputIds.length - 1;
      continue;
    }
    branchItems.push({ kind: "message", message: structuredClone(message) });
  }
  return branchItems;
}

/**
 * The authored items a branch from `revision` would produce for `messages`.
 *
 * Exposed so a composer can show a pending branch as the authored items it will
 * become — template uses preserved as uses — instead of guessing. Throws for the
 * same reasons the branch itself would, so callers that render this
 * speculatively should be prepared to fall back to literal messages.
 */
export function authoredItemsForMessages(
  project: ProjectFile,
  revision: ProjectConversationRevision,
  messages: ConversationMessage[],
  runOverrides: TemplateRunOverrides = {},
): ProjectConversationItem[] {
  return authoredBranchItems(project, revision, messages, runOverrides);
}

export interface PromptTemplateUsage {
  conversationId: ConversationId;
  conversationRevisionId: ConversationRevisionId;
  itemIndex: number;
  use: PromptTemplateUse;
}

export function findPromptTemplateUsages(
  project: ProjectFile,
  templateId: PromptTemplateId,
  templateRevisionId?: PromptTemplateRevisionId,
): PromptTemplateUsage[] {
  return project.conversationRevisions.flatMap((revision) =>
    revision.items.flatMap((item, itemIndex) =>
      item.kind === "template-use" &&
      item.use.templateId === templateId &&
      (templateRevisionId === undefined ||
        item.use.templateRevisionId === templateRevisionId)
        ? [
            {
              conversationId: revision.conversationId,
              conversationRevisionId: revision.id,
              itemIndex,
              use: structuredClone(item.use),
            },
          ]
        : [],
    ),
  );
}

function updateConversationRevisionItems(
  project: ProjectFile,
  conversationRevisionId: ConversationRevisionId,
  update: (items: ProjectConversationItem[]) => ProjectConversationItem[],
): ProjectFile {
  const revisionIndex = project.conversationRevisions.findIndex(
    ({ id }) => id === conversationRevisionId,
  );
  if (revisionIndex < 0) {
    throw new ProjectValidationError([
      {
        code: "custom",
        path: ["conversationRevisions", conversationRevisionId],
        message: "Conversation revision does not exist.",
      },
    ]);
  }
  const conversationRevisions = [...project.conversationRevisions];
  const revision = conversationRevisions[revisionIndex]!;
  conversationRevisions[revisionIndex] = {
    ...revision,
    items: update(revision.items),
  };
  return parseProjectFile({ ...project, conversationRevisions });
}

function findTemplateUseItem(
  revision: ProjectConversationRevision,
  templateUseId: PromptTemplateUseId,
): {
  itemIndex: number;
  item: Extract<ProjectConversationItem, { kind: "template-use" }>;
} {
  const itemIndex = revision.items.findIndex(
    (item) =>
      item.kind === "template-use" && item.use.id === templateUseId,
  );
  const item = revision.items[itemIndex];
  if (!item || item.kind !== "template-use") {
    throw new ProjectValidationError([
      {
        code: "custom",
        path: ["conversationRevisions", revision.id, "items", templateUseId],
        message: "Template use does not exist in this conversation revision.",
      },
    ]);
  }
  return { itemIndex, item };
}

export interface InsertPromptTemplateUseOptions {
  conversationRevisionId: ConversationRevisionId;
  templateId: PromptTemplateId;
  templateRevisionId?: PromptTemplateRevisionId;
  values?: Record<string, string>;
  fragmentRole?: "system" | "user" | "assistant";
  itemIndex?: number;
  idSuffix?: string;
  outputMessageIdSuffixes?: string[];
}

export function insertPromptTemplateUse(
  project: ProjectFile,
  {
    conversationRevisionId,
    templateId,
    templateRevisionId,
    values = {},
    fragmentRole,
    itemIndex,
    idSuffix = randomUUID(),
    outputMessageIdSuffixes,
  }: InsertPromptTemplateUseOptions,
): ProjectFile {
  const template = project.promptTemplates.find(({ id }) => id === templateId);
  const pinnedRevisionId = templateRevisionId ?? template?.currentRevisionId;
  const revision = template?.revisions.find(
    ({ id }) => id === pinnedRevisionId,
  );
  if (!template || !revision) {
    throw new ProjectValidationError([
      {
        code: "custom",
        path: ["promptTemplates", templateId],
        message: "Template or pinned revision does not exist.",
      },
    ]);
  }
  const outputCount =
    revision.content.kind === "fragment"
      ? 1
      : revision.content.messages.length;
  if (
    outputMessageIdSuffixes &&
    outputMessageIdSuffixes.length !== outputCount
  ) {
    throw new ProjectValidationError([
      {
        code: "custom",
        path: ["outputMessageIdSuffixes"],
        message: `Template use requires ${outputCount} output message ID suffix${outputCount === 1 ? "" : "es"}.`,
      },
    ]);
  }
  const use: PromptTemplateUse = {
    id: createEntityId("template-use", idSuffix),
    templateId,
    templateRevisionId: revision.id,
    values: { ...values },
    outputMessageIds: Array.from({ length: outputCount }, (_, index) =>
      createEntityId(
        "message",
        outputMessageIdSuffixes?.[index] ?? `${idSuffix}-${index + 1}`,
      ),
    ),
    ...(revision.content.kind === "fragment" ? { fragmentRole } : {}),
  };
  return updateConversationRevisionItems(
    project,
    conversationRevisionId,
    (items) => {
      const insertionIndex = itemIndex ?? items.length;
      if (insertionIndex < 0 || insertionIndex > items.length) {
        throw new ProjectValidationError([
          {
            code: "custom",
            path: ["conversationRevisions", conversationRevisionId, "items"],
            message: "Template use insertion index is outside the revision.",
          },
        ]);
      }
      return [
        ...items.slice(0, insertionIndex),
        { kind: "template-use", use },
        ...items.slice(insertionIndex),
      ];
    },
  );
}

export interface UpdatePromptTemplateUseValuesOptions {
  conversationRevisionId: ConversationRevisionId;
  templateUseId: PromptTemplateUseId;
  values: Record<string, string>;
}

export function updatePromptTemplateUseValues(
  project: ProjectFile,
  {
    conversationRevisionId,
    templateUseId,
    values,
  }: UpdatePromptTemplateUseValuesOptions,
): ProjectFile {
  const revision = project.conversationRevisions.find(
    ({ id }) => id === conversationRevisionId,
  );
  if (!revision) {
    throw new ProjectValidationError([
      {
        code: "custom",
        path: ["conversationRevisions", conversationRevisionId],
        message: "Conversation revision does not exist.",
      },
    ]);
  }
  findTemplateUseItem(revision, templateUseId);
  return updateConversationRevisionItems(
    project,
    conversationRevisionId,
    (items) =>
      items.map((item) =>
        item.kind === "template-use" && item.use.id === templateUseId
          ? { ...item, use: { ...item.use, values: { ...values } } }
          : item,
      ),
  );
}

export interface UpdatePromptTemplateUseToLatestOptions {
  conversationRevisionId: ConversationRevisionId;
  templateUseId: PromptTemplateUseId;
  newOutputMessageIdSuffixes?: string[];
  fragmentRole?: "system" | "user" | "assistant";
}

export function updatePromptTemplateUseToLatest(
  project: ProjectFile,
  {
    conversationRevisionId,
    templateUseId,
    newOutputMessageIdSuffixes = [],
    fragmentRole,
  }: UpdatePromptTemplateUseToLatestOptions,
): ProjectFile {
  const revision = project.conversationRevisions.find(
    ({ id }) => id === conversationRevisionId,
  );
  if (!revision) {
    throw new ProjectValidationError([
      {
        code: "custom",
        path: ["conversationRevisions", conversationRevisionId],
        message: "Conversation revision does not exist.",
      },
    ]);
  }
  const { item } = findTemplateUseItem(revision, templateUseId);
  const template = project.promptTemplates.find(
    ({ id }) => id === item.use.templateId,
  )!;
  const latest = template.revisions.find(
    ({ id }) => id === template.currentRevisionId,
  )!;
  if (item.use.templateRevisionId === latest.id) return project;
  const outputCount =
    latest.content.kind === "fragment" ? 1 : latest.content.messages.length;
  const additionalCount = Math.max(
    0,
    outputCount - item.use.outputMessageIds.length,
  );
  if (newOutputMessageIdSuffixes.length !== additionalCount) {
    throw new ProjectValidationError([
      {
        code: "custom",
        path: ["newOutputMessageIdSuffixes"],
        message: `Updating this use requires ${additionalCount} new output message ID suffix${additionalCount === 1 ? "" : "es"}.`,
      },
    ]);
  }
  const variableNames = new Set(
    discoverTemplateVariables(latest.content).variables.map(({ name }) => name),
  );
  const values = Object.fromEntries(
    Object.entries(item.use.values).filter(([name]) => variableNames.has(name)),
  );
  const outputMessageIds = [
    ...item.use.outputMessageIds.slice(0, outputCount),
    ...newOutputMessageIdSuffixes.map((suffix) =>
      createEntityId("message", suffix),
    ),
  ];
  const nextFragmentRole =
    latest.content.kind === "fragment"
      ? fragmentRole ?? item.use.fragmentRole
      : undefined;
  if (latest.content.kind === "fragment" && !nextFragmentRole) {
    throw new ProjectValidationError([
      {
        code: "custom",
        path: ["fragmentRole"],
        message:
          "Updating a message-set use to a fragment requires an explicit message role.",
      },
    ]);
  }
  return updateConversationRevisionItems(
    project,
    conversationRevisionId,
    (items) =>
      items.map((candidate) => {
        if (
          candidate.kind !== "template-use" ||
          candidate.use.id !== templateUseId
        ) {
          return candidate;
        }
        const use: PromptTemplateUse = {
          id: candidate.use.id,
          templateId: candidate.use.templateId,
          templateRevisionId: latest.id,
          values,
          outputMessageIds,
          ...(nextFragmentRole ? { fragmentRole: nextFragmentRole } : {}),
        };
        return { kind: "template-use", use };
      }),
  );
}

export interface DetachPromptTemplateUseOptions {
  conversationRevisionId: ConversationRevisionId;
  templateUseId: PromptTemplateUseId;
  runOverrides?: TemplateRunOverrides;
}

export function detachPromptTemplateUse(
  project: ProjectFile,
  {
    conversationRevisionId,
    templateUseId,
    runOverrides = {},
  }: DetachPromptTemplateUseOptions,
): ProjectFile {
  const revision = project.conversationRevisions.find(
    ({ id }) => id === conversationRevisionId,
  );
  if (!revision) {
    throw new ProjectValidationError([
      {
        code: "custom",
        path: ["conversationRevisions", conversationRevisionId],
        message: "Conversation revision does not exist.",
      },
    ]);
  }
  const { itemIndex, item } = findTemplateUseItem(revision, templateUseId);
  const resolved = resolveProjectRevision(project, revision, runOverrides);
  const useDiagnostics = resolved.diagnostics.filter(
    ({ templateUseId: diagnosticUseId }) =>
      diagnosticUseId === templateUseId,
  );
  if (useDiagnostics.length > 0) {
    throw new ProjectValidationError(
      useDiagnostics.map(({ diagnostic }) => ({
        code: "custom",
        path: [
          "conversationRevisions",
          conversationRevisionId,
          "items",
          itemIndex,
        ],
        message: `Resolve this template use before detaching it: ${diagnostic.message}`,
      })),
    );
  }
  const byId = new Map(
    resolved.messages.map((message) => [message.id, message]),
  );
  const replacements = item.use.outputMessageIds.map((messageId) => ({
    kind: "message" as const,
    message: structuredClone(byId.get(messageId)!),
  }));
  return updateConversationRevisionItems(
    project,
    conversationRevisionId,
    (items) => [
      ...items.slice(0, itemIndex),
      ...replacements,
      ...items.slice(itemIndex + 1),
    ],
  );
}

export function removePromptTemplateUse(
  project: ProjectFile,
  conversationRevisionId: ConversationRevisionId,
  templateUseId: PromptTemplateUseId,
): ProjectFile {
  const revision = project.conversationRevisions.find(
    ({ id }) => id === conversationRevisionId,
  );
  if (!revision) {
    throw new ProjectValidationError([
      {
        code: "custom",
        path: ["conversationRevisions", conversationRevisionId],
        message: "Conversation revision does not exist.",
      },
    ]);
  }
  const { itemIndex } = findTemplateUseItem(revision, templateUseId);
  return updateConversationRevisionItems(
    project,
    conversationRevisionId,
    (items) => [
      ...items.slice(0, itemIndex),
      ...items.slice(itemIndex + 1),
    ],
  );
}

export interface CreatePromptTemplateOptions {
  name: string;
  content: PromptTemplateContent;
  variableDefaults?: Record<string, string>;
  recommendedTarget?: PromptTemplateRecommendedTarget;
  idSuffix?: string;
  revisionIdSuffix?: string;
  createdAt?: string;
}

export function createPromptTemplate(
  project: ProjectFile,
  {
    name,
    content,
    variableDefaults = {},
    recommendedTarget,
    idSuffix = randomUUID(),
    revisionIdSuffix = randomUUID(),
    createdAt = new Date().toISOString(),
  }: CreatePromptTemplateOptions,
): ProjectFile {
  const revisionId = createEntityId("template-revision", revisionIdSuffix);
  return parseProjectFile({
    ...project,
    promptTemplates: [
      ...project.promptTemplates,
      {
        id: createEntityId("template", idSuffix),
        name,
        currentRevisionId: revisionId,
        ...(recommendedTarget
          ? { recommendedTarget: { ...recommendedTarget } }
          : {}),
        revisions: [
          {
            id: revisionId,
            createdAt,
            content: structuredClone(content),
            variableDefaults: { ...variableDefaults },
          },
        ],
      },
    ],
  });
}

export interface AppendPromptTemplateRevisionOptions {
  templateId: PromptTemplateId;
  content: PromptTemplateContent;
  variableDefaults?: Record<string, string>;
  idSuffix?: string;
  createdAt?: string;
}

export function appendPromptTemplateRevision(
  project: ProjectFile,
  {
    templateId,
    content,
    variableDefaults = {},
    idSuffix = randomUUID(),
    createdAt = new Date().toISOString(),
  }: AppendPromptTemplateRevisionOptions,
): ProjectFile {
  const templateIndex = project.promptTemplates.findIndex(
    ({ id }) => id === templateId,
  );
  if (templateIndex < 0) {
    throw new ProjectValidationError([
      {
        code: "custom",
        path: ["promptTemplates", templateId],
        message: "Template does not exist.",
      },
    ]);
  }
  const template = project.promptTemplates[templateIndex]!;
  const current = template.revisions.find(
    ({ id }) => id === template.currentRevisionId,
  )!;
  if (
    JSON.stringify(stableJsonValue(current.content)) ===
      JSON.stringify(stableJsonValue(content)) &&
    JSON.stringify(stableJsonValue(current.variableDefaults)) ===
      JSON.stringify(stableJsonValue(variableDefaults))
  ) {
    return project;
  }
  const revision: PromptTemplateRevision = {
    id: createEntityId("template-revision", idSuffix),
    createdAt,
    content: structuredClone(content),
    variableDefaults: { ...variableDefaults },
  };
  const promptTemplates = [...project.promptTemplates];
  promptTemplates[templateIndex] = {
    ...template,
    currentRevisionId: revision.id,
    revisions: [...template.revisions, revision],
  };
  return parseProjectFile({ ...project, promptTemplates });
}

/**
 * Records, replaces, or clears the model a template is recommended for.
 *
 * This is template metadata, not authored content: it deliberately leaves
 * `currentRevisionId` and every revision untouched, so recording a
 * recommendation never unpins an existing use. Passing an unchanged value is a
 * no-op, matching `appendPromptTemplateRevision`.
 */
export function setPromptTemplateRecommendedTarget(
  project: ProjectFile,
  templateId: PromptTemplateId,
  recommendedTarget: PromptTemplateRecommendedTarget | undefined,
): ProjectFile {
  const templateIndex = project.promptTemplates.findIndex(
    ({ id }) => id === templateId,
  );
  if (templateIndex < 0) {
    throw new ProjectValidationError([
      {
        code: "custom",
        path: ["promptTemplates", templateId],
        message: "Template does not exist.",
      },
    ]);
  }
  const template = project.promptTemplates[templateIndex]!;
  if (
    JSON.stringify(stableJsonValue(template.recommendedTarget)) ===
    JSON.stringify(stableJsonValue(recommendedTarget))
  ) {
    return project;
  }
  // Clearing drops the key rather than storing undefined, so a cleared
  // recommendation serializes identically to one that was never set.
  const next: PromptTemplate = { ...template };
  if (recommendedTarget) next.recommendedTarget = { ...recommendedTarget };
  else delete next.recommendedTarget;
  const promptTemplates = [...project.promptTemplates];
  promptTemplates[templateIndex] = next;
  return parseProjectFile({ ...project, promptTemplates });
}

/** Renames a template label without changing revision identity or content. */
export function renamePromptTemplate(
  project: ProjectFile,
  templateId: PromptTemplateId,
  name: string,
): ProjectFile {
  const templateIndex = project.promptTemplates.findIndex(
    ({ id }) => id === templateId,
  );
  if (templateIndex < 0) {
    throw new ProjectValidationError([
      {
        code: "custom",
        path: ["promptTemplates", templateId],
        message: "Template does not exist.",
      },
    ]);
  }
  const trimmed = name.trim();
  if (!trimmed) {
    throw new ProjectValidationError([
      {
        code: "custom",
        path: ["promptTemplates", templateId, "name"],
        message: "Template name is required.",
      },
    ]);
  }
  if (project.promptTemplates[templateIndex]!.name === trimmed) return project;
  const promptTemplates = [...project.promptTemplates];
  promptTemplates[templateIndex] = {
    ...promptTemplates[templateIndex]!,
    name: trimmed,
  };
  return parseProjectFile({ ...project, promptTemplates });
}

export function setPromptTemplateCurrentRevision(
  project: ProjectFile,
  templateId: PromptTemplateId,
  templateRevisionId: PromptTemplateRevisionId,
): ProjectFile {
  const templateIndex = project.promptTemplates.findIndex(
    ({ id }) => id === templateId,
  );
  const template = project.promptTemplates[templateIndex];
  if (
    !template ||
    !template.revisions.some(({ id }) => id === templateRevisionId)
  ) {
    throw new ProjectValidationError([
      {
        code: "custom",
        path: ["promptTemplates", templateId, "currentRevisionId"],
        message: "Current revision must belong to the selected template.",
      },
    ]);
  }
  if (template.currentRevisionId === templateRevisionId) return project;
  const promptTemplates = [...project.promptTemplates];
  promptTemplates[templateIndex] = {
    ...template,
    currentRevisionId: templateRevisionId,
  };
  return parseProjectFile({ ...project, promptTemplates });
}

export function removePromptTemplateRevision(
  project: ProjectFile,
  templateId: PromptTemplateId,
  templateRevisionId: PromptTemplateRevisionId,
): ProjectFile {
  const templateIndex = project.promptTemplates.findIndex(
    ({ id }) => id === templateId,
  );
  const template = project.promptTemplates[templateIndex];
  if (
    !template ||
    !template.revisions.some(({ id }) => id === templateRevisionId)
  ) {
    throw new ProjectValidationError([
      {
        code: "custom",
        path: ["promptTemplates", templateId, "revisions"],
        message: "Template revision does not exist.",
      },
    ]);
  }
  if (
    template.currentRevisionId === templateRevisionId ||
    template.revisions.length === 1 ||
    findPromptTemplateUsages(project, templateId, templateRevisionId).length > 0
  ) {
    throw new ProjectValidationError([
      {
        code: "custom",
        path: ["promptTemplates", templateId, "revisions", templateRevisionId],
        message:
          "The current, last, or referenced template revision cannot be removed.",
      },
    ]);
  }
  const promptTemplates = [...project.promptTemplates];
  promptTemplates[templateIndex] = {
    ...template,
    revisions: template.revisions.filter(
      ({ id }) => id !== templateRevisionId,
    ),
  };
  const removedRevision = template.revisions.find(
    ({ id }) => id === templateRevisionId,
  );
  const externalImports = removedRevision?.externalImportId
    ? project.externalImports.filter(
        ({ id }) => id !== removedRevision.externalImportId,
      )
    : project.externalImports;
  return parseProjectFile({ ...project, promptTemplates, externalImports });
}

export interface CreateProjectOptions {
  name: string;
  request: InferenceRequest | RichInferenceRequest;
  idSuffix?: string;
  createdAt?: string;
}

export function createProjectFile({
  name,
  request,
  idSuffix = randomUUID(),
  createdAt = new Date().toISOString(),
}: CreateProjectOptions): ProjectFile {
  const projectId = createEntityId("project", idSuffix);
  const connectionId = createEntityId("connection", `${idSuffix}-default`);
  const conversationId = createEntityId("conversation", `${idSuffix}-default`);
  const revisionId = createEntityId("revision", `${idSuffix}-initial`);
  const project: ProjectFile = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    projectId,
    name: name.trim() || "Untitled Inference Lens project",
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
        items: (
          request.messages.map((message, index) =>
            "id" in message
              ? message
              : {
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
                },
          ) as ConversationMessage[]
        ).map((message) => ({ kind: "message", message })),
        createdAt,
      },
    ],
    tools: [],
    toolMocks: [],
    promptTemplates: [],
    externalImports: [],
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
