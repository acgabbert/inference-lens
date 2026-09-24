# n8n tool-workflow reference stubs

These disposable workflows are the first N0 inputs for measuring the provider-
wire contract of n8n's **Call n8n Workflow Tool** node. They contain only
synthetic sentinels and no credentials, workflow IDs, project IDs, webhooks, or
instance metadata.

The disposable batch covers:

| Scenario | Parent | Sub-workflow | Boundary under test |
| --- | --- | --- | --- |
| String input | `string-input.parent.json` | `string-input.subworkflow.json` | Baseline tool name, description, string schema, arguments, and object result. |
| Primitive inputs | `primitive-inputs.parent.json` | `primitive-inputs.subworkflow.json` | String, number, and boolean schema mapping and runtime coercion. |
| Multiple output items | `multiple-output-items.parent.json` | `multiple-output-items.subworkflow.json` | Ordered multi-item result serialization from Tool Workflow `2.2`. |
| Fixed plus AI input | `fixed-and-ai-inputs.parent.json` | `fixed-and-ai-inputs.subworkflow.json` | Compare with the baseline `string-input` case: only `text` comes from the model; `source` is the literal `IL_N0_FIXED_SOURCE`. |
| Empty output | `empty-output.parent.json` | `empty-output.subworkflow.json` | Whether a child emitting zero items yields a model continuation. |
| Nested inputs | `nested-inputs.parent.json` | `nested-inputs.subworkflow.json` | Object and array input mapping, runtime types, and result serialization. |
| Workflow error | `workflow-error.parent.json` | `workflow-error.subworkflow.json` | Whether a thrown child error returns a model-visible tool result. |
| Rejected arguments | `rejected-arguments.parent.json` | `rejected-arguments.subworkflow.json` | Whether a string supplied for a number input is rejected before child execution. |
| Two attached tools | `multiple-attached-tools.parent.json` | Reuse the `string-input` and `primitive-inputs` sub-workflows. | Initial request tool order and aggregate schema. The scripted provider calls only `il_echo_string`. |

## Import and connect one scenario

1. Import the scenario's sub-workflow JSON into the disposable n8n project. For `multiple-attached-tools`, import both reused sub-workflows.
2. Import the matching parent JSON.
3. Open every parent `il_*` Call n8n Workflow Tool node and select its matching
   imported sub-workflow. Confirm that n8n refreshes the Workflow Inputs mapping
   without changing input names, fixed values, or `$fromAI()` expressions.
   For `multiple-attached-tools`, select `string-input` under `il_echo_string`
   and `primitive-inputs` under `il_echo_primitives`.
4. Attach a dedicated OpenAI-compatible test credential to `N0 OpenAI Chat
   Model`. Keep model ID `template-echo-model`, temperature `0`, and streaming
   disabled.
5. Keep both workflows inactive except while making a capture. If the installed
   n8n version requires the Execute Sub-workflow Trigger workflow to be active,
   activate only that matching sub-workflow for the duration of the test.
6. Run the parent from Manual Trigger and record the parent and child execution
   IDs before editing or upgrading any node.

Run `INFERENCE_LENS_N8N_TOOL_CAPTURE_SCENARIO=<scenario> npm run dev:n8n-tool-capture-provider`
for each scenario, using a fresh
output directory and stopping the previous provider between runs. The scripted
provider issues the fixed tool call and saves the provider requests. For
successful child outputs it checks the exact expected result; a mismatch is
saved as `provider-request-rejected.json` for local inspection. Follow
[`docs/N8N_TOOL_CAPTURE_PROVIDER.md`](../../../../docs/N8N_TOOL_CAPTURE_PROVIDER.md)
to capture and redact completed evidence.

The `workflow-error` and `rejected-arguments` scenarios intentionally have
no predicted continuation content. The provider captures the initial request
and tool-call response; if n8n sends a linked tool message, the provider saves
it without prescribing its content. If n8n stops earlier, the provider remains
in `awaiting-continuation-request`. Preserve the raw provider directory and
the parent/child execution IDs for analysis. The public API probe's
`--provider-capture` option currently requires all four provider files, so
omit that option for a one-turn error capture and do not claim a complete
two-turn fixture. The same caveat applies if `empty-output` stops without a
continuation.

These JSON files have only passed local structural checks. In particular,
whether n8n 2.39.10 accepts the `object`/`array` trigger types and the
`json` `$fromAI()` hints in `nested-inputs` must be checked during import.
Record any migration or UI rewrite before running; do not silently edit a
captured fixture in place.

## Version guard

The stubs intentionally serialize AI Agent `3.1`, OpenAI Chat Model `1.2`, Call
n8n Workflow Tool `2.2`, and Execute Sub-workflow Trigger `1.1`. After import,
inspect every node version. If n8n migrates a node, record the observed version
and do not treat that run as evidence for the serialized version.

Do not add credentials or instance-generated metadata to these files. Raw
provider and execution captures belong under `.n8n-contract-staging/`, never in
this directory.
