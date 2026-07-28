# n8n contract fixtures

The capture files support the Phase 0 public-API contract spike. The
`phase-5-*.json` workflows are product import fixtures for running-app
verification. All workflows are inactive, manual-only, and contain no
credentials or instance metadata.

## Phase 5 running-app workflows

Import these separately so each execution has one unambiguous purpose:

| Workflow | Expected import result |
| --- | --- |
| `phase-5-single-item-success.json` | `execution-reconstructed`; executable import |
| `phase-5-multiple-items.json` | `authored-only`; warning `multiple-input-items`; reusable-template import enabled |
| `phase-5-unsupported-chain-1.8.json` | unsupported invocation; code `unsupported-node-version`; import disabled |

The supported success fixture uses Basic LLM Chain `1.9` and OpenAI Chat Model
`1.2`, the exact versions captured against n8n `2.32.5`. The unsupported
fixture deliberately serializes Basic LLM Chain `1.8`. After import, do not
upgrade that node. If the installed n8n version automatically migrates it,
record the migrated version and do not count that run as an unsupported-version
check.

### Start the controlled provider

The workflows require an OpenAI-compatible credential because n8n must save a
real model sub-run. The repository fixture accepts any API key value and returns
a deterministic echo:

```sh
npm run dev:n8n-echo-provider
```

That binds to `127.0.0.1:4013`. Use
`http://127.0.0.1:4013/v1` as the credential base URL when n8n runs directly on
the same host.

For n8n in Docker Desktop, expose the fixture on the host:

```sh
INFERENCE_LENS_N8N_ECHO_HOST=0.0.0.0 npm run dev:n8n-echo-provider
```

Then use `http://host.docker.internal:4013/v1` in the n8n credential. Keep the
Inference Lens connection pointed at `http://127.0.0.1:4013/v1`. If n8n runs on
another machine, use a test-safe reachable address or tunnel and stop it after
verification.

For each imported workflow:

1. Attach that credential to `Phase 5 OpenAI Chat Model`.
2. Keep the model ID `template-echo-model`.
3. Run the workflow once with the Manual Trigger.
4. Record the execution ID; do not edit the workflow before importing that
   execution into Inference Lens.

For the success workflow, the resolved user message must be exactly:

```text
PHASE5_SINGLE_ITEM
case=single-item
topic=PHASE5_TOPIC_ALPHA
compound=PHASE5_TOPIC_ALPHA::PHASE5_SECOND_ALPHA
repeated=PHASE5_REPEAT|PHASE5_REPEAT
```

After importing, run it through Inference Lens with the same fixture provider.
The assistant response must begin `Fixture received user=` and contain the
JSON-escaped form of the exact text above.

### Phase 5 cases that are not workflow-driven

- **Bad key:** restart Inference Lens with the correct n8n base URL and a
  deliberately invalid `INFERENCE_LENS_N8N_API_KEY`. Opening the importer must
  show the normalized authentication failure and no remote response body.
- **n8n downtime:** stop n8n (or point the configured base URL at a known closed
  loopback port), restart Inference Lens, and verify the retryable unavailable
  state.
- **Missing/pruned execution data:** use an execution whose detailed data has
  actually been pruned while the workflow still exists. It must fall back to
  current authored text, show `execution-detail-unavailable` and
  `current-workflow-snapshot`, disable resolved-snapshot import, and allow a
  reusable-template import only when the current authored expression regions
  parse safely. Disabling storage for manual executions is not equivalent: it
  can remove the execution from the selectable list entirely.

Restart the app after changing its n8n environment variables. Stop the echo
provider, app server, and any temporary tunnel when the checks finish.

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
