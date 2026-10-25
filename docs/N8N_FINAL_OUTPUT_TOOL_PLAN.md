# Final-output tools and n8n compatibility plan

**Status:** Capture phase complete in `5645689`; runtime implementation has not
started. The user approved all twelve contract recommendations on 2026-10-25,
including normalization, mixed-call suppression, and effective-answer policy.
Exact type/schema and migration details remain to be specified within those
agreed policies before runtime implementation.

**Date:** 2026-10-25.

**Repository baseline:** `origin/main` at `3de8969`, which includes capture
commit `5645689` through PR189. This plan update is on
`codex/n8n-final-output-contract-plan`. Recheck the affected owners and format
versions before implementation.

## Outcome

Allow a conversation to request its final structured answer through a
model-visible tool. A validated call to that designated tool completes the run
without executing a host tool, supplying a fabricated tool result, or asking
the model for another answer. Ordinary tools can still run on preceding turns.

Provide a versioned n8n compatibility profile that reproduces supported n8n
formatter descriptions, system instructions, argument wrappers, validation,
and final-response fallback behavior. Keep that profile separate from the
provider-neutral execution mechanism.

The displayed answer, saved history, CLI output, deterministic checks, repeated
run statistics, and evaluation comparisons must agree about the effective
result. Preserve the model's original text and tool-call arguments as raw
evidence, including when validation fails.

## Verified upstream behavior and limits of the evidence

The initial investigation inspected upstream source and historical release tags.
The subsequent capture phase executed live home-instance workflows with a
scripted OpenAI-compatible provider. See the
[capture findings](N8N_FINAL_OUTPUT_CAPTURE_FINDINGS.md) for exact evidence and
limits. These captures measure orchestration, not live-model reliability.

The captured scope is operator-reported n8n **2.39.10**, AI Agent **3.1**,
Structured Output Parser **1.3**, OpenAI Chat Model **1.2**, and attached Workflow
Tool **2.2**; buffered Chat Completions, one input item, authored object schema,
no memory, auto-fix disabled. Streaming and Open Chat are excluded. Agent
2.2/3 captures are deferred. The instance build SHA was not independently verified.

- n8n `1.42.0` (2024-05-15) introduced Tools Agent with the synthetic tool
  `format_final_response` and a system instruction to call it for the final
  response. The new default Agent node version was `1.6`.
- Tags `1.82.2`, `1.82.3`, `1.82.4`, and `1.83.2` still use that name.
  Release `1.84.0` (2025-03-17) uses `format_final_json_response` and the
  stronger instruction requiring a complete final answer through the tool.
- The inspected source supports this execution path in AI Agent `1.6`–`1.9`
  when configured as Tools Agent, AI Agent `2`, `2.1`, `2.2`, `3`, and `3.1`,
  and AI Agent Tool `2.2` and `3`.
- The parent agent adds a tool whose schema comes from the connected output
  parser. Its function is a placeholder: the agent steps parser intercepts the
  call, validates its arguments, and returns an agent finish.
- The instruction is a prompt requirement, not proof of forced provider tool
  selection. If the model finishes without calling the formatter, the agent
  attempts to parse its ordinary final response.
- The captured Agent 3.1 path selects the first formatter in tested mixed turns
  in either order, suppressing ordinary dispatch. Two distinct valid formatter
  calls select the first. Invalid-first duplicates and invalid-formatter mixed
  turns remain unmeasured; do not generalize the compatibility claim to them.
- Structured Output Parser `1` uses legacy `__structured__output` wrappers;
  `1.1` and `1.2` wrap the schema under optional `output`; `1.3` requires
  `output`. Version `1.3` also requires fields in schemas generated from JSON
  examples. Schema conversion and output unwrapping are separate behaviors.
- Basic LLM Chain uses formatting instructions and response parsing rather
  than this synthetic final-answer tool. Attaching the same parser node does
  not establish the same execution contract across parent nodes.

Sources:

