import assert from "node:assert/strict";
import test from "node:test";

import { parseJsonInput } from "../packages/core/src/json-input.ts";
import type { JsonInputPolicy } from "../packages/core/src/json-input.ts";

const policies: JsonInputPolicy[] = ["strict", "surrounding-fence", "first-json-fence"];

test("whole-answer JSON takes priority for every policy and preserves all root types", () => {
  for (const text of [' {"answer":1} \n', '[1,true,null]', '"```json\\n42\\n```"', '42', '1.5', 'true', 'null']) {
    for (const policy of policies) {
      const result = parseJsonInput(text, policy);
      assert.equal(result.valid, true, text);
      if (!result.valid) continue;
      assert.equal(result.path, "whole-answer");
      assert.equal(result.inputPolicy, policy);
      assert.deepEqual(result.value, JSON.parse(text));
      const value = JSON.parse(text);
      assert.equal(result.topLevel, value === null ? "null" : Array.isArray(value) ? "array" : typeof value);
    }
  }
});

test("strict remains the default and never repairs JSON or extracts a fence", () => {
  for (const text of ['', ' ', '```json\n{}\n```', '{"a":1,}', "{'a':1}", 'answer: {}']) {
    assert.equal(parseJsonInput(text).valid, false, text);
  }
});

test("surrounding fences accept exact delimiters, case-insensitive JSON, LF and CRLF", () => {
  for (const marker of ['', 'json', 'JSON', 'JsOn']) {
    for (const newline of ['\n', '\r\n']) {
      const result = parseJsonInput(` \n \t\x60\x60\x60${marker} \t${newline}{"answer":"a\x60\x60\x60b"}${newline}\t\x60\x60\x60 \n `, "surrounding-fence");
      assert.equal(result.valid, true, JSON.stringify(result));
      if (!result.valid) continue;
      assert.equal(result.path, "surrounding-fence");
      assert.equal(result.topLevel, "object");
      assert.deepEqual(result.value, { answer: "a```b" });
    }
  }
});

test("surrounding fences reject prose, multiple blocks, and unsupported or incomplete delimiters", () => {
  for (const text of ['prose\n```json\n{}\n```', '```\n{}\n```\nprose', '```\n{}\n```\n```\n[]\n```', '~~~json\n{}\n~~~', '````json\n{}\n````', '```javascript\n{}\n```', '```json\n{}', '```json extra\n{}\n```', '```json\n{}\n````']) {
    assert.equal(parseJsonInput(text, "surrounding-fence").valid, false, text);
  }
});

test("first fence skips other-language blocks, including recognized-looking lines inside them", () => {
  const text = 'prose\n```javascript\n```json\n{"wrong":true}\n```\nthen\n```JSON\n[42]\n```\nafter';
  const result = parseJsonInput(text, "first-json-fence");
  assert.equal(result.valid, true, JSON.stringify(result));
  if (!result.valid) return;
  assert.equal(result.path, "first-json-fence");
  assert.deepEqual(result.value, [42]);
});

test("first fence selects the first complete recognized block without hunting for valid JSON", () => {
  const result = parseJsonInput('```json\ninvalid\n```\n```json\n{}\n```', "first-json-fence");
  assert.equal(result.valid, false);
  const first = parseJsonInput('before\n```\nnull\n```\n```json\n{}\n```', "first-json-fence");
  assert.equal(first.valid, true, JSON.stringify(first));
  if (first.valid) assert.equal(first.value, null);
});

test("first fence skips unsupported blocks and rejects incomplete or malformed JSON without repair", () => {
  for (const unsupported of ['~~~json\n{}\n~~~', '````json\n{}\n````', '```python\n{}\n```']) {
    const result = parseJsonInput(`${unsupported}\nprose\n\x60\x60\x60json\n42\n\x60\x60\x60`, "first-json-fence");
    assert.equal(result.valid, true, JSON.stringify(result));
    if (result.valid) assert.equal(result.value, 42);
  }
  for (const text of ['```json\n{}', '```json\n{"a":1,}\n```', "```json\n{'a':1}\n```", 'prose {"a":1}', '```json\n\n```']) {
    assert.equal(parseJsonInput(text, "first-json-fence").valid, false, text);
  }
});

test("syntax diagnostics never copy engine errors, keys, or values from the answer", () => {
  for (const policy of policies) {
    const result = parseJsonInput('```json\n{"secret-key":"secret-value",}\n```', policy);
    assert.equal(result.valid, false);
    if (result.valid) continue;
    assert.equal(result.diagnostic.code, "invalid-json");
    assert.doesNotMatch(JSON.stringify(result), /secret-key|secret-value|SyntaxError/);
  }
});

test("inline backtick spans cannot open blocks that hide a later JSON fence", () => {
  for (const prose of ['`x` is markdown', '```x` is markdown', '```language`inline`']) {
    const result = parseJsonInput(`${prose}\n\x60\x60\x60json\n42\n\x60\x60\x60`, "first-json-fence");
    assert.equal(result.valid ? result.value : result.diagnostic.code, 42, prose);
  }
});

test("recognized fence info strings allow leading spaces and tabs", () => {
  for (const marker of [' json', '\tJSON', ' \t JsOn \t']) {
    for (const policy of ["surrounding-fence", "first-json-fence"] as const) {
      const result = parseJsonInput(`\x60\x60\x60${marker}\n{"answer":42}\n\x60\x60\x60`, policy);
      assert.deepEqual(result.valid ? result.value : result.diagnostic.code, { answer: 42 }, `${policy}: ${marker}`);
    }
  }
});

test("other-language fences hide nested JSON-looking blocks through their close or EOF", () => {
  // The three-backtick block closes at the last line; the other two never close.
  for (const opening of ['```python', '````python', '~~~python']) {
    const result = parseJsonInput(`${opening}\nprint(42)\n\x60\x60\x60json\n42\n\x60\x60\x60`, "first-json-fence");
    assert.equal(result.valid, false, opening);
    if (!result.valid) assert.equal(result.diagnostic.code, "invalid-json");
  }
});
