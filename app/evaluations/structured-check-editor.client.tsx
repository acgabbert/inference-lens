"use client";

import { useState } from "react";
import type { CheckDefinition } from "../../packages/core/src/checks";
import { parseJsonInput, type JsonInputPolicy } from "../../packages/core/src/json-input";
import { generateJsonSchema } from "../../packages/core/src/json-schema/generate";
import { SCHEMA_CHECK_LIMITS } from "../../packages/core/src/json-schema/limits";
import { preflightJsonSchema } from "../../packages/core/src/json-schema/preflight";
import type { JsonObject } from "../../packages/core/src/run-kernel/types";

type StructuredCheck = Extract<CheckDefinition, { kind: "json-schema" | "valid-json" }>;

// Keep generated schemas saveable when indentation would exceed the text limit.
function schemaDraft(schema: JsonObject | boolean): string {
  const pretty = JSON.stringify(schema, null, 2);
  return pretty.length <= SCHEMA_CHECK_LIMITS.schema.maxSchemaCodeUnits ? pretty : JSON.stringify(schema);
}

function uncheckedFormatsOf(check: StructuredCheck): string[] {
  if (check.kind !== "json-schema") return [];
  const result = preflightJsonSchema(check.schema, SCHEMA_CHECK_LIMITS.schema);
  return result.status === "ready" ? result.prepared.uncheckedFormats.map(({ format, schemaPath }) => `/${schemaPath.join("/")}: ${format}`) : [];
}

/** Owns ephemeral drafts. Its caller commits a validated definition through the
 * feature's existing mutation workflow; no draft/example enters project data. */
export function StructuredCheckEditor({ check, onCommit }: {
  check: StructuredCheck;
  onCommit(check: StructuredCheck): boolean;
}) {
  const initialSchema = check.kind === "json-schema" ? schemaDraft(check.schema) : "";
  const [schemaText, setSchemaText] = useState(initialSchema);
  const [policy, setPolicy] = useState(check.inputPolicy ?? "strict");
  const [example, setExample] = useState("");
  const [disallowExtras, setDisallowExtras] = useState(false);
  const [emptyArray, setEmptyArray] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [uncheckedFormats, setUncheckedFormats] = useState(() => uncheckedFormatsOf(check));
  function reset() {
    setSchemaText(initialSchema);
    setPolicy(check.inputPolicy ?? "strict");
    setExample(""); setDisallowExtras(false); setEmptyArray(false); setError(undefined); setSaved(false);
    setUncheckedFormats(uncheckedFormatsOf(check));
  }
  function save() {
    setError(undefined); setSaved(false);
    let next = { ...check, inputPolicy: policy };
    if (check.kind === "json-schema") {
      if (schemaText.length > SCHEMA_CHECK_LIMITS.schema.maxSchemaCodeUnits) {
        setError("The schema draft exceeds the size limit."); return;
      }
      const parsed = parseJsonInput(schemaText);
      if (!parsed.valid) { setError("Enter a valid JSON schema."); return; }
      const result = preflightJsonSchema(parsed.value, SCHEMA_CHECK_LIMITS.schema);
      if (result.status !== "ready") {
        setError(`${result.diagnostic.message} Schema location: /${result.diagnostic.schemaPath.join("/")}`); return;
      }
      next = { ...check, inputPolicy: policy, schema: parsed.value as JsonObject | boolean };
      setUncheckedFormats(uncheckedFormatsOf(next));
    }
    if (onCommit(next)) setSaved(true);
    else setError("The structured check could not be saved. Review the draft and try again.");
  }
  return <section aria-label="Structured check editor">
    <label>JSON input policy
      <select value={policy} onChange={(event) => { setPolicy(event.target.value as JsonInputPolicy); setSaved(false); }}>
        <option value="strict">Strict whole-answer JSON</option>
        <option value="surrounding-fence">Allow one surrounding JSON fence</option>
        <option value="first-json-fence">Use first JSON fence; ignore other answer content</option>
      </select>
    </label>
    {check.kind === "json-schema" && <>
      <p>Draft-07 profile. Schema changes apply after saving.</p>
      <label>Schema draft<textarea aria-label="Schema draft" rows={10} value={schemaText} spellCheck={false} onChange={(event) => { setSchemaText(event.target.value); setUncheckedFormats([]); setSaved(false); }} /></label>
      <details>
        <summary>Generate from a JSON example</summary>
        <p>Observed fields become required. Edit the schema to make fields optional. One example does not establish every valid shape. Extra properties stay allowed unless disallowed below.</p>
        <label>JSON example<textarea aria-label="JSON example" rows={5} value={example} spellCheck={false} onChange={(event) => setExample(event.target.value)} /></label>
        <label><input type="checkbox" checked={disallowExtras} onChange={(event) => setDisallowExtras(event.target.checked)} /> Disallow extra properties at every object level</label>
        <button className="button secondary" type="button" onClick={() => {
          setSaved(false); setError(undefined);
          const result = generateJsonSchema(example, { disallowExtraProperties: disallowExtras });
          if (result.status !== "ready") { setError(result.message); return; }
          setSchemaText(schemaDraft(result.schema)); setUncheckedFormats([]);
          setEmptyArray(result.warnings.includes("empty-array"));
        }}>Generate schema</button>
      </details>
      {emptyArray && <p>Empty arrays do not establish item types; their generated items accept any JSON value.</p>}
      {uncheckedFormats.map((format, index) => <p key={index}>Format not checked: {format}</p>)}
    </>}
    {error && <p className="evaluation-field-error" role="alert">{error}</p>}
    {saved && <p role="status">Structured check saved.</p>}
    <div className="evaluation-check-options">
      <button className="button secondary" type="button" onClick={save}>Save structured check</button>
      <button className="text-button" type="button" onClick={reset}>Cancel draft</button>
    </div>
  </section>;
}
