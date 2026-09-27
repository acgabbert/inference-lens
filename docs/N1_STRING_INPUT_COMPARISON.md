# N1 string-input: Python MCP versus n8n

The bounded string-input comparison is captured. Python discovery, UI attachment,
explicit call approval, execution, and provider continuation completed in Inference
Lens. The operation and result match; the provider requests are **not identical**.
No application serializer, persisted contract, or presentation policy changed.

## Evidence and scope

- Reference: [existing n8n capture](../tests/fixtures/n8n/captures/2.39.10/string-input-tool-workflow/manifest.json), n8n 2.39.10, Agent 3.1, toolWorkflow 2.2, lmChatOpenAi 1.2. No new n8n capture.
- Candidate: [capture manifest](../tests/fixtures/mcp-servers/n1-string-input/manifest.json), Python MCP SDK 2.1.1, Pydantic 2.13.5, Streamable HTTP, buffered OpenAI-compatible provider.
- [Initial request](../tests/fixtures/mcp-servers/n1-string-input/provider-request-initial.json) and [continuation request](../tests/fixtures/mcp-servers/n1-string-input/provider-request-continuation.json) are actual HTTP request bodies saved by the provider, not reconstructed previews.
- [Discovery](../tests/fixtures/mcp-servers/n1-string-input/discovery.json), [Python execution](../tests/fixtures/mcp-servers/n1-string-input/python-execution.json), [execution API result](../tests/fixtures/mcp-servers/n1-string-input/execution.json), scripted provider responses, and [completed UI](../tests/fixtures/mcp-servers/n1-string-input/completed.png) accompany them.

The Python fixture owns its input schema and explicit JSON-array text result.
Its name, description, prompt, input value, and business output intentionally match
the baseline. The n8n wording in the description is comparison data, not a claim
that the Python server runs n8n. SDK-generated schema is retained. Returning a
Python object or enabling structured output would be a different experiment;
this capture does not establish a generic MCP object-to-n8n-result conversion.

## Exact differences

Paths below are JSON Pointers. `absent` means the property does not exist, distinct
from JSON `null`. The [machine-readable inventory](../tests/fixtures/mcp-servers/n1-string-input/wire-differences.json)
contains both values and explicit presence flags. Object key order is ignored;
array order, argument strings, and result text are not normalized.

These five differences occur in **both** requests:

| Path | n8n | Python MCP through Inference Lens |
| --- | --- | --- |
| `/tools/0/function/parameters/properties/text/title` | absent | `"Text"` |
| `/tools/0/function/parameters/additionalProperties` | `false` | absent |
| `/tools/0/function/parameters/$schema` | `"http://json-schema.org/draft-07/schema#"` | absent |
| `/tools/0/function/parameters/title` | absent | `"il_echo_stringArguments"` |
| `/tools/0/function/strict` | `false` | absent |

These three additional differences occur only in the **continuation**:

| Path | n8n | Python MCP through Inference Lens |
| --- | --- | --- |
| `/messages/2/content` | `[]` | `null` |
| `/messages/2/tool_calls/0/function/arguments` | `"{\"text\":\"IL_N0_STRING_VALUE\",\"id\":\"call_inference_lens_n8n_001\"}"` | `"{\"text\":\"IL_N0_STRING_VALUE\"}"` |
| `/messages/3/name` | absent | `"il_echo_string"` |

The SDK schema annotations and omitted restriction are visible in discovery
before attachment. Missing `additionalProperties: false` is a real schema
constraint difference, not harmless formatting. Titles and the dialect marker
are metadata differences. The significance of omitted versus explicit
`strict: false` depends on provider behavior, which this scripted provider does
not establish. Continuation differences are presentation differences; n8n's
extra argument is also a literal model-visible content difference.

There are no ordering-only or redacted-identifier differences in this pair.
These are observations for the captured versions, not evidence that changing
versions causes them. Other versions and provider interpretations are unsupported
by this capture; the comparator deliberately does not label differences as
semantically safe automatically.

## Exact matches

