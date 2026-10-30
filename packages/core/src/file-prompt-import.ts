import { createExternalPromptCandidate, type ExternalPromptCandidate } from "./external-prompt-import.ts";
import { importExternalPromptTemplateCandidate, projectExternalPromptTemplate } from "./external-prompt-project.ts";
import { parseProjectFile, type ExternalImportReceipt, type ProjectFile, type PromptTemplateMessages } from "./project.ts";
import { discoverTemplateVariables, renderTemplateMessages } from "./template-engine.ts";
import type { PromptTemplateId } from "./run-kernel/types.ts";
import { scanN8nExpressionRegions } from "../../n8n/src/expression-regions.ts";
import { externalPromptProjectedMessages } from "./external-prompt-projection.ts";
import { n8nExpressionIdentity } from "../../n8n/src/expression-naming.ts";

export interface FilePromptInput {
  filename: string;
  text: string;
  role: "system" | "user" | "assistant";
  plainText: boolean;
}

/** Decode once at the host boundary; retain line endings and every other code point. */
export function decodePromptFile(bytes: ArrayBuffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** Filename and role are receipt identity; authored text is the content comparison. */
export async function createFilePromptCandidate(input: FilePromptInput): Promise<ExternalPromptCandidate> {
  const filename = input.filename.trim();
  if (!filename || /[\\/]/.test(filename)) throw new Error("Choose a file with a filename, without a path.");
  const scan = input.plainText ? { ok: true as const, regions: [] } : scanN8nExpressionRegions(input.text);
  if (!scan.ok) throw new Error(`${scan.reason} (at character ${scan.errorOffset + 1}). Choose plain text to keep it literal.`);
  const candidate = await createExternalPromptCandidate({
    source: { adapter: "file", resource: { kind: "file", id: filename, name: filename } },
    invocation: { type: "file", id: "content", name: filename.replace(/\.(md|txt)$/i, "") || filename, version: input.plainText ? "plain-text-v1" : "expression-v1" },
    authored: [{ path: "content", role: input.role, syntax: input.plainText ? "literal" : "external-expression", text: input.text }],
    bindings: scan.regions.map((region) => ({
      authoredPath: "content", expression: region.expression,
      source: { kind: "expression-span", startOffset: region.startOffset, endOffset: region.endOffset },
      // These have no captured execution value; the operator supplies inputs.
      status: "missing",
    })),
    fidelity: "authored-only", warnings: [],
  });
  projectExternalPromptTemplate(candidate);
  return candidate;
}

/** Atomic, immutable library addition. Request revisions, pins and defaults stay intact. */
export async function importFilePromptCandidates(
  projectValue: ProjectFile,
  candidates: readonly ExternalPromptCandidate[],
): Promise<{ project: ProjectFile; templateIds: PromptTemplateId[] }> {
  const original = parseProjectFile(projectValue);
  let project = original;
  const templateIds: PromptTemplateId[] = [];
  for (const candidate of candidates) {
    if (candidate.source.adapter !== "file" || candidate.authored.length !== 1) throw new Error("File import requires one whole-file prompt per candidate.");
    const imported = await importExternalPromptTemplateCandidate(project, candidate);
    // Reuse the validated receipt/template construction, discarding its
    // conversation insertion. No intermediate state is published to a host.
    project = parseProjectFile({ ...imported.project, conversationRevisions: original.conversationRevisions, defaults: original.defaults });
    templateIds.push(imported.templateId);
  }
  return { project, templateIds };
}

export type N8nFileCopy = { ok: true; text: string } | { ok: false; message: string };

/** Reverse only recorded projections; rendering unescapes literals without evaluating expressions. */
export function copyFilePromptAsN8nText(messages: PromptTemplateMessages, receipts: readonly ExternalImportReceipt[]): N8nFileCopy {
  if (messages.length !== 1) return { ok: false, message: "Copy as n8n text requires exactly one message for a file." };
  const values: Record<string, string> = Object.create(null);
  const conflicts = new Set<string>();
  for (const receipt of receipts) {
    if (receipt.source.adapter !== "file" || receipt.projection.kind !== "prompt-template") continue;
    for (const { variableName, expression } of receipt.projection.variables) {
      if (Object.hasOwn(values, variableName) && n8nExpressionIdentity(values[variableName]).key !== n8nExpressionIdentity(expression).key) conflicts.add(variableName);
      else values[variableName] = expression;
    }
  }
  const discovery = discoverTemplateVariables(messages);
  const unmapped = discovery.variables.filter(({ name }) => !Object.hasOwn(values, name) || conflicts.has(name)).map(({ name }) => name);
  if (unmapped.length) return { ok: false, message: `No unambiguous n8n expression is recorded for: ${unmapped.join(", ")}.` };
  if (discovery.diagnostics.length) return { ok: false, message: "Fix invalid template tokens before copying as n8n text." };
  // An unchanged projection can retain each occurrence's original spelling,
  // even when equivalent references collapsed into one native variable.
  for (const receipt of [...receipts].reverse()) {
    if (receipt.source.adapter !== "file" || receipt.projection.kind !== "prompt-template") continue;
    const projected = externalPromptProjectedMessages(receipt.authored, receipt.bindings, new Map(receipt.projection.variables.map(({ bindingIndex, variableName }) => [bindingIndex, variableName])), "file");
    if (JSON.stringify(projected) === JSON.stringify(messages)) return { ok: true, text: receipt.authored[0].text };
  }
  return { ok: true, text: renderTemplateMessages(messages, values).messages[0].content };
}
