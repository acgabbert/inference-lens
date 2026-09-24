# n8n tool contract capture provider

This fixture observes the OpenAI-compatible request n8n sends for a **Call n8n
Workflow Tool** execution. It never contacts a model. Instead, it returns one
deterministic tool call, waits for n8n to run the sub-workflow, validates the
continuation linkage, and returns a fixed final answer.

The baseline scenario is `string-input`, paired with the disposable n8n workflow
stubs of the same name. Its fixed contract is:

- model: `template-echo-model`;
- prompt sentinel: `IL_N0_STRING_INPUT`;
- tool name: `il_echo_string`;
- call ID: `call_inference_lens_n8n_001`;
- arguments: `{"text":"IL_N0_STRING_VALUE"}`;
- final answer: `IL_N0_CAPTURE_COMPLETE`.

The provider also supports `primitive-inputs`, `multiple-output-items`,
`fixed-and-ai-inputs`, `empty-output`, `nested-inputs`, `workflow-error`,
`rejected-arguments`, and `multiple-attached-tools`. Each scenario has a
matching disposable workflow recipe in
[`tests/fixtures/n8n/tool-workflow-stubs/README.md`](../tests/fixtures/n8n/tool-workflow-stubs/README.md).
The success scenarios validate exact child results. Error and rejected-argument
scenarios accept any linked string tool result because whether n8n creates one
is the observation; a run with no continuation is deliberately incomplete.

## Run it

Start the provider from the repository root:

```sh
npm run dev:n8n-tool-capture-provider
```

It listens on `127.0.0.1:4014` and writes to
`.n8n-contract-staging/tool-provider-string-input` by default. Both locations
are configurable:

```sh
INFERENCE_LENS_N8N_TOOL_CAPTURE_HOST=0.0.0.0 \
INFERENCE_LENS_N8N_TOOL_CAPTURE_PORT=4014 \
INFERENCE_LENS_N8N_TOOL_CAPTURE_SCENARIO=primitive-inputs \
INFERENCE_LENS_N8N_TOOL_CAPTURE_OUTPUT=.n8n-contract-staging/my-capture \
npm run dev:n8n-tool-capture-provider
```

Use `0.0.0.0` only when the n8n container or remote test host cannot reach
loopback, and remove that exposure after capture. For n8n running in Docker on
the same machine, the OpenAI credential base URL is commonly
`http://host.docker.internal:4014/v1`.

The output directory may exist, but each artifact is write-once. Start with a
new directory for every attempt. This prevents a retry from silently combining
requests from different executions.

## Configure and run n8n

1. Import the chosen scenario's parent and sub-workflow stubs.
2. Select the imported sub-workflow in the parent's **Call n8n Workflow Tool**
   node.
3. Create a dedicated OpenAI-compatible credential whose base URL points to
   this fixture and whose API key is a synthetic value.
4. Attach that credential to the parent's OpenAI Chat Model node.
5. Run the parent manually once.
6. Confirm that the final agent answer is `IL_N0_CAPTURE_COMPLETE`.

The provider accepts buffered and streaming chat-completion requests. It
requires the expected model, prompt sentinel, and exposed tool on the first
request. On the second request it requires the scripted assistant call and a
`role: "tool"` result linked by the exact call ID.
For the assistant call arguments, it accepts the original scripted object or
the same object with an `id` property equal to the call ID, as observed in an
n8n continuation. The raw request retains the exact form n8n sent.
Successful scenarios require the exact expected child output. A mismatch does
not complete the capture and leaves a raw rejected request for diagnosis.
For `workflow-error` and `rejected-arguments`, a linked string tool result
completes the provider exchange without asserting its yet-unknown content.

## Inspect status and artifacts

`GET /status` reports only capture metadata: scenario, phase, accepted request
count, completion state, last problem, and filenames. It never returns prompt,
tool-result, or credential content.

A completed run contains:

```text
provider-request-initial.json
provider-response-tool-call.json
provider-request-continuation.json
provider-response-final.json
```

Request files preserve the exact JSON bytes received from n8n. Response files
contain the deterministic logical completions used to produce either buffered
JSON or SSE chunks. These are raw evidence and must remain under
`.n8n-contract-staging/` until the existing redaction and fixture-validation
process projects them into a reviewed, versioned capture.

After the execution finishes, pass the provider directory to the public API
probe so both workflows, both executions, and provider evidence enter one raw
capture manifest:

```sh
INFERENCE_LENS_N8N_BASE_URL=... \
INFERENCE_LENS_N8N_API_KEY=... \
node scripts/n8n-contract-probe.mjs \
  --workflow-id PARENT_WORKFLOW_ID \
  --subworkflow-id CHILD_WORKFLOW_ID \
  --execution-id PARENT_EXECUTION_ID \
  --execution-id CHILD_EXECUTION_ID \
  --capture-name string-input \
  --provider-capture .n8n-contract-staging/tool-provider-string-input
```

Then run `scripts/n8n-redact-capture.mjs` as usual. The four provider files are
sanitized, hashed, listed in `manifest.json`, and validated with the workflow
and execution projections. The child receives its own `subworkflow.json` and
execution workflow identity in the projection. The probe requires all four
provider files and refuses a partial provider capture.

The provider deliberately captures only request bodies. It does not persist
HTTP authorization headers or the synthetic OpenAI credential.

## Failure behavior

An invalid request returns an OpenAI-shaped error and does not advance the
state machine. The problem is visible through `/status`. A third request after
completion is rejected. Existing artifact filenames cause a write failure
rather than being overwritten.

If a continuation fails validation, the provider saves the first rejected
request as `provider-request-rejected.json` in the raw staging directory. This
file can contain prompt and tool-result content; keep it out of commits and
inspect its `messages` structure locally to diagnose the mismatch. Later
rejected attempts do not overwrite it. The public API probe still requires a
successful four-file capture.

Stop the process with `Ctrl-C` or `SIGTERM`. It uses the shared fixture shutdown
handler, including when a client still holds a connection open.
