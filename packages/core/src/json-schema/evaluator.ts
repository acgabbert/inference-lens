import type { JsonObject, JsonValue } from "../run-kernel/types.ts";
import { DataEncodings, DataStop, indexData, type JsonDataNode } from "./data.ts";
import { preflightJsonSchema, type PreparedSchema, type SchemaPreflightDiagnostic } from "./preflight.ts";
import { SchemaMeter, SchemaStop, textWork, WORK, type SchemaJsonNode, type SchemaLimits, type SchemaStats } from "./resources.ts";

/** Internal limits contract. Production limits and accounting are frozen with
 * check vocabulary v4; see limits.ts. They are not serialized per check. */
export interface SchemaEvaluationLimits {
  schema: SchemaLimits;
  verdict: { workLimit: number; storageLimit: number };
  diagnostics: { workLimit: number; storageLimit: number; maxIssues: number };
  maxDataDepth: number;
}

export type SafeLocationSegment = { property: string } | { index: number } | { redacted: true };
export interface SchemaIssue {
  code: "schema-mismatch";
  keyword: string;
  location: readonly SafeLocationSegment[];
  expectedType?: string | readonly string[];
  missingProperty?: string;
}

type EvaluationCode = "work-limit" | "storage-limit" | "data-depth-limit" | "non-json-data";
interface EvaluationStats {
  preflight: SchemaStats;
  verdict: SchemaStats;
  diagnostics: SchemaStats;
}
export type SchemaEvaluationResult =
  | { status: "not-evaluated"; diagnostic: SchemaPreflightDiagnostic | { code: EvaluationCode; message: string }; stats: EvaluationStats }
  | { status: "valid" | "invalid"; issues: SchemaIssue[]; truncated: boolean; uncheckedFormats: PreparedSchema["uncheckedFormats"]; stats: EvaluationStats };

type Request = { sid: number; node: JsonDataNode; location: readonly SafeLocationSegment[]; explain: boolean };
type Constraints = Generator<Request, boolean, boolean>;

/**
 * Evaluate parsed JSON without changing it. Preparation, verdict, and diagnostics
 * have independent meters. All schema/data descent uses an explicit task stack;
 * generator suspension never nests a native call to another evaluator.
 */
