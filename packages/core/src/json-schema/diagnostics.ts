import type { JsonObject, JsonValue } from "../run-kernel/types.ts";

function object(value: JsonValue): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

/** Typed locations are display notation, not JSON Pointers. Only core-sanitized
 * authored property names, array indices, and redactions belong here. */
function displayLocation(value: JsonValue | undefined): string {
  if (!Array.isArray(value) || value.length === 0) return "the root";
  return value.map((segment) => {
    const part = object(segment);
    if (typeof part?.index === "number") return `[${part.index}]`;
    if (typeof part?.property === "string") return `[${JSON.stringify(part.property)}]`;
    return "[<additional property>]";
  }).join("");
}

/** Format one sanitized issue from a schema check's portable outcome evidence.
 * Callers pass evidence, never parsed answer data or native validator errors.
 * Summary and expanded diagnostics deliberately share this exact wording. */
export function formatSchemaIssue(issue: JsonObject): string {
  const at = displayLocation(issue.location);
  switch (issue.keyword) {
    case "type": {
      const expected = Array.isArray(issue.expectedType) ? issue.expectedType.join(" or ") : issue.expectedType;
      return `Schema mismatch at ${at}: expected ${expected}.`;
    }
    case "required": return `Schema mismatch at ${at}: missing required property ${JSON.stringify(issue.missingProperty)}.`;
    case "dependencies": return `Schema mismatch at ${at}: missing property ${JSON.stringify(issue.missingProperty)} required by a dependency.`;
    case "additionalProperties": return `Schema mismatch at ${at}: unexpected property.`;
    case "false": return `Schema mismatch at ${at}: no value is allowed here.`;
    default: return `Schema mismatch at ${at}: violates ${issue.keyword}.`;
  }
}
