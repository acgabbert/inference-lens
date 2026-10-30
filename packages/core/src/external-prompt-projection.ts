import type { AuthoredPromptField, ExpressionBinding } from "./external-prompt-import.ts";
import type { PromptTemplateMessages } from "./project.ts";

/** Native rendering consumes one backslash before each opening delimiter. */
function escapeExternalPromptLiteral(text: string, adapter: string): string {
  // Keep existing adapters' historical projection; files escape from v1 onward.
  return adapter === "file" ? text.replaceAll("{{", "\\{{") : text;
}

/** Shared by import, receipt validation, and reverse-copy comparison. */
export function externalPromptProjectedMessages(
  authored: readonly AuthoredPromptField[],
  bindings: readonly ExpressionBinding[],
  variableByBindingIndex: ReadonlyMap<number, string>,
  adapter: string,
): Array<PromptTemplateMessages[number] | undefined> {
  return authored.map((field) => {
    if (!field.role) return undefined;
    const indexed = bindings.map((binding, index) => ({ binding, index }))
      .filter(({ binding }) => binding.authoredPath === field.path);
    const whole = indexed.find(({ binding }) => binding.source.kind === "whole-field");
    if (whole) return { role: field.role, content: `{{${variableByBindingIndex.get(whole.index) ?? ""}}}` };
    let cursor = field.contentSpan?.startOffset ?? 0;
    const end = field.contentSpan?.endOffset ?? field.text.length;
    const parts: string[] = [];
    const spans = indexed.flatMap(({ binding, index }) => binding.source.kind === "expression-span"
      ? [{ source: binding.source, index }] : []).sort((a, b) => a.source.startOffset - b.source.startOffset);
    for (const { source, index } of spans) {
      parts.push(escapeExternalPromptLiteral(field.text.slice(cursor, source.startOffset), adapter));
      parts.push(`{{${variableByBindingIndex.get(index) ?? ""}}}`);
      cursor = source.endOffset;
    }
    parts.push(escapeExternalPromptLiteral(field.text.slice(cursor, end), adapter));
    return { role: field.role, content: parts.join("") };
  });
}
