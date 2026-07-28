import { z } from "zod";

import type { JsonValue } from "./run-kernel/types.ts";

export type ImportFidelity =
  | "provider-evidence"
  | "execution-reconstructed"
  | "authored-only";

export interface ImportWarning {
  code: string;
  severity: "info" | "warning";
  message: string;
}

/**
 * Provider-neutral identity for the external system and selected source
 * resource. Adapter-specific payloads and connection details do not cross this
 * boundary.
 */
export interface ExternalPromptSource {
  adapter: string;
  resource: {
    kind: string;
    id: string;
    name?: string;
  };
  execution?: {
    id: string;
    executedAt?: string;
  };
  version?: string;
}

export interface ExternalInvocationRef {
  id: string;
  name: string;
  type: string;
  version?: string;
  runIndex?: number;
  itemIndex?: number;
}

export interface AuthoredPromptField {
  path: string;
  role?: "system" | "user" | "assistant";
  syntax: "literal" | "external-expression";
  text: string;
}

export type BindingValueEvidence =
  | {
      kind: "saved-expression-result" | "saved-parameter-value";
      path: string;
    }
  | {
      kind: "user-supplied";
    };

export interface ExpressionBinding {
  authoredPath: string;
  expression: string;
  source:
    | {
        kind: "expression-span";
        startOffset: number;
        endOffset: number;
      }
    | {
        kind: "whole-field";
      };
  resolvedValue?: JsonValue;
  status: "resolved" | "missing" | "ambiguous" | "redacted";
  valueEvidence?: BindingValueEvidence;
}

export interface ResolvedImportMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ResolvedPromptSnapshot {
  messages: ResolvedImportMessage[];
  model?: string;
  options?: {
    temperature?: number;
    maxOutputTokens?: number;
    seed?: number;
    stop?: string[];
    providerOptions?: Record<string, JsonValue>;
  };
}

export interface ExternalPromptCandidate {
  source: ExternalPromptSource;
  invocation: ExternalInvocationRef;
  authored: AuthoredPromptField[];
  resolved?: ResolvedPromptSnapshot;
  bindings: ExpressionBinding[];
  fidelity: ImportFidelity;
  warnings: ImportWarning[];
  sourceDigest: string;
}

export type ExternalPromptCandidateEvidence = Omit<
  ExternalPromptCandidate,
  "sourceDigest"
>;

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const nonEmptyString = z.string().trim().min(1);
const externalIdentifier = nonEmptyString.refine(
  (value) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(value),
  "External identifiers must not contain an instance URL.",
);
const safeCode = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, "Expected a kebab-case code.");
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

function sensitiveValuePath(
  value: JsonValue | undefined,
  path: Array<string | number> = [],
): Array<string | number> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const nested = sensitiveValuePath(item, [...path, index]);
      if (nested) return nested;
    }
    return undefined;
  }
  for (const [key, item] of Object.entries(value)) {
    if (sensitiveFieldNames.has(normalizedFieldName(key))) {
      return [...path, key];
    }
    const nested = sensitiveValuePath(item, [...path, key]);
    if (nested) return nested;
  }
  return undefined;
}

export const importWarningSchema: z.ZodType<ImportWarning> = z
  .object({
    code: safeCode,
    severity: z.enum(["info", "warning"]),
    message: nonEmptyString,
  })
  .strict();

export const externalPromptSourceSchema: z.ZodType<ExternalPromptSource> = z
  .object({
    adapter: safeCode,
    resource: z
      .object({
        kind: safeCode,
        id: externalIdentifier,
        name: nonEmptyString.optional(),
      })
      .strict(),
    execution: z
      .object({
        id: externalIdentifier,
        executedAt: z.iso.datetime({ offset: true }).optional(),
      })
      .strict()
      .optional(),
    version: nonEmptyString.optional(),
  })
  .strict();

export const externalInvocationRefSchema: z.ZodType<ExternalInvocationRef> = z
  .object({
    id: externalIdentifier,
    name: nonEmptyString,
    type: nonEmptyString,
    version: nonEmptyString.optional(),
    runIndex: z.number().int().nonnegative().optional(),
    itemIndex: z.number().int().nonnegative().optional(),
  })
  .strict();

export const authoredPromptFieldSchema: z.ZodType<AuthoredPromptField> = z
  .object({
    path: nonEmptyString,
    role: z.enum(["system", "user", "assistant"]).optional(),
    syntax: z.enum(["literal", "external-expression"]),
    text: z.string(),
  })
  .strict();

