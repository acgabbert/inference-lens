import assert from "node:assert/strict";
import test from "node:test";

import {
  discoverTemplateVariables,
  renderTemplateContent,
  renderTemplateText,
  resolveTemplateValues,
} from "../packages/core/src/template-engine.ts";

test("discovers repeated variables once and retains every location", () => {
  const result = discoverTemplateVariables({
    kind: "messages",
    messages: [
      { role: "system", content: "Write for {{audience}}." },
      {
        role: "user",
        content: "{{topic}} for {{audience}}",
      },
    ],
  });

  assert.deepEqual(
    result.variables.map(({ name, occurrences }) => ({
      name,
      locations: occurrences.map(({ location }) => location),
    })),
    [
      {
        name: "audience",
        locations: [
          { kind: "message", messageIndex: 0, role: "system" },
          { kind: "message", messageIndex: 1, role: "user" },
        ],
      },
      {
        name: "topic",
        locations: [{ kind: "message", messageIndex: 1, role: "user" }],
      },
    ],
  );
  assert.deepEqual(result.diagnostics, []);
});

test("renders escapes, explicit empty values, and unmatched braces literally", () => {
  assert.deepEqual(
    renderTemplateText(
      String.raw`\{{literal}} {{empty}} {{name}} {{unmatched`,
      { empty: "", name: "Ada" },
    ),
    {
      ok: true,
      text: "{{literal}}  Ada {{unmatched",
      occurrences: [
        {
          name: "empty",
          location: { kind: "fragment" },
          start: 13,
          end: 22,
        },
        {
          name: "name",
          location: { kind: "fragment" },
          start: 23,
          end: 31,
        },
      ],
    },
  );
});

test("uses presence-based precedence and does not recursively render values", () => {
  const values = resolveTemplateValues(
    { value: "default", untouched: "default" },
    { value: "saved" },
    { value: "", inserted: "{{untouched}}" },
  );
  assert.deepEqual(values, {
    value: "",
    untouched: "default",
    inserted: "{{untouched}}",
  });
  assert.deepEqual(renderTemplateText("{{value}}|{{inserted}}", values), {
    ok: true,
    text: "|{{untouched}}",
    occurrences: [
      {
        name: "value",
        location: { kind: "fragment" },
        start: 0,
        end: 9,
      },
      {
        name: "inserted",
        location: { kind: "fragment" },
        start: 10,
        end: 22,
      },
    ],
  });
});

test("returns structured diagnostics for invalid and missing variables", () => {
  const result = renderTemplateText(
    "{{ valid }} {{person.name}} {{missing}}",
    {},
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      ...("name" in diagnostic ? { name: diagnostic.name } : {}),
      ...("token" in diagnostic ? { token: diagnostic.token } : {}),
    })),
    [
      { code: "invalid-template-token", token: "{{ valid }}" },
      { code: "invalid-template-token", token: "{{person.name}}" },
      { code: "missing-template-variable", name: "missing" },
    ],
  );
});

test("renders fragments and message sets with the same parser", () => {
  assert.deepEqual(
    renderTemplateContent(
      { kind: "fragment", text: "Hello {{name}}" },
      { name: "Lin" },
    ),
    {
      ok: true,
      content: { kind: "fragment", text: "Hello Lin" },
      variables: [
        {
          name: "name",
          occurrences: [
            {
              name: "name",
              location: { kind: "fragment" },
              start: 6,
              end: 14,
            },
          ],
        },
      ],
    },
  );

  const messages = renderTemplateContent(
    {
      kind: "messages",
      messages: [
        { role: "system", content: "Audience: {{audience}}" },
        { role: "user", content: "Question: {{question}}" },
      ],
    },
    { audience: "engineers", question: "Why?" },
  );
  assert.equal(messages.ok, true);
  if (!messages.ok) return;
  assert.deepEqual(messages.content, {
    kind: "messages",
    messages: [
      { role: "system", content: "Audience: engineers" },
      { role: "user", content: "Question: Why?" },
    ],
  });
});
