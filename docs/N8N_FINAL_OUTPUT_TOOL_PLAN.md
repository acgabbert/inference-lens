# Final-output tools and n8n compatibility plan

**Status:** Proposed design and implementation sequence. No feature work has
started. Recommendations below are for review; publishing this plan does not
approve its public or persisted contracts.

**Date:** 2026-10-25.

**Repository baseline:** `main` at `a63845c`. Recheck the affected owners and
format versions before implementation.

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

The investigation inspected upstream source and historical release tags. It did
not execute a live n8n workflow or establish provider-wire parity.

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
- The current interceptor finds the first formatter action in the actions
  array. Mixed formatter/ordinary-tool calls and repeated formatter calls need
  explicit captures; do not infer that all other actions execute.
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
fixtures explicitly omit output parsers; ordinary-tool captures do not close
this coverage gap.

The `structuredOutput` provider capability is not an implementation of this
behavior. Raw provider options can express provider-specific request fields,
but they do not supply terminal-call handling or a shared result projection.

## Design decisions to agree before implementation

These decisions are material under [AGENTS.md](../AGENTS.md). The recommended
choices form one proposed design, not independent commitments. Resolve them
after the capture slice and before changing runtime or artifact contracts.

| Decision | Options and tradeoff | Recommendation |
| --- | --- | --- |
| Execution owner | An n8n-only runner is narrower initially but duplicates completion semantics. A generic terminal-tool mechanism serves all hosts while adapters own compatibility. | Provider-neutral mechanism in core; explicit n8n profile alongside it. |
| Configuration owner | Project defaults are convenient but can change the meaning of an existing conversation. Revision-owned configuration makes executions reproducible. | Optional contract on conversation revisions, copied into immutable run and plan inputs. Absence preserves existing behavior. |
| Tool identity | A magic tool name is simple but could reinterpret a user-authored ordinary tool. An explicit designated identity avoids that ambiguity. | Contract designates the generated tool; reject name collisions before execution. An identical name alone never enables termination. |
| Validation | Existing bounded evaluator is portable but has different support and transformation rules from n8n. A new compatibility validator adds maintenance and dependency cost. | Reuse bounded infrastructure only for a measured supported subset; reject unsupported schemas. Do not claim Zod equivalence or silently strip/coerce/default data. Decide whether captures justify another validator. |
| Missing formatter | Always requiring a call is stricter; parsing final text matches n8n's observed fallback. | n8n profile permits its captured fallback. Generic policy is explicit, with no implicit switch to provider-native structured output. |
| Mixed or duplicate calls | Rejecting ambiguity is simpler; matching n8n's first-formatter behavior may suppress other actions. | Capture before deciding. Unsupported combinations fail before host tool dispatch; parity claims must state any departure. |
| Effective answer | Tool argument JSON, schema payload, and n8n node output can differ by wrappers. Choosing one implicitly causes inconsistent checks and UI. | Store explicit finalization provenance and agree a deterministic payload/text projection. Capture and document all three shapes first. |
| Product scope | Automatic import alone is narrow; manual authoring also lets users compare modified prompts and schemas. | Ship manual authoring and shared execution first, then evidence-backed automatic import. |

### Proposed contract shape

Names below are illustrative. Final names, discriminants, schema dialect,
resource limits, and versioning are part of the design gate.

```ts
interface FinalOutputContract {
  contractVersion: 1;
  strategy: "tool";
  schema: JsonObject | boolean;
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
   when the contract is unsupported.
2. Compile the formatter tool and effective instruction once. Detect conflicting
   raw `providerOptions` overrides of owned tools/messages or structured-output
   settings; agree precedence instead of allowing silent bypass.
3. Send the ordinary provider request and collect original events. Keep
   streaming argument fragments provisional until a complete successful
   attempt supplies the complete call.
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
distinguishable. A structured result must not be represented as text the model
never emitted. The shared answer projection should select finalized output
when present and preserve today's assistant-text behavior when absent.

Before changing `finalAssistantOutput`, inventory every consumer and agree
whether to retain it as the raw-text API and introduce a new effective-answer
API, or rename/migrate it. Change all answer-consuming surfaces together;
reasoning, tool-call counts, and usage remain separate evidence. Decide and
document whether formatter calls count in existing tool-call checks; preserve
raw call visibility regardless of the answer projection.

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

Use a deterministic, documented JSON text representation for text consumers,
including root arrays/scalars if supported. Compare original schema, wire
schema, raw arguments, normalized value, and rendered result separately.
Pretty-printing in one UI must not change evaluator input or output counts.

## Proposed first supported slice and exclusions

Start by capturing one supported modern n8n application release with AI Agent
`2.2`, `3`, and `3.1`, Structured Output Parser `1.3`, one explicitly versioned
OpenAI Chat Model, a manually authored object schema, no memory, and auto-fix
disabled. Verify that these exact node versions can run on that release before
promising the matrix. The existing `2.39.10` ordinary-tool captures are a useful
reference environment, not formatter evidence.

Support both buffered and streaming delivery. The generic mechanism must work
through Chat Completions, OpenAI Responses, and Anthropic Messages using local
protocol fixtures; initially claim n8n wire compatibility only for the captured
Chat Completions path.

Defer legacy parser wrappers/names, example-to-schema inference parity, memory
serialization, auto-fix/repair LLMs, fallback models, nested Agent Tool execution,
and schemas outside the agreed validator profile until separately captured and
accepted. Record their unsupported status explicitly. Do not advertise support
for all inspected upstream node versions merely because the generic mechanism
can express them.

## Delivery sequence

### PR 1 — Capture the reference behavior

- Extend or add a capture scenario for terminal formatter calls. The current
  capture provider/probe requires four files and a second request for ordinary
  tools; terminal success needs a first-class one-request artifact shape. Do
  not manufacture a continuation to make that capture look complete.
- Use disposable synthetic workflows and the controlled provider. Follow
  [the capture guide](N8N_TOOL_CAPTURE_PROVIDER.md) and redaction/manifest
  conventions; retain exact request bytes and the n8n execution result.
- Capture formatter-only success, an ordinary-tool turn followed by formatting,
  valid plain-text JSON fallback, schema-invalid arguments, missing formatter
  with invalid final text, and mixed/duplicate formatter calls. Capture both
  delivery modes for the core success path and record actual request counts.
- Compare schema conversion and output behavior with extra properties,
  optional/required fields, and nested `output` keys. These expose differences
  between our evaluator and n8n's schema conversion/parser.
- Publish a supported/unsupported behavior table with application/node/model
  versions, source revision, fixture hashes, and known differences. Fixture
  requests prove orchestration; scripted model responses do not measure model
  compliance or reliability.

### Gate — Agree the contract

Review the decision table and capture findings with the user. Finalize ownership,
portable types, mixed-call behavior, fallback rules, validator support, answer
projection, and artifact migrations. Update this plan before implementation if
the evidence changes its proposed design. No runtime implementation starts
while a material contract decision remains unresolved.

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
| Core state and policy | Exact final value/source; single finalization; no pending formatter result; mixed-call policy; invalid/missing/unsupported cases; partial stream, transport failure, retry, cancellation, and late usage. |
| Protocols | Each existing adapter sends the designated schema/instruction and accepts streamed/buffered calls. Assert exact provider request counts and absence of fabricated formatter results. Preserve Responses/Anthropic continuation material for preceding ordinary tools. |
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

## Plan-only verification

This document is the only planned repository change in this branch. Validate
Markdown links and whitespace with `git diff --check` and inspect the staged
diff. No browser or runtime suite is required for a documentation-only change;
the implementation commands above are future requirements, not checks already
performed.