export const expressionBindingSchema: z.ZodType<ExpressionBinding> = z
  .object({
    authoredPath: nonEmptyString,
    expression: z.string(),
    source: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("expression-span"),
          startOffset: z.number().int().nonnegative(),
          endOffset: z.number().int().positive(),
        })
        .strict(),
      z.object({ kind: z.literal("whole-field") }).strict(),
    ]),
    resolvedValue: jsonValueSchema.optional(),
    status: z.enum(["resolved", "missing", "ambiguous", "redacted"]),
    valueEvidence: z
      .union([
        z
          .object({
            kind: z.enum([
              "saved-expression-result",
              "saved-parameter-value",
            ]),
            path: nonEmptyString,
          })
          .strict(),
        z.object({ kind: z.literal("user-supplied") }).strict(),
      ])
      .optional(),
  })
  .strict();

export const resolvedPromptSnapshotSchema: z.ZodType<ResolvedPromptSnapshot> = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.enum(["system", "user", "assistant"]),
            content: z.string(),
          })
          .strict(),
      )
      .min(1),
    model: nonEmptyString.optional(),
    options: z
      .object({
        temperature: z.number().finite().optional(),
        maxOutputTokens: z.number().int().positive().optional(),
        seed: z.number().int().optional(),
        stop: z.array(z.string()).optional(),
        providerOptions: z.record(z.string(), jsonValueSchema).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export function validateAuthoredPromptBindings(
  candidate: Pick<ExternalPromptCandidate, "authored" | "bindings">,
  context: z.RefinementCtx,
): void {
  const authoredByPath = new Map<string, AuthoredPromptField>();
  candidate.authored.forEach((field, index) => {
    if (authoredByPath.has(field.path)) {
      context.addIssue({
        code: "custom",
        path: ["authored", index, "path"],
        message: `Duplicate authored path "${field.path}".`,
      });
    }
    authoredByPath.set(field.path, field);
  });

  const spansByPath = new Map<
    string,
    Array<{ start: number; end: number; index: number }>
  >();
  const wholeFieldPaths = new Set<string>();
  candidate.bindings.forEach((binding, index) => {
    const field = authoredByPath.get(binding.authoredPath);
    if (!field) {
      context.addIssue({
        code: "custom",
        path: ["bindings", index, "authoredPath"],
        message: `Binding references unknown authored path "${binding.authoredPath}".`,
      });
      return;
    }
    if (field.syntax !== "external-expression") {
      context.addIssue({
        code: "custom",
        path: ["bindings", index, "authoredPath"],
        message: "Bindings may reference only external-expression fields.",
      });
    }
    if (binding.status === "resolved") {
      if (binding.resolvedValue === undefined || !binding.valueEvidence) {
        context.addIssue({
          code: "custom",
          path: ["bindings", index],
          message:
            "Resolved bindings require both a resolved value and value evidence.",
        });
      }
      const sensitivePath = sensitiveValuePath(binding.resolvedValue);
      if (sensitivePath) {
        context.addIssue({
          code: "custom",
          path: ["bindings", index, "resolvedValue", ...sensitivePath],
          message: "Secret-bearing fields are not portable import evidence.",
        });
      }
    } else if (
      binding.resolvedValue !== undefined ||
      binding.valueEvidence !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["bindings", index],
        message:
          "Only resolved bindings may contain a resolved value or value evidence.",
      });
    }

    if (binding.source.kind === "whole-field") {
      wholeFieldPaths.add(binding.authoredPath);
      if (binding.expression !== field.text) {
        context.addIssue({
          code: "custom",
          path: ["bindings", index, "expression"],
          message: "A whole-field binding must preserve the complete authored text.",
        });
      }
      return;
    }

    const { startOffset, endOffset } = binding.source;
    if (endOffset <= startOffset || endOffset > field.text.length) {
      context.addIssue({
        code: "custom",
        path: ["bindings", index, "source"],
        message: "Expression span is outside the authored field.",
      });
      return;
    }
    if (field.text.slice(startOffset, endOffset) !== binding.expression) {
      context.addIssue({
        code: "custom",
        path: ["bindings", index, "expression"],
        message: "Expression text does not match its UTF-16 authored span.",
      });
    }
    const spans = spansByPath.get(binding.authoredPath) ?? [];
    spans.push({ start: startOffset, end: endOffset, index });
    spansByPath.set(binding.authoredPath, spans);
  });

  wholeFieldPaths.forEach((path) => {
    if ((spansByPath.get(path)?.length ?? 0) > 0) {
      context.addIssue({
        code: "custom",
        path: ["bindings"],
        message: `Whole-field and expression-span bindings cannot be mixed for "${path}".`,
      });
    }
  });
  spansByPath.forEach((spans) => {
    const ordered = [...spans].sort((left, right) => left.start - right.start);
    ordered.slice(1).forEach((span, index) => {
      if (span.start < ordered[index]!.end) {
        context.addIssue({
          code: "custom",
          path: ["bindings", span.index, "source"],
          message: "Expression spans cannot overlap.",
        });
      }
    });
  });
}

