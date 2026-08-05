import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeN8nTemplatePaste,
  materializeN8nTemplatePaste,
  shouldSuggestN8nTemplatePaste,
} from "../app/templates/n8n-template-paste.ts";

test("n8n paste analysis names safe equivalents once and preserves native tokens", () => {
  const analysis = analyzeN8nTemplatePaste('{{topic}} {{ $json.topic }} {{ $json["topic"] }}');
  assert.ok(!("message" in analysis));
  assert.deepEqual(analysis.reservedNativeNames, ["topic"]);
  assert.equal(analysis.mappings.length, 1);
  assert.equal(analysis.mappings[0]?.variableName, "topic_2");
  assert.equal(analysis.mappings[0]?.occurrences, 2);
  const materialized = materializeN8nTemplatePaste(analysis, analysis.mappings);
  assert.deepEqual(materialized, {
    ok: true,
    content: "{{topic}} {{topic_2}} {{topic_2}}",
    mappings: analysis.mappings,
    removedWholeFieldMarker: false,
  });
});

test("n8n paste uses labels and requires editable names to remain safe", () => {
  const analysis = analyzeN8nTemplatePaste('full_name: {{ [$json.first, $json.last].join(" ") }}');
  assert.ok(!("message" in analysis));
  assert.equal(analysis.mappings[0]?.variableName, "full_name");
  assert.equal(analysis.mappings[0]?.nameSource, "surrounding-label");
  const invalid = materializeN8nTemplatePaste(analysis, [{ ...analysis.mappings[0]!, variableName: "apiKey" }]);
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.errors[0]?.code, "sensitive-name");
});

test("n8n paste removes only a leading whole-field marker and detects conservatively", () => {
  const analysis = analyzeN8nTemplatePaste('={{ $json.topic }}');
  assert.ok(!("message" in analysis));
  const materialized = materializeN8nTemplatePaste(analysis, analysis.mappings);
  assert.equal(materialized.ok, true);
  if (materialized.ok) {
    assert.equal(materialized.content, "{{topic}}");
    assert.equal(materialized.removedWholeFieldMarker, true);
  }
  assert.equal(shouldSuggestN8nTemplatePaste('{{ person.name }}'), false);
  assert.equal(shouldSuggestN8nTemplatePaste('{{ $json.topic }}'), true);
});
