# n8n contract fixtures

These files support the Phase 0 public-API contract spike. They are not product
import fixtures yet.

## Install the workflow

1. Import `workflows/basic-llm-chain.contract.json` into a disposable or
   test-safe n8n project.
2. Keep the workflow inactive. Its Manual Trigger is the only intended entry
   point.
3. Create or select an OpenAI credential that points at the controlled echo
   provider. Attach it to `Fixture OpenAI Chat Model`.
4. Confirm the model identifier is `template-echo-model`.
5. Before each run, enable only the Basic LLM Chain case being captured. The
   committed workflow enables the compound-field case and disables the
   whole-field case.
6. Run manually and record the execution ID without deleting the workflow.

The workflow contains no credential ID, instance URL, project ID, webhook, or
instance metadata. n8n 2.32.5 imported the Basic LLM Chain at serialized
`typeVersion` 1.9 and the OpenAI Chat Model at `typeVersion` 1.2 without
migrating either value. Other versions remain unsupported until captured.

## Expected cases

`Fixture input items` emits two items. This makes the item index observable and
also gives the AI sub-node expression a deliberately useful item-dependent
model option.

| Case | Authored sentinel | Expected value |
| --- | --- | --- |
| literal | `IL_P0_LITERAL` | unchanged |
| simple expression | `{{ $json.topic }}` | `IL_P0_TOPIC_ALPHA` / `IL_P0_TOPIC_BETA` |
| two embedded expressions | `{{ $json.first }}` and `{{ $json.second }}` | ordered `IL_P0_REPEAT`, `IL_P0_SECOND_*` |
| multiline compound JavaScript | expression ending in `.join("::")` | `IL_P0_TOPIC_*::IL_P0_SECOND_*` |
| nested braces/template literal | template containing a stringified object | `value:{"inner":"IL_P0_TOPIC_*"}` |
| delimiter inside a string | expression containing `"literal }} text"` | n8n 2.32.5 reports `[invalid syntax]`; retain as source-invalid parser evidence only |
| repeated equal values | `first` and `repeat` | both resolve to `IL_P0_REPEAT`; attribution must fail closed |
| whole-field expression | `={{ $json.wholeField }}` | `IL_P0_WHOLE_*` |
| multiple items | two input items | model sub-run order cannot safely establish item index |
| AI sub-node expression | temperature depends on `$json.itemNumber` | n8n 2.32.5 resolved `0` for both model calls |

The expected effective user message for the compound case is the authored
field with each expression replaced by the corresponding value above. The
whole-field case should contain only `IL_P0_WHOLE_ALPHA` or
`IL_P0_WHOLE_BETA`.

The captures intentionally prove that a two-item execution is not a supported
import contract: model sub-runs may be stored in completion order, while parent
output items remain in input order. Phase 1 should initially accept exactly one
input item and one model sub-run.

## Capture and redact

Raw responses must remain under `.n8n-contract-staging/`:

```sh
INFERENCE_LENS_N8N_BASE_URL=... \
INFERENCE_LENS_N8N_API_KEY=... \
node scripts/n8n-contract-probe.mjs \
  --workflow-id WORKFLOW_ID \
  --execution-id EXECUTION_ID \
  --capture-name basic-llm-chain-success
```

Project a capture only after inspecting the fixture workflow and execution:

```sh
node scripts/n8n-redact-capture.mjs \
  --input .n8n-contract-staging/basic-llm-chain-success \
  --output tests/fixtures/n8n/captures/N8N_VERSION/basic-llm-chain \
  --n8n-version N8N_VERSION
```

The redactor refuses to overwrite an existing output directory. Review every
projected JSON file before committing it.

## Cleanup

- Keep execution data until all selected execution IDs have been captured and
  the redacted projections have been reviewed.
- Detach or delete the fixture-only provider credential when it is no longer
  needed.
- Delete the fixture workflow only after capture is complete; n8n deletes its
  execution history with the workflow.
- Stop the controlled echo provider or tunnel.
- Remove the raw staging directory after the committed fixtures validate.