export function evaluateJsonSchema(schema: unknown, data: JsonValue, limits: SchemaEvaluationLimits): SchemaEvaluationResult {
  const verdictMeter = new SchemaMeter({ ...limits.schema, ...limits.verdict, maxDepth: limits.maxDataDepth, maxSchemaCodeUnits: Number.MAX_SAFE_INTEGER });
  const diagnosticMeter = new SchemaMeter({ ...limits.schema, ...limits.diagnostics });
  if (!Number.isSafeInteger(limits.diagnostics.maxIssues) || limits.diagnostics.maxIssues < 0) {
    throw new Error("Schema limits must be non-negative safe integers.");
  }
  const preflight = preflightJsonSchema(schema, limits.schema);
  const stats: EvaluationStats = { preflight: preflight.stats, verdict: verdictMeter.stats, diagnostics: diagnosticMeter.stats };
  if (preflight.status !== "ready") return { status: "not-evaluated", diagnostic: preflight.diagnostic, stats };
  const prepared = preflight.prepared;
  let meter = verdictMeter;
  let explaining = false;
  const memo = new Map<number, Map<number, boolean>>();
  const names = new Map<number, JsonDataNode>();
  const encodings = new DataEncodings();
  let syntheticId = -1;
  const issues: SchemaIssue[] = [];
  let truncated = false;

  function lookup(sid: number, node: JsonDataNode): boolean | undefined {
    meter.work();
    return memo.get(sid)?.get(node.id);
  }
  function remember(sid: number, node: JsonDataNode, valid: boolean): void {
    if (!memo.has(sid)) { meter.retain(2); memo.set(sid, new Map()); }
    meter.retain(3);
    memo.get(sid)!.set(node.id, valid);
  }
  function segment(location: readonly SafeLocationSegment[], value: SafeLocationSegment): readonly SafeLocationSegment[] {
    if (!explaining) return [];
    meter.work(location.length + 1); meter.retain(location.length + 2);
    return [...location, value];
  }
  function issue(keyword: string, location: readonly SafeLocationSegment[], expected: Partial<SchemaIssue> = {}): void {
    if (!explaining) return;
    meter.work();
    if (issues.length === limits.diagnostics.maxIssues) { truncated = true; return; }
    meter.retain(keyword.length + location.length + 4);
    issues.push({ code: "schema-mismatch", keyword, location, ...expected });
  }
  function equal(a: JsonDataNode, b: SchemaJsonNode): boolean {
    const encoding = encodings.canonical(a, meter);
    meter.work(WORK.node + textWork(encoding.length + b.encoding.length, WORK.copyText));
    return encoding === b.encoding;
  }
  function decimal(number: number): { coefficient: bigint; exponent: number } {
    const text = number.toString();
    const [mantissa, exponent = "0"] = text.split("e");
    const dot = mantissa.indexOf(".");
    return { coefficient: BigInt(mantissa.replace(".", "")), exponent: Number(exponent) - (dot < 0 ? 0 : mantissa.length - dot - 1) };
  }
  function multipleOf(number: number, divisor: number): boolean {
    const a = decimal(number);
    const b = decimal(divisor);
    const shift = a.exponent - b.exponent;
    meter.work(WORK.multiple + textWork(Math.abs(shift), WORK.shiftDigits)); meter.retain(Math.abs(shift) + 1);
    return shift >= 0
      ? (a.coefficient * BigInt(10) ** BigInt(shift)) % b.coefficient === BigInt(0)
      : a.coefficient % (b.coefficient * BigInt(10) ** BigInt(-shift)) === BigInt(0);
  }
  function* constraints(sid: number, node: JsonDataNode, location: readonly SafeLocationSegment[]): Constraints {
    meter.work();
    const record = prepared.nodes.get(sid)!;
    const schemaNode = record.node;
    const raw = schemaNode.value;
    if (typeof raw === "boolean") { if (!raw) issue("false", location); return raw; }
    if (record.reference !== undefined) return yield { sid: record.reference, node, location, explain: true };
    const s = raw as JsonObject;
    const sub = (key: string): SchemaJsonNode => schemaNode.children.get(key)!;
    const has = (key: string): boolean => schemaNode.children.has(key);
    const kind = node.value === null ? "null" : Array.isArray(node.value) ? "array" : typeof node.value;
    let valid = true;
    function assert(condition: boolean, keyword: string, expected: Partial<SchemaIssue> = {}): void {
      meter.work();
      if (!condition) { valid = false; issue(keyword, location, expected); }
    }
    if (has("type")) {
      const choices = (Array.isArray(s.type) ? s.type : [s.type]) as string[];
      let matches = false;
      for (const type of choices) {
        meter.work();
        if (type === kind || (type === "integer" && kind === "number" && Number.isInteger(node.value))) matches = true;
      }
      assert(matches, "type", { expectedType: Array.isArray(s.type) ? [...choices] : choices[0] });
    }
    if (has("const")) assert(equal(node, sub("const")), "const");
    if (has("enum")) {
      let matches = false;
      for (const candidate of sub("enum").children.values()) {
        meter.work();
        if (equal(node, candidate)) { matches = true; break; }
      }
      assert(matches, "enum");
    }
    if (typeof node.value === "number") {
      const n = node.value;
      if (has("minimum")) assert(n >= (s.minimum as number), "minimum");
      if (has("maximum")) assert(n <= (s.maximum as number), "maximum");
      if (has("exclusiveMinimum")) assert(n > (s.exclusiveMinimum as number), "exclusiveMinimum");
      if (has("exclusiveMaximum")) assert(n < (s.exclusiveMaximum as number), "exclusiveMaximum");
      if (has("multipleOf")) assert(multipleOf(n, s.multipleOf as number), "multipleOf");
    }
    if (typeof node.value === "string" && (has("minLength") || has("maxLength"))) {
      // Charge the whole scan before it runs; the loop itself stays unmetered.
      meter.work(WORK.node + textWork(node.value.length, WORK.scanText));
      let length = 0;
      for (const character of node.value) { if (character) length++; }
      if (has("minLength")) assert(length >= (s.minLength as number), "minLength");
      if (has("maxLength")) assert(length <= (s.maxLength as number), "maxLength");
    }
    if (kind === "object") {
      if (has("minProperties")) assert(node.children.size >= (s.minProperties as number), "minProperties");
      if (has("maxProperties")) assert(node.children.size <= (s.maxProperties as number), "maxProperties");
      for (const key of (s.required ?? []) as string[]) {
        meter.work(WORK.key);
        assert(node.children.has(key), "required", { missingProperty: key });
      }
      const properties = sub("properties")?.children;
      for (const [key, value] of node.children) {
        meter.work(WORK.key);
        const declared = properties?.get(key);
        if (declared || has("additionalProperties")) {
          const safeLocation = segment(location, declared ? { property: key } : { redacted: true });
          if (!declared && s.additionalProperties === false) {
            meter.work();
            valid = false;
            issue("additionalProperties", safeLocation);
          } else {
            const target = declared ?? sub("additionalProperties");
            if (!(yield { sid: target.id, node: value, location: safeLocation, explain: true })) valid = false;
          }
        }
        if (has("propertyNames")) {
          let name = names.get(value.id);
          if (!name) {
            meter.work(WORK.key); meter.retain(key.length + 8);
            name = { id: syntheticId--, value: key, children: new Map() };
            names.set(value.id, name);
          }
          assert(yield { sid: sub("propertyNames").id, node: name, location, explain: false }, "propertyNames");
        }
      }
      for (const [key, dependency] of sub("dependencies")?.children ?? []) {
        meter.work(WORK.key);
        if (!node.children.has(key)) continue;
        if (Array.isArray(dependency.value)) {
          for (const required of dependency.value as string[]) {
            meter.work(WORK.key);
            assert(node.children.has(required), "dependencies", { missingProperty: required });
          }
        } else if (!(yield { sid: dependency.id, node, location, explain: true })) valid = false;
      }
    }
    if (Array.isArray(node.value)) {
      if (has("minItems")) assert(node.children.size >= (s.minItems as number), "minItems");
      if (has("maxItems")) assert(node.children.size <= (s.maxItems as number), "maxItems");
      if (has("items")) {
        for (const [key, value] of node.children) {
          meter.work();
          const item = Array.isArray(s.items) ? sub("items").children.get(key) : sub("items");
          const target = item ?? sub("additionalItems");
          if (target && !(yield { sid: target.id, node: value, location: segment(location, { index: Number(key) }), explain: true })) valid = false;
        }
      }
      if (has("contains")) {
        let found = false;
        for (const item of node.children.values()) {
          meter.work();
          if (yield { sid: sub("contains").id, node: item, location, explain: false }) { found = true; break; }
        }
        assert(found, "contains");
      }
      if (s.uniqueItems === true) {
        const seen = new Set<string>();
        let unique = true;
        for (const item of node.children.values()) {
          const encoding = encodings.canonical(item, meter);
          // Set membership hashes the encoding once.
          meter.work(WORK.node + textWork(encoding.length, WORK.scanText)); meter.retain(encoding.length + 1);
          if (seen.has(encoding)) { unique = false; break; }
          seen.add(encoding);
        }
        assert(unique, "uniqueItems");
      }
    }
    for (const item of sub("allOf")?.children.values() ?? []) {
      meter.work();
      if (!(yield { sid: item.id, node, location, explain: true })) valid = false;
    }
    for (const keyword of ["anyOf", "oneOf"]) {
      if (!has(keyword)) continue;
      let matches = 0;
      for (const item of sub(keyword).children.values()) {
        meter.work();
        if (yield { sid: item.id, node, location, explain: false }) matches++;
      }
      assert(keyword === "anyOf" ? matches > 0 : matches === 1, keyword);
    }
    if (has("not")) assert(!(yield { sid: sub("not").id, node, location, explain: false }), "not");
    if (has("if")) {
      const branch = (yield { sid: sub("if").id, node, location, explain: false }) ? "then" : "else";
      if (has(branch) && !(yield { sid: sub(branch).id, node, location, explain: true })) valid = false;
    }
    return valid;
  }
  function decide(sid: number, node: JsonDataNode): boolean {
    type Frame = { sid: number; node: JsonDataNode; iterator: Constraints };
    const stack: Frame[] = [];
    function push(sid: number, node: JsonDataNode): void {
      meter.work(WORK.frame); meter.retain(4);
      stack.push({ sid, node, iterator: constraints(sid, node, []) });
    }
    push(sid, node);
    let returned = false;
    while (stack.length) {
      meter.work();
      const frame = stack[stack.length - 1];
      const next = frame.iterator.next(returned);
      if (next.done) {
        returned = next.value;
        remember(frame.sid, frame.node, returned);
        stack.pop();
      } else {
        const cached = lookup(next.value.sid, next.value.node);
        if (cached !== undefined) returned = cached;
        else push(next.value.sid, next.value.node);
      }
    }
    return returned;
  }
  let root: JsonDataNode;
  let valid: boolean;
  try {
    root = indexData(data, verdictMeter);
    valid = decide(prepared.root, root);
  } catch (error) {
    if (!(error instanceof SchemaStop) && !(error instanceof DataStop)) throw error;
    const code: EvaluationCode = error instanceof DataStop ? error.code
      : error.code === "storage-limit" ? "storage-limit" : "work-limit";
    return { status: "not-evaluated", diagnostic: { code, message: "Schema evaluation could not finish within the supported data and resource limits." }, stats };
  }
  if (!valid) {
    meter = diagnosticMeter;
    explaining = true;
    try {
      const frames: { iterator: Constraints; returned: boolean }[] = [];
      const seen = new Set<string>();
      function descend(task: Request): void {
        // Paths contain authored property names, array indices, or redactions only.
        meter.work(task.location.length + 1);
        const key = `${task.sid}:${task.node.id}:${JSON.stringify(task.location)}`;
        meter.work(key.length); meter.retain(key.length + 1);
        if (seen.has(key)) return;
        seen.add(key);
        meter.work(WORK.frame); meter.retain(4);
        frames.push({ iterator: constraints(task.sid, task.node, task.location), returned: false });
      }
      descend({ sid: prepared.root, node: root, location: [], explain: true });
      while (frames.length && !truncated) {
        meter.work();
        const frame = frames[frames.length - 1];
        const next = frame.iterator.next(frame.returned);
        if (next.done) { frames.pop(); continue; }
        const request = next.value;
        const cached = lookup(request.sid, request.node);
        if (cached === undefined) {
          // Diagnostics cannot invalidate a completed decision, even if an
          // internal memo invariant is broken. Retain any issues found so far.
          truncated = true;
          break;
        }
        frame.returned = cached;
        // Suspend the parent at its first failing child. Wide nodes must not
        // spend the diagnostic budget scheduling siblings before any location.
        if (!cached && request.explain) descend(request);
      }
    } catch (error) {
      if (!(error instanceof SchemaStop)) throw error;
      truncated = true;
    }
  }
  return { status: valid ? "valid" : "invalid", issues, truncated, uncheckedFormats: prepared.uncheckedFormats, stats };
}
