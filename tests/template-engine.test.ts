import assert from "node:assert/strict";
import test from "node:test";

import {
  discoverTemplateVariables,
  renderTemplateMessages,
  renderTemplateText,
  resolveTemplateValues,
} from "../packages/core/src/template-engine.ts";

test("discovers repeated variables once and retains every location", () => {
  const result = discoverTemplateVariables([
      { role: "system", content: "Write for {{audience}}." },
      {
        role: "user",
        content: "{{topic}} for {{audience}}",
      },
    ]);

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
      text: "{{literal}}  Ada {{unmatched",
      diagnostics: [],
      occurrences: [
        {
          name: "empty",
          location: { kind: "text" },
          start: 13,
          end: 22,
        },
        {
          name: "name",
          location: { kind: "text" },
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
    text: "|{{untouched}}",
    diagnostics: [],
    occurrences: [
      {
        name: "value",
        location: { kind: "text" },
        start: 0,
        end: 9,
      },
      {
        name: "inserted",
        location: { kind: "text" },
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
  // Every unresolved token renders as itself, so the text is unchanged and the
  // caller still learns exactly what is unresolved.
  assert.equal(result.text, "{{ valid }} {{person.name}} {{missing}}");
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

test("renders single and multi-message prompts with the same parser", () => {
  assert.deepEqual(
    renderTemplateMessages(
      [{ role: "user", content: "Hello {{name}}" }],
      { name: "Lin" },
    ),
    {
      messages: [{ role: "user", content: "Hello Lin" }],
      diagnostics: [],
      variables: [
        {
          name: "name",
          occurrences: [
            {
              name: "name",
              location: { kind: "message", messageIndex: 0, role: "user" },
              start: 6,
              end: 14,
            },
          ],
        },
      ],
    },
  );

  const messages = renderTemplateMessages(
    [
        { role: "system", content: "Audience: {{audience}}" },
        { role: "user", content: "Question: {{question}}" },
      ],
    { audience: "engineers", question: "Why?" },
  );
  assert.deepEqual(messages.diagnostics, []);
  assert.deepEqual(messages.messages, [
      { role: "system", content: "Audience: engineers" },
      { role: "user", content: "Question: Why?" },
    ]);
});

test("renders unresolved variables as their own tokens", () => {
  const prompt = renderTemplateMessages(
    [{ role: "user", content: "Explain {{topic}} to {{audience}}." }],
    { audience: "" },
  );
  assert.deepEqual(prompt.messages, [{
    role: "user",
    // "audience" is present and deliberately empty; "topic" was never given a
    // value, and the two must not look alike.
    content: "Explain {{topic}} to .",
  }]);
  assert.deepEqual(
    prompt.diagnostics.map(({ code }) => code),
    ["missing-template-variable"],
  );

  const messages = renderTemplateMessages(
    [
        { role: "system", content: "Voice: {{voice}}" },
        { role: "user", content: "Question: {{question}}" },
      ],
    { voice: "clear" },
  );
  assert.deepEqual(messages.messages, [
      { role: "system", content: "Voice: clear" },
      { role: "user", content: "Question: {{question}}" },
    ]);
  assert.deepEqual(
    messages.diagnostics.map((diagnostic) =>
      diagnostic.code === "missing-template-variable" ? diagnostic.name : null,
    ),
    ["question"],
  );
});
