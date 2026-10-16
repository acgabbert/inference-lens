import type { CheckDefinition, CheckOutcome } from "../../packages/core/src/checks";
import type { JsonObject, JsonValue } from "../../packages/core/src/run-kernel/types";
import styles from "./structured-check-diagnostics.module.css";

function object(value: JsonValue | undefined): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

// These segments have already been sanitized by core. Never construct paths
// from parsed answers or render the evidence object wholesale.
function location(value: JsonValue | undefined): string {
  if (!Array.isArray(value) || value.length === 0) return "the root";
  return value.map((segment) => {
    const part = object(segment);
    if (typeof part?.index === "number") return `[${part.index}]`;
    if (typeof part?.property === "string") return `[${JSON.stringify(part.property)}]`;
    return "[<additional property>]";
  }).join("");
}

function issueText(issue: JsonObject): string {
  const at = location(issue.location);
  if (issue.keyword === "type") {
    const expected = Array.isArray(issue.expectedType) ? issue.expectedType.join(" or ") : issue.expectedType;
    return `${at}: expected ${expected}.`;
  }
  if (issue.keyword === "required") return `${at}: missing required property "${issue.missingProperty}".`;
  if (issue.keyword === "dependencies") return `${at}: missing property "${issue.missingProperty}" required by a dependency.`;
  if (issue.keyword === "additionalProperties") return `${at}: unexpected property.`;
  if (issue.keyword === "false") return `${at}: no value is allowed here.`;
  return `${at}: violates ${issue.keyword}.`;
}

/** Presentation only: consumes portable, sanitized evidence; never re-evaluates
 * a schema or reads/copies provider output. Shared by every result reading. */
export function StructuredCheckDiagnostics({ definition, outcome }: {
  definition: CheckDefinition;
  outcome: CheckOutcome;
}) {
  if (definition.kind !== "json-schema" && definition.kind !== "valid-json") return null;
  if (outcome.status === "not-evaluated") return null;
  const evidence = object(outcome.evidence);
  if (!evidence) return null;
  const issues = Array.isArray(evidence.issues) ? evidence.issues.map(object).filter((item) => item !== undefined) : [];
  const formats = Array.isArray(evidence.uncheckedFormats) ? evidence.uncheckedFormats.map(object).filter((item) => item !== undefined) : [];
  const path = typeof evidence.path === "string" ? evidence.path
    : definition.kind === "valid-json" && evidence.valid === true ? "whole-answer" : undefined;
  return <details aria-label="Structured check diagnostics" className={styles.diagnostics}>
    <summary>Structured check diagnostics</summary>
    <div className={styles.content}>
      <p>Input policy: {definition.inputPolicy ?? "strict"}</p>
      {path && <p>Extraction: {path}</p>}
      {typeof evidence.code === "string" && <p>Diagnostic code: {evidence.code}</p>}
      {typeof evidence.characters === "number" && <p>Original output characters: {evidence.characters}</p>}
      {typeof evidence.topLevel === "string" && <p>Observed JSON type: {evidence.topLevel}</p>}
      {typeof evidence.codeUnits === "number" && <p>Original output UTF-16 code units: {evidence.codeUnits} · Limit: {String(evidence.limit)}</p>}
      {Array.isArray(evidence.issues) && <>
        <p>Issues listed: {issues.length}</p>
        <ol>{issues.map((issue, index) => <li key={index}>{issueText(issue)}</li>)}</ol>
        {evidence.truncated === true && <p>More issues may exist than are listed.</p>}
      </>}
      {formats.length > 0 && <>
        <p>Formats are annotations and do not affect the verdict.</p>
        <ul>{formats.map((format, index) => <li key={index}>/{Array.isArray(format.schemaPath) ? format.schemaPath.join("/") : ""}: {String(format.format)} (not checked)</li>)}</ul>
      </>}
    </div>
  </details>;
}
