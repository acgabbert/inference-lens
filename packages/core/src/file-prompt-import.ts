import { createExternalPromptCandidate, type ExternalPromptCandidate } from "./external-prompt-import.ts";
import { externalPromptLibraryAddition, projectExternalPromptTemplate } from "./external-prompt-project.ts";
import { parseProjectFile, type ExternalImportReceipt, type ProjectFile, type PromptTemplateMessages } from "./project.ts";
import { discoverTemplateVariables, renderTemplateMessages } from "./template-engine.ts";
import type { PromptTemplateId } from "./run-kernel/types.ts";
import { scanN8nExpressionRegions } from "../../n8n/src/expression-regions.ts";
import { externalPromptProjectedMessages } from "./external-prompt-projection.ts";
import { n8nExpressionIdentity } from "../../n8n/src/expression-naming.ts";
import { sourceFileBasename, sourceFilePathProblem } from "./source-root-rules.ts";

export interface FilePromptInput {
  filename: string;
  text: string;
  role: "system" | "user" | "assistant";
  plainText: boolean;
  /**
   * The file's path inside a linked source root, recorded as the receipt's
   * resource in place of the bare filename. It must end with `filename`.
   */
  path?: string;
}

/** Decode once at the host boundary; retain line endings and every other code point. */
export function decodePromptFile(bytes: ArrayBuffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** Filename and role are receipt identity; authored text is the content comparison. */
export async function createFilePromptCandidate(
  input: FilePromptInput,
): Promise<ExternalPromptCandidate> {
  const filename = input.filename.trim();
  if (!filename || /[\\/]/.test(filename)) {
    throw new Error("Choose a file with a filename, without a path.");
  }
  if (input.path !== undefined) {
    const problem = sourceFilePathProblem(input.path);
    if (problem) throw new Error(problem);
    if (sourceFileBasename(input.path) !== filename) throw new Error("A source file path must end with its filename.");
  }
  const resource = input.path ?? filename;
  const scan = input.plainText
    ? { ok: true as const, regions: [] }
    : scanN8nExpressionRegions(input.text);
  if (!scan.ok) {
    throw new Error(
      `${scan.reason} (at character ${scan.errorOffset + 1}). Choose plain text to keep it literal.`,
    );
  }
  const candidate = await createExternalPromptCandidate({
    source: {
      adapter: "file",
      resource: { kind: "file", id: resource, name: resource },
    },
    invocation: {
      type: "file",
      id: "content",
      name: filename.replace(/\.(md|txt)$/i, "") || filename,
      version: input.plainText ? "plain-text-v1" : "expression-v1",
    },
    authored: [{
      path: "content",
      role: input.role,
      syntax: input.plainText ? "literal" : "external-expression",
      text: input.text,
    }],
    bindings: scan.regions.map((region) => ({
      authoredPath: "content",
      expression: region.expression,
      source: {
        kind: "expression-span",
        startOffset: region.startOffset,
        endOffset: region.endOffset,
      },
      // These have no captured execution value; the operator supplies inputs.
      status: "missing",
    })),
    fidelity: "authored-only",
    warnings: [],
  });
  projectExternalPromptTemplate(candidate);
  return candidate;
}

/** Atomic, immutable library addition. Request revisions, pins and defaults stay intact. */
export async function importFilePromptCandidates(
  projectValue: ProjectFile,
  candidates: readonly ExternalPromptCandidate[],
): Promise<{ project: ProjectFile; templateIds: PromptTemplateId[] }> {
  let project = parseProjectFile(projectValue);
  const templateIds: PromptTemplateId[] = [];
  for (const candidate of candidates) {
    if (candidate.source.adapter !== "file" || candidate.authored.length !== 1) {
      throw new Error("File import requires one whole-file prompt per candidate.");
    }
    const { template, receipt } = await externalPromptLibraryAddition(project, candidate);
    // Each addition derives its IDs against the batch so far. No intermediate
    // state is published to a host.
    project = parseProjectFile({
      ...project,
      promptTemplates: [...project.promptTemplates, template],
      externalImports: [...project.externalImports, receipt],
    });
    templateIds.push(template.id);
  }
  return { project, templateIds };
}

/**
 * Names of the saved prompts already imported from this bare filename, once
 * each, in import order. A filename is weak identity, so callers warn rather
 * than block: distinct files can share a name.
 */
export function priorFilePromptImports(
  project: Pick<ProjectFile, "externalImports" | "promptTemplates">,
  filename: string,
): string[] {
  const names = new Map<string, string>();
  for (const receipt of project.externalImports) {
    if (!isFileTemplateReceipt(receipt) || receipt.source.resource.id !== filename) continue;
    if (receipt.projection.kind !== "prompt-template") continue;
    const { templateId } = receipt.projection;
    const template = project.promptTemplates.find(({ id }) => id === templateId);
    if (template && !names.has(template.id)) names.set(template.id, template.name);
  }
  return [...names.values()];
}

export type N8nFileCopy ={ ok: true; text: string } | { ok: false; message: string };

function isFileTemplateReceipt(receipt: ExternalImportReceipt): boolean {
  return receipt.source.adapter === "file" && receipt.projection.kind === "prompt-template";
}

/**
 * Reverse only recorded projections; rendering unescapes literals without
 * evaluating expressions. `receipts` are the template's own, in import order.
 */
export function copyFilePromptAsN8nText(
  messages: PromptTemplateMessages,
  receipts: readonly ExternalImportReceipt[],
): N8nFileCopy {
  if (messages.length !== 1) {
    return { ok: false, message: "Copy as n8n text requires exactly one message for a file." };
  }
  const fileReceipts = receipts.filter(isFileTemplateReceipt);
  const values: Record<string, string> = Object.create(null);
  const conflicts = new Set<string>();
  for (const receipt of fileReceipts) {
    if (receipt.projection.kind !== "prompt-template") continue;
    for (const { variableName, expression } of receipt.projection.variables) {
      if (
        Object.hasOwn(values, variableName) &&
        n8nExpressionIdentity(values[variableName]).key !== n8nExpressionIdentity(expression).key
      ) {
        conflicts.add(variableName);
      } else {
        values[variableName] = expression;
      }
    }
  }
  const discovery = discoverTemplateVariables(messages);
  const unmapped = discovery.variables
    .filter(({ name }) => !Object.hasOwn(values, name) || conflicts.has(name))
    .map(({ name }) => name);
  if (unmapped.length) {
    return { ok: false, message: `No unambiguous n8n expression is recorded for: ${unmapped.join(", ")}.` };
  }
  if (discovery.diagnostics.length) {
    return { ok: false, message: "Fix invalid template tokens before copying as n8n text." };
  }
  // An unchanged projection can retain each occurrence's original spelling,
  // even when equivalent references collapsed into one native variable.
  for (const receipt of [...fileReceipts].reverse()) {
    if (receipt.projection.kind !== "prompt-template") continue;
    const projected = externalPromptProjectedMessages(
      receipt.authored,
      receipt.bindings,
      new Map(receipt.projection.variables.map(({ bindingIndex, variableName }) => [bindingIndex, variableName])),
      "file",
    );
    if (JSON.stringify(projected) === JSON.stringify(messages)) {
      return { ok: true, text: receipt.authored[0].text };
    }
  }
  const text = renderTemplateMessages(messages, values).messages[0].content;
  // A plain-text file is read literally, so unescaped braces copy back as written.
  if (fileReceipts.at(-1)?.invocation.version === "plain-text-v1") return { ok: true, text };
  // In an expression file every {{ is an expression, so an escaped literal
  // would come back live. The copy must read back as exactly the variables.
  const expected = discovery.variables
    .flatMap(({ name, occurrences }) => occurrences.map(({ start }) => ({ start, expression: values[name] })))
    .sort((left, right) => left.start - right.start)
    .map(({ expression }) => expression);
  const scan = scanN8nExpressionRegions(text);
  if (
    !scan.ok ||
    scan.regions.length !== expected.length ||
    scan.regions.some(({ expression }, index) => expression !== expected[index])
  ) {
    return {
      ok: false,
      message: "n8n would read this text as different expressions than its variables. Remove literal {{ before copying as n8n text.",
    };
  }
  return { ok: true, text };
}
