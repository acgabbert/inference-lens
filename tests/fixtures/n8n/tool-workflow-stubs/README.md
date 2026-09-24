# n8n tool-workflow reference stubs

These disposable workflows are the first N0 inputs for measuring the provider-
wire contract of n8n's **Call n8n Workflow Tool** node. They contain only
synthetic sentinels and no credentials, workflow IDs, project IDs, webhooks, or
instance metadata.

The initial batch covers:

| Scenario | Parent | Sub-workflow | Boundary under test |
| --- | --- | --- | --- |
| String input | `string-input.parent.json` | `string-input.subworkflow.json` | Baseline tool name, description, string schema, arguments, and object result. |
| Primitive inputs | `primitive-inputs.parent.json` | `primitive-inputs.subworkflow.json` | String, number, and boolean schema mapping and runtime coercion. |
| Multiple output items | `multiple-output-items.parent.json` | `multiple-output-items.subworkflow.json` | Ordered multi-item result serialization from Tool Workflow `2.2`. |

## Import and connect one scenario

1. Import the scenario's sub-workflow JSON into the disposable n8n project.
2. Import the matching parent JSON.
3. Open the parent's `il_*` Call n8n Workflow Tool node and select the imported
   sub-workflow. Confirm that n8n refreshes the Workflow Inputs mapping without
   changing the input names or `$fromAI()` expressions.
4. Attach a dedicated OpenAI-compatible test credential to `N0 OpenAI Chat
   Model`. Keep model ID `template-echo-model`, temperature `0`, and streaming
   disabled.
5. Keep both workflows inactive except while making a capture. If the installed
   n8n version requires the Execute Sub-workflow Trigger workflow to be active,
   activate only that matching sub-workflow for the duration of the test.
6. Run the parent from Manual Trigger and record the parent and child execution
   IDs before editing or upgrading any node.

The current `scripts/n8n-echo-provider.mjs` does not request tools, so these
parents require the N0 scripted capture-provider behavior before they can
complete an automated two-turn tool call. Until that provider slice lands,
importing, linking, and inspecting the refreshed input mapping are still useful
compatibility checks.

## Version guard

The stubs intentionally serialize AI Agent `3.1`, OpenAI Chat Model `1.2`, Call
n8n Workflow Tool `2.2`, and Execute Sub-workflow Trigger `1.1`. After import,
inspect every node version. If n8n migrates a node, record the observed version
and do not treat that run as evidence for the serialized version.

Do not add credentials or instance-generated metadata to these files. Raw
provider and execution captures belong under `.n8n-contract-staging/`, never in
this directory.
