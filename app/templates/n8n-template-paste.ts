import { isSensitiveTemplateVariableName } from "../../packages/core/src/project.ts";
import {
  allocateN8nVariableName,
  n8nExpressionIdentity,
  suggestN8nExpressionName,
} from "../../packages/n8n/src/expression-naming.ts";
import {
  scanN8nExpressionRegions,
  type N8nExpressionRegion,
} from "../../packages/n8n/src/expression-regions.ts";

export type N8nPasteMappingNameSource =
  | "direct-reference"
  | "single-dependency"
  | "surrounding-label"
  | "fallback";

export interface N8nPasteMappingDraft {
  id: string;
  expressions: string[];
  variableName: string;
  suggestedName: string;
  nameSource: N8nPasteMappingNameSource;
  occurrences: number;
}

export interface N8nPasteRegionDraft extends N8nExpressionRegion {
  kind: "native" | "n8n";
  mappingId?: string;
}

export interface N8nPasteAnalysis {
  source: string;
  regions: N8nPasteRegionDraft[];
  mappings: N8nPasteMappingDraft[];
  reservedNativeNames: string[];
  wholeFieldMarkerOffset?: number;
}

export type N8nPasteMaterialization =
  | { ok: true; content: string; mappings: N8nPasteMappingDraft[]; removedWholeFieldMarker: boolean }
  | { ok: false; errors: Array<{ mappingId?: string; code: "invalid-name" | "sensitive-name" | "duplicate-name" | "stale-analysis"; message: string }> };

const nativeBody = /^[ \t\r\n]*([A-Za-z_][A-Za-z0-9_]*)[ \t\r\n]*$/;
const nativeName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const n8nEvidence = /\$(?:json|input|node|items|binary|env|workflow|execution|now|today)\b|\$\s*\(/;

function nativeTokenName(expression: string): string | undefined {
  return nativeBody.exec(expression.slice(2, -2))?.[1];
}

function surroundingLabel(source: string, start: number): string | undefined {
  const lineStart = Math.max(0, source.lastIndexOf("\n", start - 1) + 1);
  const before = source.slice(lineStart, start);
  return /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*(?:=|:)[ \t]*$/.exec(before)?.[1];
}

export function analyzeN8nTemplatePaste(source: string): N8nPasteAnalysis | { ok: false; message: string; offset: number } {
  const wholeFieldMarkerOffset = source.startsWith("=") ? 0 : undefined;
  const scannerSource = wholeFieldMarkerOffset === undefined ? source : source.slice(1);
  const scan = scanN8nExpressionRegions(scannerSource);
  if (!scan.ok) return { ok: false, message: scan.reason, offset: scan.errorOffset + (wholeFieldMarkerOffset === undefined ? 0 : 1) };
  const regions: N8nPasteRegionDraft[] = scan.regions.map((region) => ({
    ...region,
    startOffset: region.startOffset + (wholeFieldMarkerOffset === undefined ? 0 : 1),
    endOffset: region.endOffset + (wholeFieldMarkerOffset === undefined ? 0 : 1),
    kind: nativeTokenName(region.expression) ? "native" as const : "n8n" as const,
  }));
  const reservedNativeNames = regions.flatMap((region) => region.kind === "native" ? [nativeTokenName(region.expression)!] : []);
  const used = new Set(reservedNativeNames);
  const fallbackIndex = { value: 0 };
  const byIdentity = new Map<string, N8nPasteMappingDraft>();
  for (const region of regions) {
    if (region.kind === "native") continue;
    const identity = n8nExpressionIdentity(region.expression);
    let mapping = byIdentity.get(identity.key);
    if (!mapping) {
      const suggestion = suggestN8nExpressionName(region.expression, isSensitiveTemplateVariableName);
      let nameSource: N8nPasteMappingNameSource = suggestion.source;
      let preferred = suggestion.name;
      if (!preferred) {
        const label = surroundingLabel(source, region.startOffset);
        if (label && !isSensitiveTemplateVariableName(label)) {
          preferred = label;
          nameSource = "surrounding-label";
        }
      }
      const variableName = allocateN8nVariableName(preferred, used, fallbackIndex);
      mapping = { id: `mapping-${byIdentity.size + 1}`, expressions: [region.expression], variableName, suggestedName: variableName, nameSource, occurrences: 0 };
      byIdentity.set(identity.key, mapping);
    } else if (!mapping.expressions.includes(region.expression)) mapping.expressions.push(region.expression);
    mapping.occurrences += 1;
    region.mappingId = mapping.id;
  }
  return { source, regions, mappings: [...byIdentity.values()], reservedNativeNames, wholeFieldMarkerOffset };
}

export function materializeN8nTemplatePaste(analysis: N8nPasteAnalysis, mappings: N8nPasteMappingDraft[]): N8nPasteMaterialization {
  const errors: Extract<N8nPasteMaterialization, { ok: false }>['errors'] = [];
  const byId = new Map(mappings.map((mapping) => [mapping.id, mapping]));
  const used = new Set(analysis.reservedNativeNames);
  for (const original of analysis.mappings) {
    const mapping = byId.get(original.id);
    if (!mapping || !nativeName.test(mapping.variableName)) errors.push({ mappingId: original.id, code: "invalid-name", message: "Variable names use letters, numbers, and underscores, and cannot start with a number." });
    else if (isSensitiveTemplateVariableName(mapping.variableName)) errors.push({ mappingId: original.id, code: "sensitive-name", message: "Secret-like variable names cannot be inserted." });
    else if (used.has(mapping.variableName)) errors.push({ mappingId: original.id, code: "duplicate-name", message: "Each converted variable needs a unique name." });
    else used.add(mapping.variableName);
  }
  if (errors.length) return { ok: false, errors };
  for (const region of analysis.regions) {
    if (analysis.source.slice(region.startOffset, region.endOffset) !== region.expression) return { ok: false, errors: [{ code: "stale-analysis", message: "The pasted content changed. Review it again before inserting." }] };
  }
  let content = analysis.source;
  for (const region of [...analysis.regions].filter((region) => region.kind === "n8n").sort((a, b) => b.startOffset - a.startOffset)) {
    const mapping = byId.get(region.mappingId!);
    if (!mapping) return { ok: false, errors: [{ code: "stale-analysis", message: "The conversion draft is no longer complete." }] };
    content = `${content.slice(0, region.startOffset)}{{${mapping.variableName}}}${content.slice(region.endOffset)}`;
  }
  const removedWholeFieldMarker = analysis.wholeFieldMarkerOffset === 0 && analysis.regions.some((region) => region.kind === "n8n");
  if (removedWholeFieldMarker) content = content.slice(1);
  return { ok: true, content, mappings, removedWholeFieldMarker };
}

export function shouldSuggestN8nTemplatePaste(source: string): boolean {
  const analysis = analyzeN8nTemplatePaste(source);
  if ("message" in analysis) return false;
  const n8nRegions = analysis.regions.filter((region) => region.kind === "n8n");
  return n8nRegions.length > 0 && (source.startsWith("=") || n8nEvidence.test(source) || n8nRegions.some((region) => region.expression.includes("\n") || region.expression.includes("\r")));
}
