# Final-output implementation contracts

These shapes implement the [final-output tools plan](N8N_FINAL_OUTPUT_TOOL_PLAN.md)
within its twelve approved policies. The evidence they cite is in the
[capture findings](N8N_FINAL_OUTPUT_CAPTURE_FINDINGS.md). No runtime code
implements them yet.

**Status (2026-10-29):** Draft gate specification. The five gate open items
are settled (see [Settled gate items](#settled-gate-items)). Three new
decisions found during the audit are awaiting the user
([Awaiting decision](#awaiting-decision)). One capture is open and blocks only
the n8n parity claim ([Open capture](#open-capture)). PR 2 may start once the
three decisions are made.

Names are proposals until PR 2 lands them. A change to a discriminant, a
serialized field or a diagnostic code after that is a format change.

## Settled gate items

Agreed with the user on 2026-10-29.

| Item | Settled rule |
| --- | --- |
| Root-level stripping | Left open as a capture (below). It does not block PR 2 or PR 3. Under the n8n profile, root stripping ships as the approved extension, with its own test, labelled as unmeasured. Until the capture lands, n8n parity is not claimed for a schema whose root omits `additionalProperties`, and PR 4 does not offer such an import as a faithful reconstruction. |
| Suppressed ordinary calls | They count as model calls, not executions. They stay in `completedToolCalls`, so `toolCallsInRun`, `tool-call-count`, `tool-call-arguments` and `toolCallCount` include them. They have no execution record, result, binding check or grant prompt. The trace shows them with the disposition `suppressed`. |
| Adopted-message text | The effective text: compact JSON with recursively sorted keys. The message is attributed as generated from a finalized result; see [Branching and adoption](#branching-and-adoption). |
| Acceptance comparison | n8n against Inference Lens compares normalized values structurally: deep equality, object key order ignored, array order kept. Formatter descriptor, instruction, raw arguments and provider-turn count are compared separately. Text-only differences such as key order are reported, not counted as mismatches. |
| Generic `parse-final-text` | Validates the parsed value against the authored schema as-is. No unwrapping, stripping, coercion or defaults. Fences follow the existing [JSON input policy](DETERMINISTIC_CHECKS.md), defaulting to `strict`. |

## Awaiting decision

Each is material under [AGENTS.md](../AGENTS.md) and is not settled by an
approved policy. Each has a recommendation.

### D1. Format version allocation

Current active formats: Project v15, RunTrace v8, ExperimentPlan v5,
ExperimentResult v6, check vocabulary 5. [Prompt environments](PROMPT_ENVIRONMENTS_PLAN.md#format-version)
has claimed active Project v16 and RunTrace v9. The staged shared format is
v17 (`packages/core/src/shared-project.ts`). Neither has landed in the active
formats. This feature needs a Project, RunTrace and ExperimentPlan bump.

| Option | Cost | Risk |
| --- | --- | --- |
| **A. Allocate at merge time. Final output takes the next free active number when PR 2 merges (Project v16 or v17, RunTrace v9 or v10, ExperimentPlan v6). The staged shared format renumbers to one above the active format whenever the two meet.** | One more mechanical renumber of the staged format, like the 2026-10-29 one. | Plans cite provisional numbers; each PR description must state the final ones. |
| B. Reserve now: Project v17 and RunTrace v10 for final output; staged shared moves to v18. | Renumber today. | If final output lands before environments, v16 never ships and a v15 → v17 path must reconcile a skipped version; that is the cost option C was rejected for in the environments plan. |
| C. Ship final output in the same active version as environments. | No extra numbers. | Couples two unrelated features' release schedules. |

**Recommendation: A.** The reservation that matters is which artifacts bump,
and that is fixed here. Whichever feature merges second rebases onto the
other's version and adds its own fields in one more step.

### D2. Where the adopted message's attribution lives

The agreed policy materializes a "clearly attributed" assistant message when a
finalized run is branched. Authored messages (`AssistantMessage` in
`run-kernel/types.ts`, persisted in project revisions) carry no provenance
field today.

| Option | Cost | Risk |
| --- | --- | --- |
| **A. Attribution in run evidence only.** The materialized message gets a derived ID (`message_<run>-t<n>-final-output`). Its `TranscriptEntry` carries `finalOutput: { turnId, attempt, source }`. The branch's existing `branchedFrom.messageId` points at it, and the composer's branch notice names it. The authored message stays plain assistant text. | Transcript and branch-notice changes only; no project-format field. | Once the branch is saved as a revision and edited, the project file alone does not say the text was generated; the child run's trace still does. |
| B. A new optional `generatedFrom` field on authored assistant messages. | A project-format field, validation, an editor rule for what an edit does to it, and every message serializer. | Widens a provider-neutral type for one feature. An edited message keeps or drops a claim that no longer describes it. |

**Recommendation: A.** Branch provenance already lives in the trace, and the
edited-message question has no good answer under B.

### D3. Schema surface for the generic profile

The approved bounded allowlist was written for the n8n normalizer. Generic mode
never normalizes. It only validates, and `packages/core/src/json-schema/`
already validates a restricted draft-07 profile with calibrated limits.

| Option | Cost | Risk |
| --- | --- | --- |
| **A. Generic accepts the existing preflight profile, with the root required to be `type: "object"`. n8n accepts only the narrow allowlist below.** | Reuses preflight and evaluator unchanged. | The two profiles reject different schemas; the editor must name the active profile in each diagnostic. |
| B. Both profiles use the narrow allowlist. | One rule set. | Rejects schemas the existing evaluator already handles correctly, for no generic-mode reason. |

**Recommendation: A.** Provider acceptance of a rich schema is a provider
question; preflight still rejects what the evaluator cannot run.

## Open capture

One more home-instance session. It blocks only the n8n parity claim for the
cases listed, not PR 2 or PR 3.

- Root with `additionalProperties` omitted, plus an extra root key. The
  inspected source predicts stripping: the same Zod default that stripped the
  nested key.
- Duplicate formatter calls with the first invalid.
- A mixed turn with an invalid formatter call.
- Fenced final text, wrapped and unwrapped. The source extracts a fence inside
  the parser after the agent's own wrapping step, so the two are predicted to
  differ.
- A payload that is exactly `{"output": {…}}`, which the source's
  `unwrapNestedOutput` would flatten.

Until each is captured, the n8n profile fails it with a distinct diagnostic
(below) rather than reproducing source-predicted behavior.

## Types and ownership

### Authored contract

Owner: a new `packages/core/src/final-output/contract.ts`. It is persisted on
`ProjectConversationRevision` as optional `finalOutput`. Absent means today's
behavior. Clone, branch, import and export copy it with the revision.

```ts
interface FinalOutputContractV1 {
  contractVersion: 1;
  /** Authored object schema. Key order is meaning: the model reads it. */
  outputSchema: JsonObject;
  profile: GenericFinalOutputProfile | N8nFinalOutputProfile;
}

interface GenericFinalOutputProfile {
  kind: "generic";
  tool: { name: string; description?: string };
  missingCall:
    | { kind: "fail" }
    | { kind: "parse-final-text"; inputPolicy: JsonInputPolicy };
}

interface N8nFinalOutputProfile {
  kind: "n8n";
  /** One captured profile exists: n8n 2.39.10, Agent 3.1, Structured Output Parser 1.3. */
  profileId: "n8n-agent-3.1-parser-1.3";
}
```

- `outputSchema` is added to `ORDER_SENSITIVE_KEYS` in
  `packages/core/src/stable-json.ts`, the same rule as a tool's `inputSchema`.
- The generic profile generates no instruction. The author writes their own
  system text. The n8n profile generates its instruction and has no authored
  name or description, because n8n fixes both.
- The editor proposes `final_answer` as the generic tool name. The tool-name
  rules in `tool-name.ts` apply.

### Compiled snapshot

Owner: `final-output/compile.ts`, pure. Called once by
`prepareProjectRevisionRun` and the runner's preparation; there is no browser
compiler. The result is copied into `ResolvedRunInput.finalOutput`, so plans,
cells and traces carry it.

```ts
interface ResolvedFinalOutput {
  contract: FinalOutputContractV1;
  compiled: {
    compilerVersion: 1;
    /** `generic` or the n8n profileId. */
    profile: string;
    profileVersion: 1;
    /** Reuses the tool wire shape. The id is fixed, not authored. */
    tool: ToolDefinition & { id: "tool_final-output" };
    instruction?: {
      placement: "append-to-first-system-message";
      separator: "\n\n";
      text: string;
    };
  };
}
```

- `ResolvedRunInput.messages` stays authored. The coordinator builds the first
  `ProviderTurnInput` from it by applying `instruction` and appending
  `compiled.tool` after the ordinary tools, in the captured order.
  Continuations already copy the previous attempt's input, and `turn.started`
  records the exact wire messages. Retry, continuation, branching and plan
  execution therefore never inject the instruction twice.
- n8n compiled values, from the captures: the tool name is
  `format_final_json_response` with the captured description; the wire schema
  is `{type: object, properties: {output: <authored, every object closed>},
  required: [output], additionalProperties: false, $schema: draft-07}`; the
  instruction is the captured `IMPORTANT: …` paragraph. The adapter emits
  `strict: false` as today.
- The n8n profile requires the resolved conversation to start with a system
  message. n8n always has one, and placement without one is uncaptured.

### Finalization events

Owner: `run-kernel/types.ts` (vocabulary), `reducer.ts` (invariants) and
`final-output/finalize.ts` (pure classification and validation, called by the
coordinator). Two events are added to `RunEvent`:

```ts
type ToolCallDisposition = "final-output" | "ignored-duplicate" | "suppressed";

interface FinalOutputEventBase {
  turnId: TurnId;
  attempt: number;
  exchangeId: ExchangeId;
  source:
    | { kind: "tool-call"; toolCallId: ToolCallId }
    | { kind: "final-text" };
  /** Every completed call in the attempt, in emitted order. */
  dispositions: Array<{ toolCallId: ToolCallId; disposition: ToolCallDisposition }>;
}

| ({ type: "final_output.accepted";
     /** The authored-schema payload after supported normalization. */
     value: JsonObject;
     normalization: {
       /** n8n only: unknown keys removed where the authored schema omitted additionalProperties. */
       strippedLocations: SafeLocationSegment[][];
       /** n8n final-text only: the generated parser input when it differs from the raw text. */
       parserInputText?: string;
     };
   } & FinalOutputEventBase)
| ({ type: "final_output.rejected";
     diagnostic: FinalOutputDiagnostic;
   } & FinalOutputEventBase)
```

Invariants (reducer):

- At most one `final_output.*` event per run. It follows the
  `assistant.completed` of the attempt it names, and only when
  `input.finalOutput` is present.
- When a contract is present and the completed attempt has calls,
  `assistant.completed` moves to `awaiting_tool_results` only if
  classification finds no formatter call and the profile allows ordinary
  dispatch. Otherwise the status stays `running` until the finalization event.
- `run.completed` is allowed with completed calls only after
  `final_output.accepted` for that attempt. `final_output.rejected` must be
  followed by `run.failed` with the new `RunError` code
  `"final_output_error"`, whose `details` carry the diagnostic.
- No `tool.result_supplied` and no `tool.execution_*` event ever names a call
  whose disposition is not ordinary dispatch.
- An attempt that failed, was cancelled or ended with `finishReason` `length`
  never finalizes. Usage reported after the finish frame is still drained
  before the finalization event.

**Replay:** `runStateFromTrace` re-runs `finalize.ts` on the recorded attempt
and rejects the trace if the event's source, dispositions, value or
normalization differ. Stored values are a cache, not a second truth.

### Classification

Run per completed attempt before any dispatch. The formatter is identified by
`compiled.tool.name`, never by a name alone without a contract.

| Turn contents | n8n profile | Generic profile |
| --- | --- | --- |
| Ordinary calls only | Dispatch as today. | Dispatch as today. |
| One formatter call | Validate it. | Validate it. |
| Formatter plus ordinary calls | First formatter wins; ordinary calls `suppressed` (captured, both orders). | Reject: `mixed-final-output-calls`; all calls `suppressed`. |
| Several formatter calls | First wins; later ones `ignored-duplicate` (captured when both are valid). If the first is invalid: reject, with no fall-through (local policy until captured). | Reject: `multiple-final-output-calls`. |
| No calls | Final-text fallback. | `fail`: reject with `missing-final-output-call`. `parse-final-text`: parse the text. |

### Validation and normalization

**Tool-call path.** The arguments must parse to a JSON object
(`ToolArguments.parsed`); otherwise `invalid-json`. Arguments larger than
`MAX_SCHEMA_OUTPUT_CODE_UNITS` fail with `resource-limit`. Generic mode
evaluates the authored schema against the arguments. n8n mode requires the
`output` wrapper (`n8n-wrapper-missing`), then normalizes and validates its
value as below. A fenced argument string is `n8n-uncaptured-input`.

**n8n final-text path** (agent steps parser plus Structured Output Parser 1.3
at the inspected source; wrapped and unwrapped plain text are captured):

1. Take the completed attempt's text. Empty or `{}` gives `n8n-empty-output`
   (the source's distinct message).
2. Parse the whole text as JSON. If it fails and the text contains a fence
   line, return `n8n-uncaptured-input`; otherwise `invalid-json`.
3. If the parsed value is an object whose only key is `output`, it is the
   wrapper. If the authored root declares an `output` property, this is
   ambiguous: `n8n-ambiguous-output-wrapper`. Otherwise wrap the value as
   `{output: value}` and record the generated `parserInputText`.
4. If the wrapped payload is itself exactly `{output: <object>}`, return
   `n8n-ambiguous-output-wrapper` (the source's `unwrapNestedOutput`,
   uncaptured).
5. Normalize and validate the payload.

**Normalization (n8n only).** Walk the payload against the authored schema.
At each supported object location, `additionalProperties: false` rejects
unknown keys (`schema-mismatch`), and an omitted `additionalProperties` strips
them, recording each location. Then evaluate the stripped value against the
authored schema with the existing evaluator. Raw arguments are never
validated against the closed wire schema.

**n8n allowlist.** Root and nested object schemas may use `type: "object"`,
`properties`, `required`, `additionalProperties: false` (or omit it),
`description` and `title`; the root may also use the draft-07 `$schema`.
Leaves may use `type: "string"` or `type: "integer"`, plus `description` and
`title`. Anything else, including arrays, enums, formats, defaults,
compositions, references, other leaf types and root scalars, is
`unsupported-schema-keyword` with its location. Limits are
`SCHEMA_CHECK_LIMITS` (schema size, depth, work and storage budgets).

### Diagnostics

`FinalOutputDiagnostic` is `{ code; message; location?: SafeLocationSegment[];
issues?: SchemaIssue[] }`. Messages never echo answer text.

| Code | Phase | Meaning |
| --- | --- | --- |
| `unsupported-schema-keyword` | preflight | Outside the profile's allowlist (or the existing preflight profile for generic). |
| `root-not-object` | preflight | Root schema is not `type: "object"`. |
| `tool-name-collision` | preflight | An enabled ordinary tool has the formatter's name. |
| `tools-unsupported` | preflight | The target's capability snapshot has no tools. |
| `streaming-unsupported` | preflight | Response mode is `streaming`. |
| `provider-option-conflict` | preflight | `providerOptions` sets a contract-owned field (table below). |
| `n8n-system-message-required` | preflight | The n8n profile has no system message to append to. |
| `invalid-json` | finalize | Arguments or text are not JSON (an object, for arguments). |
| `schema-mismatch` | finalize | Evaluator issues, with locations. |
| `missing-final-output-call` | finalize | Generic `fail`, and the turn ended without the formatter. |
| `mixed-final-output-calls` | finalize | Generic, formatter plus ordinary calls. |
| `multiple-final-output-calls` | finalize | Generic, more than one formatter call. |
| `incomplete-final-output-call` | finalize | Formatter arguments from an attempt that ended on `length`. |
| `resource-limit` | finalize | Input or work exceeded the calibrated limits. |
| `n8n-wrapper-missing` | finalize | Formatter arguments without the `output` wrapper. |
| `n8n-empty-output` | finalize | Empty or `{}` final text. |
| `n8n-ambiguous-output-wrapper` | finalize | Single-key `output` shapes the captures do not settle. |
| `n8n-uncaptured-input` | finalize | Fenced input, pending the open capture. |

Preflight diagnostics stop the run before a plan is saved or a provider is
contacted. Finalize diagnostics produce `final_output.rejected` and then
`run.failed`.

### Contract-owned provider fields

`providerOptions` setting any of these fails preflight. Nothing is merged
silently. `stream` keeps its existing override.

| Protocol | Owned fields |
| --- | --- |
| Chat Completions | `messages`, `tools`, `tool_choice`, `parallel_tool_calls`, `response_format`, `functions`, `function_call` |
| Responses | `input`, `instructions`, `tools`, `tool_choice`, `parallel_tool_calls`, `text` |
| Anthropic Messages | `system`, `messages`, `tools`, `tool_choice` |

The n8n profile also runs on Responses and Anthropic Messages. The request
preview and the run then say that n8n parity is claimed only for Chat
Completions.

## Effective answer and its consumers

Owner: `packages/core/src/run-output.ts`. `finalAssistantOutput` keeps its
meaning: raw text. A new function is added:

```ts
type EffectiveAnswer =
  | { kind: "text"; text: string }
  | {
      kind: "final-output";
      /** Compact JSON, recursively sorted keys, array order kept. */
      text: string;
      value: JsonObject;
      source: "tool-call" | "final-text";
      turnId: TurnId;
      attempt: number;
      toolCallId?: ToolCallId;
    };

function effectiveAnswer(state: RunState): EffectiveAnswer | undefined;
```

Without a contract it returns `{kind: "text", text: finalAssistantOutput}`, or
`undefined` where that is `undefined`. With a contract it returns the accepted
value, or `undefined` when none was accepted. Such a run has failed, so checks
already report it unavailable.

Consumers that move together to `effectiveAnswer(...)?.text` (PR 3, or PR 2 if
the two are combined):

| Consumer | Location |
| --- | --- |
| Check subject | `packages/core/src/checks.ts` (`runCheckSubject`) |
| Repeated-run and evaluation output statistics | `packages/core/src/experiment.ts` (`summarize…`, output character counts) |
| Live response pane | `app/run/response-view.ts` (`responseContentOf`) |
| Saved run evidence | `app/run/run-evidence-detail.client.tsx` |
| Repeated and evaluation workspaces | `app/run/repeated-experiment-workspace.client.tsx`, `app/evaluations/evaluation-results-workspace.client.tsx`, `app/evaluations/evaluation-comparison-workspace.client.tsx` |
| Run diff | `packages/core/src/run-diff.ts` gains a final-output row; per-attempt text rows stay raw evidence |
| Copy | `app/response-output.client.tsx` copies the `output` it is given, so it follows the response view |
| CLI summary | `packages/cli/src/summary.ts` never quotes output; its `distinctFinalAssistantOutputs` count comes from the experiment summary above |
| Branching | `app/run/pending-branch.ts` (below) |

Unaffected and staying raw evidence: reasoning, `toolCallsInRun`,
`toolCallCount`, tool-execution records, usage and exchange frames. Decision
runs have their own answer contract and are out of scope.

## Branching and adoption

`transcriptFromRunState` stays a faithful projection: the finalized turn's
assistant message keeps its formatter call. A new
`executableTranscriptFromRunState` is what `branchFromTranscript` and
`branchFromSavedTrace` use. For a run with `final_output.accepted`, it
replaces that turn's assistant entry with:

- an assistant message `message_<run>-t<n>-final-output` whose only content
  is the effective text, with no tool calls;
- the attribution chosen in D2.

Branching from a message before the finalized turn is unchanged. No branch
draft ever contains a formatter call without a result. A rejected
finalization offers no materialized message; branching from the failed turn
offers the raw transcript up to the user message, as for any failed run.

"Adopting" a saved trace into the workbench (`adoptTrace`) only displays it,
so it uses `effectiveAnswer` and needs no materialization.

## Artifact compatibility

Version numbers depend on D1.

- **Project.** `ProjectConversationRevision.finalOutput?` is added in a strict
  new version. Older documents upgrade with no contract. A document from the
  new version is rejected by old readers with a version error.
- **RunTrace.** `ResolvedRunInput.finalOutput?`, the two events, the
  `final_output_error` code and replay validation are added. Older traces
  parse unchanged, get no inferred finalization, and keep `effectiveAnswer`
  equal to `finalAssistantOutput`.
- **ExperimentPlan.** `commonInput` and evaluation case inputs embed
  `ResolvedRunInput`, so they gain `finalOutput?` in a new plan version.
  Execution hashes include it.
- **ExperimentResult.** No bump. Its shape does not change, and the only runs
  whose answer differs require the new plan version.
- **Check vocabulary.** No bump. Check definitions do not change, and every
  artifact an older reader can open has `effectiveAnswer` equal to the raw
  text. Historical assessments are therefore unchanged. Reassessing a new
  trace needs a new reader anyway.
- **External imports (PR 4).** The candidate and receipt digests include the
  imported parser evidence (node versions, schema, attribution of the injected
  instruction). Evidence outside the captured profile imports as inspectable
  but not executable.

## Test mapping

Each policy is listed separately, as the gate requires. "Captured" means a
home-instance capture backs it; "extension" means an approved local rule.

| Policy | Basis | Coverage |
| --- | --- | --- |
| Formatter call finalizes with no dispatch or extra request | Captured | Kernel regression first (red: today waits for tool results with an empty answer); runner; Chat Completions fixture |
| Ordinary tool, then formatter | Captured | Kernel and runner; e2e with a mock tool |
| Same tool name without a contract dispatches normally | Extension | Kernel negative test |
| Mixed turn, n8n: first formatter, ordinary suppressed | Captured (both orders) | Kernel; check reads suppressed calls; no execution record |
| Mixed turn, generic: rejected | Extension | Kernel |
| Duplicate valid formatters, n8n: first wins | Captured | Kernel |
| Invalid-first duplicate, n8n: reject, no fall-through | Extension (open capture) | Kernel |
| Wrapped and unwrapped final text, n8n | Captured | `finalize.ts` units against capture fixtures |
| Invalid JSON and schema mismatch are distinct | Captured | Units with diagnostic codes |
| Nested authored `output` survives | Captured | Units |
| Nested stripping of omitted `additionalProperties` | Captured | Units against the nested-extra fixture |
| Root stripping | Extension (open capture) | Units, labelled |
| Fences, single-key `output`, empty text under n8n | Extension (fail clearly) | Units |
| Generic `parse-final-text` with input policies | Extension | Units reusing `json-input` cases |
| Incomplete arguments never finalize | Extension | Kernel with `length` finish |
| Retry, cancellation, late usage | Extension | Kernel |
| Streaming rejected before provider work | Extension | Preparation unit; CLI start blocker |
| Owned provider fields rejected | Extension | Preparation unit per protocol |
| Tool-name collision rejected | Extension | Preparation unit |
| Responses and Anthropic serialize the formatter | Extension | Adapter fixtures |
| Effective text is sorted compact JSON | Extension | Unit; check and statistics agreement |
| Replay rejects an inconsistent finalization | Extension | Trace parse units |
| Old artifacts keep their answers | Extension | Format migration units |
| Branch has no unresolved formatter call | Extension | `pending-branch` units; e2e branch from a finalized run |
| Display, save, reopen and copy agree | Extension | e2e: run, save, reopen, copy |
| n8n acceptance comparison is structural | Settled gate item | Capture-replay acceptance test |
