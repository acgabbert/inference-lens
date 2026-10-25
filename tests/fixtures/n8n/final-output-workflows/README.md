# F0 structured output capture staging

Part of [PR185](https://github.com/acgabbert/inference-lens/pull/185), capture
slice only. Target instance: n8n **2.39.10**. The workflow files are staging
recipes; the following Agent 3.1 buffered cases now have live reference evidence:

| Case | Result |
| --- | --- |
| [Formatter only](../captures/2.39.10/f0-agent-3-1-buffered/observations.md) | Success; optional note omitted |
| [Ordinary tool then formatter](../captures/2.39.10/f0-agent-3-1-after-tool/observations.md) | Success; two provider requests |
| [Wrapped final-text JSON](../captures/2.39.10/f0-agent-3-1-text-valid/observations.md) | Successful fallback |
| [Invalid final text](../captures/2.39.10/f0-agent-3-1-text-invalid/observations.md) | JSON syntax failure |
| [Wrong field type](../captures/2.39.10/f0-agent-3-1-schema-invalid/observations.md) | Schema mismatch |
| [Extra payload property](../captures/2.39.10/f0-agent-3-1-extra-properties/observations.md) | Schema mismatch under additionalProperties false |
| [Missing required count](../captures/2.39.10/f0-agent-3-1-required-missing/observations.md) | Schema mismatch |
| [Formatter-first mixed calls](../captures/2.39.10/f0-agent-3-1-mixed/observations.md) | Formatter succeeds; ordinary call not dispatched |
| [Duplicate formatter calls](../captures/2.39.10/f0-agent-3-1-duplicate/observations.md) | First payload selected; one parser run |
| [Ordinary-first mixed calls](../captures/2.39.10/f0-agent-3-1-mixed-ordinary-first/observations.md) | Formatter succeeds; ordinary call not dispatched |
| [Nested authored output](../captures/2.39.10/f0-agent-3-1-nested-output/observations.md) | Both output levels preserved |
| [Unwrapped final-text JSON](../captures/2.39.10/f0-agent-3-1-text-unwrapped/observations.md) | Accepted; n8n wraps payload before parser invocation |
| [Extra nested key, unspecified extras](../captures/2.39.10/f0-agent-3-1-nested-output-extra/observations.md) | Accepted; extra nested key stripped |

Streaming and Open Chat are explicitly out of scope per operator direction.
Execution 105 enabled streaming but still sent a buffered provider request; see
[the observation](../captures/2.39.10/f0-agent-3-1-streaming-enabled-buffered/observations.md).
The operator selected two final captures for this session: unwrapped final-text
JSON and an extra nested key where authored additionalProperties is omitted.
Both final selected captures are complete. The capture provider has been stopped.
Agent 2.2/3 captures are deferred; current evidence covers only Agent 3.1.
See [the findings and design gate](../../../../docs/N8N_FINAL_OUTPUT_CAPTURE_FINDINGS.md).
No core runtime, import, or artifact contracts
are implemented or approved here.

## First run

1. Import `echo-child.json` and `agent-3.1-buffered.json` into a disposable
   project. Keep the parent inactive for manual execution. Publish/activate the
   echo child so n8n permits the Workflow Tool to invoke it. Each parent has one Manual Trigger and no
   credentials, memory, auto-fix parser, or fallback model.
2. In the parent's `il_echo_string` node select the imported, published/active
   echo child. An inactive child returned `Workflow is not active and cannot be
   executed.` on the first live ordinary-then-formatter attempt; the provider
   correctly rejected that error result instead of recording success. Keep
   this ordinary tool connected even for formatter-only cases; it lets the same
   workflow exercise mixed calls and ordinary-tool continuations later.
3. Create a fixture-only OpenAI credential with a synthetic API key and base URL
   `http://<capture-computer-LAN-IP>:4014/v1`. Attach it to
   `Fixture OpenAI Chat Model`; keep model `template-echo-model`.
4. Confirm AI Agent **3.1**, OpenAI Chat Model **1.2**, Structured Output Parser
   **1.3**, and Call n8n Workflow Tool **2.2** after import. The parser uses a
   manually authored object schema with required `answer`/`count`, optional
   `note`, and `additionalProperties: false`. Save before executing.
5. Start a fresh provider process/directory for this exact attempt:

   ```sh
   INFERENCE_LENS_N8N_TOOL_CAPTURE_HOST=0.0.0.0 \
   INFERENCE_LENS_N8N_TOOL_CAPTURE_SCENARIO=formatter-success \
   INFERENCE_LENS_N8N_TOOL_CAPTURE_OUTPUT=.n8n-contract-staging/f0-agent-3.1-buffered-01 \
   npm run dev:n8n-tool-capture-provider
   ```

6. Run the parent manually **once**. Record parent workflow ID, execution ID,
   execution status, displayed output/error, actual node versions, and any
   node migration. Expected scripted payload is
   `{"answer":"IL_F0_ANSWER","count":7}`; the **actual** node output and
   wrapper handling are observations, not pass conditions invented by the fixture.
7. Inspect `http://<capture-computer-LAN-IP>:4014/status` after the execution
   finishes. `requestCount` counts accepted requests;
   `receivedRequestCount` also includes rejected requests and retries.
   `complete` means the provider delivered its script, not that n8n succeeded.
   Record both counts and any `problem`. Unexpected requests are rejected and
   their first body is retained as `provider-request-rejected.json`.
8. Share the workflow and execution IDs so we can retrieve and review the saved
   execution. Keep the workflow and execution data until projection is complete.
   Do not paste API keys into chat or commit them.

The provider serves buffered JSON or SSE according to the actual request's
`stream` flag. A filename is not evidence that streaming happened: inspect the
captured flag. If manual execution does not trigger streaming, record that gap
and investigate the invocation mode rather than calling it streamed coverage.

## Capture and project

With the public API environment configured locally, retrieve the exact execution:

```sh
node scripts/n8n-contract-probe.mjs \
  --workflow-id PARENT_WORKFLOW_ID \
  --execution-id PARENT_EXECUTION_ID \
  --capture-name f0-agent-3-1-buffered-01 \
  --provider-capture .n8n-contract-staging/f0-agent-3.1-buffered-01 \
  --provider-capture-kind terminal
```

Capture names allow letters, numbers, underscores, and hyphens; use `3-1`
rather than `3.1` in `--capture-name`. Provider directory names may contain dots.

The terminal kind requires precisely the initial request and final scripted
response; it rejects ordinary continuation artifacts. Omitting the kind keeps
the existing four-file ordinary-tool requirement. It cannot accidentally bless
an incomplete ordinary-tool capture. Raw request files preserve original bytes.

```sh
node scripts/n8n-redact-capture.mjs \
  --input .n8n-contract-staging/f0-agent-3-1-buffered-01 \
  --output tests/fixtures/n8n/captures/2.39.10/f0-agent-3.1-buffered \
  --n8n-version 2.39.10
```

Review all projected files before committing. The normal projection retains
workflow/execution node versions, parser connections, provider bodies, source
hashes, and projected-file hashes. Record the upstream source revision and
operator observations in an accompanying behavior table after live capture.
Never label scripted responses as model compliance or reliability evidence.

## Nested schema staging

For `formatter-nested-output`, reuse the existing parent and replace the parser's
Input Schema with [schemas/nested-output.json](schemas/nested-output.json), save,
and run once. No prompt or credential changes are needed. The provider refuses
the baseline schema for this recipe. After capture, restore
[schemas/baseline.json](schemas/baseline.json) before baseline/version runs.
Alternatively import the full nested-output parent recipe and attach the same
credential and published child.

## Remaining matrix

First confirm Agent 3.1 buffered success, then capture buffered Agent 2.2 and 3 if they remain in support scope.
Streaming variants are staging artifacts only and are excluded from required
capture work. Each attempt gets a fresh
provider process and output directory. Use Agent 3.1 buffered for the behavior
probes initially:

| Provider scenario | Workflow | Scripted observation |
| --- | --- | --- |
| `formatter-success` | Any baseline parent | One formatter call, wrapped object arguments |
| `formatter-after-tool` | Baseline parent + echo child | Ordinary tool, linked result, then formatter |
| `formatter-text-valid` | Baseline parent | Ordinary final text containing wrapped JSON |
| `formatter-text-unwrapped` | Baseline parent | Plain final-text JSON without the outer output wrapper |
| `formatter-nested-output-extra` | Nested schema | Extra key inside authored nested output; nested additionalProperties deliberately omitted |
| `formatter-text-invalid` | Baseline parent | Ordinary final text containing invalid JSON |
| `formatter-invalid` | Baseline parent | String where integer is required |
| `formatter-required-missing` | Baseline parent | Missing required count |
| `formatter-optional-omitted` | Baseline parent | Omitted optional note |
| `formatter-extra-properties` | Baseline parent | Extra property under a closed schema |
| `formatter-nested-output` | `nested-output-agent-3.1.json` | Authored output key inside formatter's output wrapper |
| `formatter-mixed` | Baseline parent + echo child | Formatter then ordinary tool in one response |
| `formatter-mixed-ordinary-first` | Baseline parent + echo child | Ordinary tool then formatter in one response |
| `formatter-duplicate` | Baseline parent | Two formatter calls with distinct IDs and payloads |

For `formatter-after-tool`, omit `--provider-capture-kind terminal` and include
`--subworkflow-id CHILD_WORKFLOW_ID` plus a second `--execution-id` for the child.
Its four files represent two real requests; the final response contains a
formatter call, with no invented formatter tool result or third request.
Other recipes use the terminal two-file shape, including n8n parser failures.
If n8n retries or makes another call, preserve rejected evidence and record the
behavior; this harness does not pretend to support an unobserved repair loop.
For mixed calls, inspect whether the child executed even when n8n made no second
provider request. Source-level first-formatter behavior is not live evidence.

No n8n compatibility claim is made until the live requests, execution output,
request counts, schema conversion, and known differences are reviewed. Legacy
parsers, example inference, memory, repair models, and other providers remain
outside this matrix. Later slices require a separate contract-design review.

Stop the provider with Ctrl-C or SIGTERM after each attempt; remove the LAN
listener and fixture credentials after the capture session.

## Final two selected captures

1. `formatter-text-unwrapped`: use the baseline schema on the existing Agent
   3.1 parent. The scripted answer is plain `{"answer":"IL_F0_ANSWER","count":7}`.
   No other edits are needed; the Manual Trigger is sufficient.
2. `formatter-nested-output-extra`: replace the parser Input Schema with
   `schemas/nested-output.json`. Keep additionalProperties **omitted** inside
   the authored nested output object. The script includes label and an extra
   synthetic key there; determine rejection, removal, or preservation from the
   actual parser result. The wire schema alone cannot answer this.

Use one fresh provider process/directory per case, preserve each execution,
then stop the LAN listener. Streaming/Open Chat and Agent 2.2/3 runs are not
required for this session.