function validateCandidateRelationships(
  candidate: ExternalPromptCandidate,
  context: z.RefinementCtx,
): void {
  if (candidate.fidelity === "authored-only" && candidate.resolved) {
    context.addIssue({
      code: "custom",
      path: ["resolved"],
      message: "Authored-only candidates cannot claim a resolved snapshot.",
    });
  }
  if (candidate.fidelity !== "authored-only" && !candidate.resolved) {
    context.addIssue({
      code: "custom",
      path: ["resolved"],
      message: `${candidate.fidelity} candidates require a resolved snapshot.`,
    });
  }
  const sensitiveProviderPath = sensitiveValuePath(
    candidate.resolved?.options?.providerOptions,
  );
  if (sensitiveProviderPath) {
    context.addIssue({
      code: "custom",
      path: [
        "resolved",
        "options",
        "providerOptions",
        ...sensitiveProviderPath,
      ],
      message: "Secret-bearing fields are not portable import evidence.",
    });
  }
  validateAuthoredPromptBindings(candidate, context);
}

export const externalPromptCandidateSchema: z.ZodType<ExternalPromptCandidate> =
  z
    .object({
      source: externalPromptSourceSchema,
      invocation: externalInvocationRefSchema,
      authored: z.array(authoredPromptFieldSchema).min(1),
      resolved: resolvedPromptSnapshotSchema.optional(),
      bindings: z.array(expressionBindingSchema),
      fidelity: z.enum([
        "provider-evidence",
        "execution-reconstructed",
        "authored-only",
      ]),
      warnings: z.array(importWarningSchema),
      sourceDigest: z
        .string()
        .regex(/^[a-f0-9]{64}$/, "Expected a lowercase SHA-256 digest."),
    })
    .strict()
    .superRefine(validateCandidateRelationships);

export class ExternalPromptCandidateValidationError extends Error {
  readonly issues: z.core.$ZodIssue[];

  constructor(issues: z.core.$ZodIssue[]) {
    const summary = issues
      .slice(0, 3)
      .map(({ path, message }) => `${path.join(".") || "candidate"}: ${message}`)
      .join("; ");
    super(`Invalid external prompt candidate. ${summary}`);
    this.name = "ExternalPromptCandidateValidationError";
    this.issues = issues;
  }
}

export function parseExternalPromptCandidate(
  value: unknown,
): ExternalPromptCandidate {
  const parsed = externalPromptCandidateSchema.safeParse(value);
  if (!parsed.success) {
    throw new ExternalPromptCandidateValidationError(parsed.error.issues);
  }
  return parsed.data;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      // Digests cross runtimes and machines, so ordering must not depend on
      // locale or the ICU data bundled with the current JavaScript engine.
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, canonicalJsonValue(item)]),
  );
}

function candidateDigestEvidence(
  candidate: ExternalPromptCandidateEvidence,
): unknown {
  return {
    source: candidate.source,
    invocation: candidate.invocation,
    authored: candidate.authored,
    resolved: candidate.resolved,
    bindings: candidate.bindings,
  };
}

export async function computeExternalPromptSourceDigest(
  candidate: ExternalPromptCandidateEvidence,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify(canonicalJsonValue(candidateDigestEvidence(candidate))),
  );
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function createExternalPromptCandidate(
  evidence: ExternalPromptCandidateEvidence,
): Promise<ExternalPromptCandidate> {
  const sourceDigest = await computeExternalPromptSourceDigest(evidence);
  return parseExternalPromptCandidate({ ...evidence, sourceDigest });
}
