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

test("canonicalizes permitted formatting whitespace without changing source spans", () => {
  const text = "{{topic}}|{{ topic }}|{{\ttopic\t}}|{{\r\ntopic\r\n}}";
  const result = renderTemplateText(text, { topic: "Ada" });

  assert.equal(result.text, "Ada|Ada|Ada|Ada");
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.occurrences, [
    { name: "topic", location: { kind: "text" }, start: 0, end: 9 },
    { name: "topic", location: { kind: "text" }, start: 10, end: 21 },
    { name: "topic", location: { kind: "text" }, start: 22, end: 33 },
    { name: "topic", location: { kind: "text" }, start: 34, end: 47 },
  ]);
  assert.deepEqual(
    discoverTemplateVariables([{ role: "user", content: text }]).variables,
    [{
      name: "topic",
      occurrences: [
        {
          name: "topic",
          location: { kind: "message", messageIndex: 0, role: "user" },
          start: 0,
          end: 9,
        },
        {
          name: "topic",
          location: { kind: "message", messageIndex: 0, role: "user" },
          start: 10,
          end: 21,
        },
        {
          name: "topic",
          location: { kind: "message", messageIndex: 0, role: "user" },
          start: 22,
          end: 33,
        },
        {
          name: "topic",
          location: { kind: "message", messageIndex: 0, role: "user" },
          start: 34,
          end: 47,
        },
      ],
    }],
  );
});

test("rejects non-formatting and internal whitespace in native token bodies", () => {
  const result = renderTemplateText(
    "{{\u00a0topic\u00a0}} {{topic name}} {{\u2003topic}}",
    {},
  );

  assert.deepEqual(
    result.diagnostics.map((diagnostic) =>
      diagnostic.code === "invalid-template-token" ? diagnostic.token : null,
    ),
    ["{{\u00a0topic\u00a0}}", "{{topic name}}", "{{\u2003topic}}"],
  );
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
    "{{valid name}} {{person.name}} {{missing}}",
    {},
  );
  // Every unresolved token renders as itself, so the text is unchanged and the
  // caller still learns exactly what is unresolved.
  assert.equal(result.text, "{{valid name}} {{person.name}} {{missing}}");
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      ...("name" in diagnostic ? { name: diagnostic.name } : {}),
      ...("token" in diagnostic ? { token: diagnostic.token } : {}),
    })),
    [
      { code: "invalid-template-token", token: "{{valid name}}" },
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
