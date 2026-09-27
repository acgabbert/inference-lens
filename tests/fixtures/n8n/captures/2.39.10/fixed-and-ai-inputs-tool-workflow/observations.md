# Fixed and AI inputs tool workflow observations

The parent and child executions both succeeded. The parent ran the disposable
`fixed-and-ai-inputs` workflow against the controlled provider; the child ran
through Call n8n Workflow Tool `2.2`. This fixture records their redacted public
API responses and both provider requests.

- The parent mapping uses `$fromAI('text', ...)` for `text` and the literal
  `IL_N0_FIXED_SOURCE` for `source`. The provider's tool schema exposed only
  `text` as a required string property. `source` was absent from the schema.
- The provider called `il_fixed_and_ai` with
  `{"text":"IL_N0_AI_TEXT"}`. The child trigger received both
  `text: "IL_N0_AI_TEXT"` and `source: "IL_N0_FIXED_SOURCE"`.
- The child returned one item containing both values. n8n sent that item as a
  JSON-array string in a `role: "tool"` message linked to the scripted call ID.
  Its continuation also added the call ID to the assistant call arguments.
- The provider returned `IL_N0_CAPTURE_COMPLETE`; the parent saved that final
  answer.

This demonstrates that a fixed workflow input is applied by n8n after the
model's tool call, while the model-visible schema contains only the AI input,
for this workflow and n8n `2.39.10`. The version label follows the user's
confirmation for this instance; the read-only public API did not provide an
instance version header.

The projection contains no provider credential, instance URL, or source workflow
and execution IDs. Raw evidence remains in ignored `.n8n-contract-staging/`.