Both requests have `model: "template-echo-model"`, `temperature: 0`, `stream: false`,
one function tool, and no `tool_choice` or `parallel_tool_calls`. The tool name is
`il_echo_string`; its description is exactly:

> Echo one string through a deterministic n8n sub-workflow for the Inference Lens provider-wire contract fixture.

Both schemas have `type: "object"`, `properties.text.type: "string"`, and
`required: ["text"]`. Initial messages match in full, in `system`, `user` order.
Continuation preserves those messages and adds `assistant`, `tool` in that order.

`/messages/2/tool_calls/0/id` and `/messages/3/tool_call_id` both equal
`"call_inference_lens_n8n_001"` in both captures. Call type is `function` and call
name is `il_echo_string`. The Python server actually received only
`{"text":"IL_N0_STRING_VALUE"}`. The provider result at `/messages/3/content`
matches byte for byte as string content:

```json
[{"fixture":"IL_N0_STRING_INPUT","echoed":"IL_N0_STRING_VALUE","receivedType":"string"}]
```

Both scripted final responses are `IL_N0_CAPTURE_COMPLETE`.

## Presentation-policy decision

**Do not introduce a versioned presentation policy in this bounded task.**
The equivalent operation completed and the explicit text result matched. Exact
n8n wire parity was not established. In particular, changing all discovered MCP
schemas to prohibit extra properties would change their advertised contracts.
That is not justified by this one reference tool.

If exact n8n request reproduction becomes a requirement, the measured differences
justify designing an opt-in versioned policy, with separate schema ownership and
continuation-presentation decisions. Before implementation, resolve its owner,
selection/persistence, trace representation, supported n8n/node versions, and
whether it applies to imported n8n tools or arbitrary MCP tools with the user.
Do not call the current behavior generally “n8n compatible” or exact
“n8n-reference verified.” This is one successful equivalent-operation capture.

## Reproduce and verify

The opt-in config owns every listener, uses the existing capture provider, and
creates a fresh temporary output directory. Ordinary browser runs skip this
Python-only spec. Prepare Python 3.10+ at `.venv-mcp` from
`scripts/requirements-mcp.txt` (`mcp==2.1.1`, `pydantic==2.13.5`); the fixture
checks those versions at startup. This checkout
already had that environment; nothing was installed for this task.

```sh
npm run test:e2e -- --config playwright.n1.config.ts tests/e2e/n1-string-input-capture.spec.ts
npm run test:e2e -- --config playwright.n1.config.ts
node scripts/n1-compare-capture.mjs <printed-capture-directory>
npm run test:n8n-contract
npm run typecheck
```

Use the printed directory or the Playwright attachment to find fresh artifacts.
Do not point `INFERENCE_LENS_N1_OUTPUT` at committed evidence; it must be an
existing fresh directory. Provider requests and the Python execution use
exclusive creation, so an accidental second run cannot overwrite the evidence.
Review synthetic data and update digests if deliberately promoting a new capture.

The browser regression compares both new HTTP requests against the saved MCP
requests. Offline regressions lock the n8n difference inventory and reject
deliberate tool-name, schema-type, and result changes; additional tests check
description, call-ID, absence/null, and ordering. These are mutation controls,
not a claim of a pre-fix application regression: no application bug was fixed.
Initial harness failures were lifecycle configuration and missing project-profile
mapping, not red compatibility evidence.

Verification on September 26: the scoped `n1-string-input-capture.spec.ts` passed,
then the full suite with `playwright.n1.config.ts` passed **213 tests**. The n8n
contract suite passed **65 tests**, including nine N1 comparator/mutation tests.
TypeScript checking and ESLint on the new JavaScript/TypeScript files passed.
The first contract-suite attempt could not bind loopback inside the sandbox;
the successful run used loopback permission. No build or broader unit suite was
run because the application runtime was unchanged.

This does not test a hosted model's interpretation, streaming, alternate SDK
versions, arbitrary structured MCP results, or other n8n scenarios. The saved
completed UI is useful for visual review; the browser assertions verify the
rendered completion and the actual requests separately.
