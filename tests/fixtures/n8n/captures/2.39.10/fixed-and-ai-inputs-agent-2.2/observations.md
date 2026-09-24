# Fixed and AI inputs with AI Agent 2.2

The parent and child executions succeeded with AI Agent `2.2`, OpenAI Chat
Model `1.2`, Call n8n Workflow Tool `2.2`, and Execute Sub-workflow Trigger
`1.1`. The parent used the same controlled provider scenario and fixed-and-AI
child workflow as the Agent `3.1` capture.

- The parent mapped `text` with `$fromAI('text', ...)` and `source` to the fixed
  literal `IL_N0_FIXED_SOURCE`. The model-visible tool schema contained only
  required string property `text`; it did not expose `source`.
- The scripted call supplied only `text: "IL_N0_AI_TEXT"`. The child trigger
  received that text and `source: "IL_N0_FIXED_SOURCE"`, then returned both in
  one item.
- The continuation linked the tool result to the call ID. Its assistant call
  arguments remained `{"text":"IL_N0_AI_TEXT"}`, without the added `id`
  observed in Agent `3` and `3.1`. Its tool-result content was an indented JSON
  array string containing the same item.
- The provider returned `IL_N0_CAPTURE_COMPLETE`, and the parent saved it as
  the final answer.

The redacted fixture contains no provider credential, instance URL, or source
workflow and execution IDs. Raw evidence remains in ignored
`.n8n-contract-staging/`. The `2.39.10` instance-version label follows the
user's earlier confirmation; the read-only API did not provide an instance
version header.