- [Tools Agent documentation](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/tools-agent/).
- [1.42.0 release notes](https://docs.n8n.io/changelog/release-notes-1.x.md#n8n1420)
  and [original implementation](https://github.com/n8n-io/n8n/blob/677f534661634c74340f50723e55e241570d5a56/packages/%40n8n/nodes-langchain/nodes/agents/Agent/agents/ToolsAgent/execute.ts).
- [Formatter name and instruction change, PR #13908](https://github.com/n8n-io/n8n/pull/13908)
  and [1.84.0 release](https://github.com/n8n-io/n8n/releases/tag/n8n%401.84.0).
- [Inspected upstream tree](https://github.com/n8n-io/n8n/tree/cfbd9a56cba2e73901dc1962e47727adbea0b23e).
  Relevant files under `packages/@n8n/nodes-langchain/` are
  `nodes/agents/Agent/agents/ToolsAgent/common.ts`, the V1/V2 executors,
  V3 `helpers/{prepareItemContext,createAgentSequence,runAgent}.ts`,
  `utils/output_parsers/N8nStructuredOutputParser.ts`, and the Agent/AgentTool
  version definitions.

Node versions and n8n application releases are different identifiers. The
support matrix must record both, plus the connected chat-model and parser node
versions. Source availability is not a compatibility claim for every release
or provider between the inspected tags.

## Current Inference Lens behavior

| Concern | Current owner and gap |
| --- | --- |
| Portable tools | `packages/core/src/run-kernel/types.ts`: `ToolDefinition` describes ordinary tools; it has no final-answer semantics. |
| Run completion | `run-kernel/reducer.ts` and `coordinator.ts`: tool calls enter `awaiting_tool_results`; normal completion follows a turn without pending tool calls. |
| Canonical answer | `packages/core/src/run-output.ts`: `finalAssistantOutput` returns completed assistant text and explicitly excludes tool arguments. |
| Validation | `json-input.ts` and `json-schema/` provide bounded parsing and a restricted draft-07 evaluator; checks run after execution. These are not n8n's Zod parser. |
| Provider serialization | `openai-compatible.ts`, `openai-responses.ts`, and `anthropic-messages.ts` already serialize ordinary tools and normalize their arguments. |
| n8n import | `services/api/src/n8n-prompt-extractors.ts` reconstructs supported prompt messages, model, and temperature. `ResolvedPromptSnapshot` has no parser/tool contract. |
| Saved artifacts | Projects, plans, traces, assessments, and experiment results have explicit format and replay boundaries. None stores a final-output contract or finalized structured answer. |

A saved system message may already contain n8n's injected instruction. Importing
that text does not recreate the referenced tool. The existing agent import
fixtures explicitly omit output parsers. The new F0 fixtures supply reference
evidence, but production import still has no parser/tool contract.

The `structuredOutput` provider capability is not an implementation of this
behavior. Raw provider options can express provider-specific request fields,
but they do not supply terminal-call handling or a shared result projection.

## Agreed contract decisions

These decisions are material under [AGENTS.md](../AGENTS.md). On 2026-10-25,
after reviewing the options and recommendations, the user said: "Yes, I agree
with your recommendations." All twelve recommendations below are approved as
one coherent design. Alternatives remain recorded to explain the tradeoffs.

The next step is the concrete type/format audit and contract specification below.
Routine details may be resolved within this agreement; any newly discovered
material tradeoff must be brought back to the user before implementation.

| Decision | Options and tradeoff | Agreed choice |
| --- | --- | --- |
| Execution owner | n8n-only execution is narrower but duplicates completion logic; a core terminal-tool mechanism serves app/CLI/batches and other profiles. | Provider-neutral core owns completion; a pure versioned n8n adapter owns formatter instructions, wrapping, and normalization. |
| Configuration owner | Project defaults reduce editing; revision-owned configuration preserves the meaning of each conversation. | Optional revision-owned contract, copied into immutable run/plan inputs. No contract means existing behavior. |
| Public structure and tool identity | Magic-name detection is simple but can hijack ordinary tools; an explicit contract identifies its generated tool. Persisting only authored configuration is smaller but loses compiler evidence. | Persist authored schema/profile policy on revisions; snapshot authored configuration plus compiled tool/schema/instruction and compiler/profile identity for execution. Reject tool-name collisions before provider work. A name alone never enables termination. |
| Validation and normalization | Strict existing validation is cheapest but misses captured stripping; a dedicated bounded normalizer can reproduce a small subset; adopting n8n/Zod conversion widens dependency and compatibility obligations. | Keep existing check semantics unchanged. Use bounded parsing/evaluation with a separately versioned n8n normalization layer for the captured subset. Reject unsupported schemas before execution. Generic mode never strips, coerces, or applies defaults. |
| Mixed and duplicate calls | Reject all ambiguous turns for simplicity; reproduce first-formatter selection for n8n parity; dispatch ordinary calls too, which contradicts captures. | n8n selects the first formatter and suppresses all ordinary calls in that turn. Generic mode rejects mixed/multiple formatter calls. Validate the selected formatter; failure never falls through to another formatter or host dispatch. The invalid-first rule is an explicit local policy until captured. |
| Missing formatter and failure | Require a call; parse final text; or request repair, adding cost and another execution policy. | n8n permits captured wrapped/unwrapped JSON fallback. Generic mode explicitly chooses fail or parse-final-text, defaulting to fail. Invalid JSON/schema is an owned terminal failure with raw evidence retained, without automatic repair or continuation. |
| Effective answer API and wrappers | Use raw arguments, normalized payload, or n8n node output; silently changing the raw-text API risks old consumers. | Retain finalAssistantOutput as raw text and add one shared effective-answer API. Its structured value is the authored-schema payload after supported normalization. Keep n8n node-output wrapping as profile evidence; never confuse it with an authored output field. |
| Text projection and evidence | Preserve object insertion order for model fidelity; canonicalize for stable checks/comparisons. Treat formatter calls as executions or as model call evidence. | Compact JSON with recursively sorted object keys and preserved array order for effective text. Raw argument bytes remain untouched. Existing tool-call evidence/checks include formatter calls; host-execution counts do not. |
| Provider scope and owned fields | Chat Completions only lowers initial work; supporting all existing protocols avoids host divergence. Raw overrides can take precedence, or conflicts can fail preflight. | Shared buffered execution through Chat Completions, Responses, and Anthropic fixtures; n8n parity only for captured Chat Completions. Reject configured streaming before provider work in this slice. Reject raw overrides of contract-owned tool/message/structured-output fields, with a clear diagnostic rather than silently merging. |
| Persistence and assessment compatibility | Infer new behavior from old artifacts, or explicitly version new contracts/events and preserve historical semantics. | Version affected project/trace/plan schemas and check-answer semantics. Old artifacts have no inferred finalization; validate new projections by deterministic replay. Bump experiment result only if its actual shape/semantics change. Allocate exact versions after the audit. |
| Adoption and branching | Copy the unresolved formatter call; synthesize a tool result; or materialize the effective answer as new conversation input. | Preserve the original trace, and materialize a clearly attributed assistant-text message from the effective answer when adopting/branching. Do not carry terminal calls into executable history or fabricate tool results. |
| Authoring and import sequence | Automatic import first is narrow but limits manual comparison; shared authoring/execution first enables reviewable schema changes. | Manual revision authoring and consistent app/CLI/batch results first, then evidence-backed import. Combine execution and authoring PRs if needed for coherent end-to-end behavior. |

### Agreed bounded n8n schema policy

Begin with the structural vocabulary exercised by the captures: object schemas,
named properties, required/optional fields, string/integer leaves, and nested
objects, including a property named output. Treat these as an agreed bounded
family, not proof that every combination is n8n-equivalent. Description metadata
must be retained where supported. Publish an exact keyword/location allowlist
and deterministic limits at the implementation gate; unsupported keywords,
references, compositions, arrays, root scalars, defaults/coercion, and open or
schema-valued additionalProperties remain rejected until separately designed.

For supported object locations, use these explicit transformations:

- Authored additionalProperties false: reject unknown keys.
- Authored additionalProperties omitted: strip unknown keys under the n8n
  profile, preserving raw evidence and recording the transformation policy.
- Compile the provider schema independently, including the captured outer output
  wrapper and object closure. Do not validate raw arguments solely against the
  stricter wire schema: that would reject the successful stripping capture.

The nested omitted-properties case is measured. Applying that policy to other
supported object locations is an approved extension requiring tests; it is not
additional home-instance evidence. The alternative of requiring
additionalProperties false everywhere was not selected: the captured nested
schema is a realistic import case, so support it through the bounded normalizer.

For final-text fallback, preserve the original text and generated parser input
separately. Resolve wrapped/unwrapped text using the captured profile algorithm,
not a global rule that removes any key named output. A payload with its own
output field must survive. The exact fallback disambiguation algorithm, JSON
input policy (including fences), schema limits, diagnostic codes, and proposed
TypeScript discriminants must be written down and reviewed before runtime work;
uncaptured ambiguous shapes must fail clearly rather than be guessed.

### Proposed contract shape

Names below are illustrative. Final names, discriminants, schema dialect,
resource limits, and versioning are settled in the type-design pass. The schema
is an object schema: the agreed bounded policy rejects root arrays, scalars, and
boolean schemas. Generic `missingCall` defaults to `fail`.

```ts
interface FinalOutputContract {
  contractVersion: 1;
  strategy: "tool";
  schema: JsonObject; // object schema within the bounded allowlist
  profile:
    | { kind: "generic"; missingCall: "fail" | "parse-final-text" }
    | { kind: "n8n"; compatibilityProfileId: string };
}
```

- A compiled, serializable snapshot identifies the generated tool, exact
  provider-facing schema, and instruction. Keep authored schema distinct from
  the compiled wire schema and record the compiler/profile version.
- The n8n profile resolves formatter name, description, instruction placement,
  wrapper conversion, fallback parsing, and normalization rules. Do not add
  n8n-specific wrapper fields to provider-neutral message or tool types.
- Reuse the tool wire representation. Finalization is run policy, not a new
  mock/command/MCP executor kind and not a device-local tool binding.
- Add a replayable finalization event/result with source (`tool-call` or
  `final-text-fallback`), turn/attempt identity, tool-call identity when
  applicable, normalized value, and validator/profile identity. Raw argument
  bytes remain in existing provider and tool-call evidence.
- Do not overload `responseMode`: that already means streaming versus buffered
  delivery. Do not overload the System One decision protocol either.
- Preserve authored versus generated messages so run preparation cannot inject
  the instruction twice during continuation, retry, import, or plan execution.

## Ownership and runtime flow

| Responsibility | Intended owner |
| --- | --- |
| Portable types, compilation/preflight, bounded validation | Core final-output feature modules; exposed types referenced by `run-kernel/types.ts`. |
| n8n instruction/wrapper compatibility | Dedicated pure adapter/profile module, using captured versioned behavior. |
| Completion transition and event invariants | `run-kernel/coordinator.ts` and `reducer.ts`. |
| Request preparation | `app/run/prepare-workbench-run.client.ts` and shared core preparation used by runner/CLI; no browser-only compiler. |
| Provider wire serialization | Existing three protocol adapters; no adapter decides whether a call is terminal. |
| Interactive lifecycle | `app/run/use-run-session.client.ts`; ordinary-tool dispatch sees only calls that remain executable. |
| Batch/CLI lifecycle and preflight | `packages/runner/src/chat-cell-executor.ts`, batch start owners, and CLI input/summary owners. |
| Canonical effective answer | `packages/core/src/run-output.ts`, consumed by response, checks, comparisons, and statistics. |
| Authoring draft and validation UI | New cohesive final-output editor/owner composed by the request feature; project workspace commits revision changes. |
| External import | n8n extractor plus `external-prompt-import.ts` / `external-prompt-project.ts`; UI reviews fidelity and unsupported cases. |

`app/page.tsx` remains a composition root. Name the editor's props/actions and
the cross-feature run-preparation adapter before adding UI wiring.

The intended flow is:

1. Resolve the authored contract, prepare its schema and compatibility profile,
   validate tool-name collisions and tools capability, and snapshot all inputs.
   Fail before starting/saving an executable plan or contacting the provider
   when the contract is unsupported or streaming delivery is configured.
2. Compile the formatter tool and effective instruction once. Reject raw
   `providerOptions` overrides of contract-owned tools/messages or
   structured-output settings with a clear diagnostic; never merge silently.
3. Send the buffered provider request and collect original events. Accept a
   formatter call only from a complete successful attempt; incomplete or
   truncated arguments never finalize.
4. Classify the completed turn before dispatching any tools. Ordinary calls
   continue through existing binding, grant, execution, and continuation paths.
   A designated formatter candidate is handled internally according to the
   agreed mixed-call policy.
5. Validate the candidate, normalize the supported wrapper, emit finalization
   evidence, and finish the run. Never fabricate a `tool.result_supplied` event
   or a follow-up assistant message just to satisfy current invariants.
6. If the model ends with text instead, apply the configured fallback or record
   an owned failure. Invalid JSON, schema mismatch, unsupported schemas, and
   resource exhaustion need distinct diagnostics. No automatic repair-model
   call or unbounded retry is implied.

Completion must still drain the provider turn sufficiently to retain usage and
exchange evidence after a finish frame. Cancellation, transport failure, and
retry must not accept partial arguments, finalize twice, dispatch suppressed
calls, or resurrect a failed attempt's result.

## Result projection and artifact compatibility

Keep raw assistant text, raw tool calls, and the effective final answer
distinguishable. Within a trace, a structured result must not be represented as
text the model never emitted. The shared answer projection selects finalized
output when present and preserves today's assistant-text behavior when absent.

The one deliberate exception is adoption/branching: the agreed policy
materializes a clearly attributed assistant-text message from the effective
answer in the new conversation. That message is generated input, not model
output; the type-design pass must give it a distinct attribution and state
which text it carries (see open items under the gate).

Per the agreed decisions, `finalAssistantOutput` remains the raw-text API and a
new shared effective-answer API is added. Inventory every consumer and migrate
all answer-consuming surfaces together; reasoning, tool-call counts, and usage
remain separate evidence. Formatter calls count in existing tool-call
evidence/checks but not in host-execution counts; raw call visibility is
preserved regardless of the answer projection.

Required format audit, using the baseline versions only as a starting point:

- Project format is currently `14`: revision configuration, cloning, branching,
  import/export, and adoption must preserve the selected contract. Existing
  projects acquire no implicit formatter behavior.
- RunTrace is currently `8`: new finalization events require an explicit
  compatible format revision, runtime validation, and deterministic replay.
  Reject finalized projections inconsistent with the event stream. Old traces
  retain their original answers and do not gain inferred tool finalization.
- Experiment plan is currently `5`, result `6`: snapshot the contract for
  repeated runs and evaluations, and audit strict embedded input schemas,
  execution hashes, cell materialization, retries, summaries, and history.
- Audit check/assessment vocabulary and saved reassessment behavior. A change
  in what a check reads may require a semantic version change even without a
  new check field. Do not reinterpret old assessments silently.
- External candidate/receipt digests must include newly imported contract
  evidence. Unknown or missing parser evidence cannot be labeled as fully
  reconstructed execution behavior.
- Old readers must reject unsupported new artifacts clearly. Follow existing
  migrations and unknown-version policy; do not weaken strict parsing just to
  accept the added fields.

Effective text is compact JSON with recursively sorted object keys and
preserved array order (root arrays/scalars are rejected in this slice). Compare original schema, wire
schema, raw arguments, normalized value, and rendered result separately.
Pretty-printing in one UI must not change evaluator input or output counts.

## Proposed first supported slice and exclusions

The capture phase is complete for n8n `2.39.10` (operator-reported), Agent `3.1`,
Structured Output Parser `1.3`, OpenAI Chat Model `1.2`, authored object schemas,
no memory, and auto-fix disabled. Agent `2.2`/`3` remain deferred. No additional
home-instance runs are required for the selected phase.

Support buffered delivery in this slice; streaming and Open Chat are explicitly
excluded. The generic mechanism works through Chat Completions,
OpenAI Responses, and Anthropic Messages using local protocol fixtures; claim
n8n wire compatibility only for the captured Chat Completions path. Configure
streaming with a final-output contract only after a later supported extension;
initial preflight must reject it explicitly.

Defer legacy parser wrappers/names, example-to-schema inference parity, memory
serialization, auto-fix/repair LLMs, fallback models, nested Agent Tool execution,
and schemas outside the agreed validator profile until separately captured and
accepted. Record their unsupported status explicitly. Do not advertise support
for all inspected upstream node versions merely because the generic mechanism
can express them.

## Delivery sequence

### PR 1 — Capture the reference behavior (complete, merged)

Committed as `5645689` and merged into main through PR189 (`3de8969`). Fourteen redacted
captures and the findings document close the selected capture phase. The list
below describes the capture work, with streaming and Agent 2.2/3 explicitly
deferred by the subsequent scope decision.

- Extend or add a capture scenario for terminal formatter calls. The current
  capture provider/probe requires four files and a second request for ordinary
  tools; terminal success needs a first-class one-request artifact shape. Do
  not manufacture a continuation to make that capture look complete.
- Use disposable synthetic workflows and the controlled provider. Follow
  [the capture guide](N8N_TOOL_CAPTURE_PROVIDER.md) and redaction/manifest
  conventions; retain exact request bytes and the n8n execution result.
- Capture formatter-only success, an ordinary-tool turn followed by formatting,
  valid plain-text JSON fallback, schema-invalid arguments, missing formatter
  with invalid final text, and mixed/duplicate formatter calls. Record actual
  request counts. The selected phase covers buffered delivery; streaming is
  excluded.
- Compare schema conversion and output behavior with extra properties,
  optional/required fields, and nested `output` keys. These expose differences
  between our evaluator and n8n's schema conversion/parser.
- Publish a supported/unsupported behavior table with application/node/model
  versions, source revision, fixture hashes, and known differences. Fixture
  requests prove orchestration; scripted model responses do not measure model
  compliance or reliability.

### Gate — Contract policies agreed; specify types and compatibility next

All twelve decision-table recommendations were approved on 2026-10-25. Do not
reopen agreed policies merely to request implementation permission. Before
runtime implementation, complete a documentation/type-design pass that:

- Defines authored, compiled, and finalized result types, their owners, event
  invariants, and exact serialized fields/discriminants.
- Specifies the schema keyword/location allowlist, deterministic limits,
  fallback wrapper disambiguation and JSON input policy, diagnostic codes, and
  the exact contract-owned provider override fields.
- Inventories effective-answer consumers and specifies attributed adoption/
  branching messages and call-count behavior under the agreed policies.
- Audits current artifact versions and writes the exact migration/replay and
  check-answer semantic compatibility rules. Preserve historical assessments.
- Maps each accepted policy to regression, protocol, artifact, and browser
  coverage, distinguishing captured behavior from explicitly chosen extensions.
  Several decision-table rows bundle more than one policy (for example,
  provider scope also covers streaming rejection and owned-field overrides);
  split them back into individual policies for this mapping.

Open items the agreed policies do not yet settle; resolve them in this pass:

- **Root-level stripping is an extension, not a measurement.** Every capture's
  authored root explicitly set `additionalProperties: false`; only a nested
  object omitted it. Most imported schemas will omit it at the root, so state
  that root-level stripping rests on the approved extension, or add one capture
  (root with `additionalProperties` omitted plus an extra root key) before
  claiming parity for it.
- **Counting suppressed ordinary calls.** Define how an ordinary call the model
  emitted in an n8n formatter turn, but which was never dispatched, appears in
  trace evidence, tool-call checks, and host-execution counts.
- **Adopted-message text.** Specify the attribution of the materialized
  adoption/branching message and whether it carries the sorted-key compact
  text (which later turns would see) or another representation.
- **Acceptance comparison.** n8n preserves the model's key order while
  effective text sorts keys. Specify that n8n-versus-Inference Lens acceptance
  compares normalized results structurally, not as text.
- **Generic final-text wrapper rule.** Generic `parse-final-text` never strips;
  specify whether it accepts only the authored payload shape or any wrapper.

Record the resulting contracts here before runtime work. Bring back only new
material decisions that the approved policies do not resolve. Then begin PR 2
with the behavioral regression written and run red before the fix.

### PR 2 — Add the core contract, events, and shared execution

- Write regression tests first using today's representable schema-defined tool
  and system instruction. Demonstrate that a formatter-only call currently
  waits for tool results and has an empty answer; assert those actual values in
  the red output. A separate test failing because a new contract API is missing
  is not evidence of this behavioral failure. After introducing explicit
  configuration, retain a negative test proving that the same ordinary tool
  name without the contract still follows ordinary execution.
- Implement agreed configuration and compiled snapshots, pure preflight,
  finalization validation/events, reducer/coordinator invariants, and versioned
  artifact support. Cover replay, failed attempts, cancellation, and usage drain.
- Wire the same core path into interactive and shared runner/CLI execution.
  Verify no executor, binding, grant prompt, or extra provider request is needed
  for a successful formatter call. Ordinary tools retain their existing grants.

### PR 3 — Authoring and consistent result consumption

- Add a revision-owned final-output editor with an explicit profile, schema
  diagnostics, and save/cancel. Imported unsupported drafts remain inspectable
  without becoming executable. Show the effective formatter in request preview.
- Migrate every effective-answer consumer together: live and saved response,
  copy/export, trace adoption/branching, CLI output, comparisons, deterministic
  checks, repeated-run statistics, evaluations, and reassessment.
- Preserve raw evidence separately and label fallback provenance. Verify that
  branching/adopting a finalized turn does not leave unresolved terminal calls
  in a newly executable conversation; settle this transition in the contract.
- If PR 2 cannot expose a reviewable end-to-end path without these changes,
  combine PRs 2 and 3 rather than ship divergent result semantics.

### PR 4 — Evidence-backed n8n import

- Detect the execution-time `ai_outputParser` connection and exact parent/parser
  versions. Import schema/profile evidence with the existing source receipt.
- Preserve authored system text and distinguish already injected formatting
  instructions from generated ones. Do not strip arbitrary text by matching a
  familiar sentence; use captured attribution or disclose ambiguity.
- Handle multiple model sub-runs honestly: ordinary tools and parsing/repair can
  cause more than one. The current one-sub-run importer must not guess which
  run, item, or attempt a schema/message belongs to.
- Offer an executable reconstructed contract only for the captured supported
  subset. Otherwise show the limitation and allow supported prompt-only review
  paths with an explicit warning that formatter behavior is not reproduced.
- Update project/trace/experiment format docs, n8n support matrix, provider
  fixtures guide, and user-facing authoring documentation.

## Verification and acceptance

Apply [AGENTS.md](../AGENTS.md), [the browser mechanics](../tests/e2e/README.md),
and [the provider fixture rules](PROVIDER_FIXTURES.md). Write each regression
before its fix and run it red for the actual incorrect value. Report selectors,
hydration failures, or fixtures that did not load as test defects, not evidence
of the product bug.

| Layer | Required evidence |
| --- | --- |
| Core state and policy | Exact final value/source; single finalization; no pending formatter result; mixed-call policy; invalid/missing/unsupported cases; incomplete arguments, transport failure, retry, cancellation, late usage, and streaming preflight rejection. |
| Protocols | Each existing adapter sends the designated schema/instruction and accepts buffered calls; configured streaming is rejected in preflight for this slice. Assert exact provider request counts and absence of fabricated formatter results. Preserve Responses/Anthropic continuation material for preceding ordinary tools. |
| Artifacts | Old files retain old behavior; new files round-trip/replay deterministically; inconsistent finalization is rejected; project revisions and immutable plans reproduce the chosen contract. |
| App | Draft/save/cancel, visible final JSON, failure diagnostics, ordinary-tool continuation, request preview, saved-history reopen, copy/export, and trace adoption/branching. |
| CLI and batches | Same normalized result and checks as the app; no formatter grant requirement; ordinary-tool grants still enforced; retry/turn limits and concurrent cells remain isolated. |
| Evaluations | Structured result drives schema/text checks, counts, comparisons, aggregates, and reassessment consistently; raw formatter calls remain inspectable. |
| n8n import | Captured parser/profile reconstructs without duplicate instructions; unsupported topology/version and ambiguous model sub-runs disclose reduced fidelity. |

Add a committed `tests/e2e/final-output-tool.spec.ts` and extend the relevant
import, batch, and CLI-artifact specs. Use shared drivers. Fixtures must refuse
missing/wrong formatter schemas or instructions; a scripted formatter answer
alone is insufficient proof that the request reached the wire correctly.

Run the affected spec while iterating:

```sh
npm run test:e2e -- tests/e2e/final-output-tool.spec.ts
```

Before handing back a user-visible implementation slice, run the full ordinary
browser suite once, plus the appropriate repository gates:

```sh
npm run lint
npm run typecheck
npm run typecheck:core
npm test
npm run build:cli
npm run test:e2e
```

Use the committed runner to start servers; do not start a parallel app server
or substitute an ad hoc browser driver. Add native checks when the slice changes
native host code. State live provider, native Tauri, legacy n8n, and unsupported
schema gaps separately from deterministic fixture coverage.

Acceptance requires a supported captured n8n scenario and an Inference Lens run
to agree on the formatter descriptor/instruction, arguments, normalized result,
and provider-turn count, with every measured difference disclosed. Save and
reopen the Inference Lens trace and verify the same displayed answer and check
results. No blanket n8n compatibility claim follows from a green unit suite.

## Plan-update verification

This branch changes the plan and the capture findings handoff text only; the
capture commit is already on main. Validate
Markdown links and whitespace with `git diff --check` and inspect the staged
diff. No browser or runtime suite is required for a documentation-only change;
the implementation commands above are future requirements, not checks already
performed.
