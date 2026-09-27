# Primitive-input tool workflow observations

The parent and child executions both succeeded. The controlled provider saved
the initial tool definition and the continuation sent after the child ran.

- n8n exposed `il_echo_primitives` with `enabled`, `text`, and `count` as
  boolean, string, and number properties. All three were required. The schema
  included `additionalProperties: false` and the draft-07 `$schema` URL.
- The provider called the tool with `text: "IL_N0_PRIMITIVE_TEXT"`, `count: 7`,
  and `enabled: true`. The child returned those values and reported their
  runtime types as string, number, and boolean.
- The continuation retained the call ID, added it as an `id` property in the
  assistant call arguments, and sent the child's one-item output as a JSON-array
  string in the linked `role: "tool"` message.
- The provider returned `IL_N0_CAPTURE_COMPLETE`, which the parent saved as its
  output.

The user confirmed the n8n instance version as `2.39.10`. The read-only public
API did not return an instance version header.

The projection contains no provider credential, instance URL, or source workflow
and execution IDs. Raw evidence remains in ignored `.n8n-contract-staging/`.
