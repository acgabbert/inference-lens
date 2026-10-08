# n8n-compatible MCP tool execution plan

**Status:** N0, M1, M2, and M4 are implemented; the local interactive M3 slice is accepted and its live checks are automated. N1 has one reviewed string-input comparison. The next slice expands N1 evidence; see the [N1 matrix runbook](N1_MATRIX_RUNBOOK.md). Phase 6 hardening items remain deferred. No general n8n compatibility claim or presentation policy has been adopted.

**Original baseline:** `main` at `a15b96c`, reviewed September 23, 2026.

**Primary goal:** let Inference Lens discover and execute tools from a user-run
MCP server while presenting those tools and their results to an
OpenAI-compatible model as faithfully as n8n presents ordinary **Call n8n
Workflow Tool** sub-workflows.

**Initial reference environment:** disposable workflows on the user's home n8n
server, synthetic inputs, and the repository's controlled OpenAI-compatible
provider fixture.

## Progress through September 24, 2026

- **N0 — captured:** Eleven complete, redacted two-turn n8n `2.39.10` provider-wire fixtures are committed. [The first structural comparison](N8N_PROVIDER_WIRE_COMPARISON_2026-09-24.md) found that Inference Lens serializes equivalent supplied descriptors into matching initial requests. Continuations differ in empty assistant content, Agent 3.x call-ID augmentation inside argument text, and the extra Inference Lens tool-result `name`. n8n result arrays and errors remain the target for a later MCP-backed comparison.
- **M1 — accepted:** [The official SDK interoperability spike](MCP_SDK_INTEROPERABILITY_DECISION.md) selected `@modelcontextprotocol/client` `2.1.0`, Streamable HTTP, host-owned authorization, bounded responses, and normalized execution failure classes.
- **M2 — implemented:** The service-hosted app reads an operator-owned `INFERENCE_LENS_MCP_SERVERS` catalog, connects only on explicit discovery, lists paginated tools, shows schema and refresh changes, and attaches detached project or next-request snapshots. A portable source receipt contains the remote name and fingerprint, without a server profile ID, endpoint, or credentials. The implementation and setup are in [MCP discovery and attachment](MCP_DISCOVERY.md). The local browser fixture negotiated `2025-11-25`; live authorization and a modern-protocol app run were not exercised in this slice.
- **M3 — local interactive execution implemented:** A user can allow one attached tool to call a declared unauthenticated loopback MCP server. Each call asks by default; automatic execution requires a separate per-tool opt-in and is scoped to the browser/service session. The host keeps consent, rechecks the operator declaration and remote fingerprint before calling, and returns normalized outcomes through the existing executor seam. [The M3 contract](MCP_M3_EXECUTION_DESIGN.md) records the boundaries and remaining live checks. Authenticated or remote execution, Tauri, and unattended batches remain outside this slice.
- **Verification:** the M3 build, 639 core tests, 173 additional repository tests, and the full 211-test Playwright suite passed. The committed fixture verifies approval, rejection, automatic execution, project and next-request attachments, provider continuation, tool-reported error, structured output, timeout, manual fallback, and secret-free trace evidence. Cancellation while a call is in flight, imported-trace rendering without its server, and a modern-protocol app run remain to be checked.

**September 26 N1 update:** [The string-input comparison](N1_STRING_INPUT_COMPARISON.md)
uses the existing n8n baseline and a complete Python MCP-backed UI run. Both
actual provider requests are captured. Name, description, prompts, call-ID linkage,
and result text match; SDK schema and continuation presentation differences are
enumerated at exact paths. Mutation regressions detect name/schema/result drift.
No presentation policy was introduced. Exact n8n wire parity would require a
separately agreed versioned design; broader scenarios remain unmeasured.

**September 26 acceptance update:** the user confirmed the Python-server UI run
negotiated `2026-07-28`, cancellation in flight behaved as expected, and killing
the server produced a red failure banner offering a manual result to continue.
These three live checks are accepted on the user's report. Actual continuation
after entering a manual result was not separately reported for server loss;
the automated fixture covers continuation after timeout. The user also confirmed
successful trace import and rendering with the Python server stopped, closing
the remaining M3 live check. The local interactive slice is accepted; N1's broader
compatibility scope remained separate work; M4's repeated runs/evaluations
were implemented afterward.
These live checks are now automated browser regressions, including a Python lane
in CI; see the acceptance record below.
See the
[M3 acceptance record](MCP_M3_EXECUTION_DESIGN.md#regression-and-acceptance).

**September 26 M4 implementation:** [the M4 batch design](MCP_M4_BATCH_DESIGN.md)
revises decision 8 and Phase 5. Command and MCP tools share one browser-side
grant record, and the service validates each call without holding permission
state. This replaces M3's service-side session consent. A batch that stops
because a tool became unavailable is recorded as `stopped` in a v5 experiment
result.

**Current status after PR #119:** the dated progress entries above describe
their original slices. M4 is merged, so unattended repeated runs/evaluations
are no longer future work, and browser-local grants that last until revoked
supersede M3's service-session consent. Preflight runs on Start before saving
the plan or calling the provider; the confirmation dialog does not itself
perform discovery. Unavailability stops a batch; a timeout fails only its
repetition. Execution still supports only unauthenticated literal-loopback
Streamable HTTP servers. Authenticated/remote execution and Tauri remain deferred.

### Next slice: expand N1 evidence

Use the [runbook](N1_MATRIX_RUNBOOK.md) to capture primitive inputs, nested
inputs, multiple output items, and native MCP tool errors through the actual
UI and Python SDK, then compare both provider requests with the existing n8n
captures. Keep SDK-generated schemas and explicit fixture-owned text results;
do not alter the application serializer to erase measured differences.

Empty-output has workflow stubs but **no committed n8n provider-wire capture**.
Capture that reference first; a stub is not an expected provider response.
Fixed inputs, rejected arguments, and multiple attached tools are later N1
extensions, not covered by the four-scenario harness.

The deliverable is a reviewed path-by-path difference inventory and a bounded
compatibility decision, not merely a green browser suite. Before implementing
any presentation policy, agree its owner, selection/persistence, trace
representation, source scope, supported versions, and result projection with
the user. M5 remains driven by observed needs.

## Relationship to earlier planning

This plan refines the unimplemented M1–M4 portion of the symlinked
`notes/EXECUTOR_MCP_AND_EVALS_SEQUENCE.md` after clarifying the intended use
case. It does not revisit the shipped executor foundation, command-tool
executor, automatic batch continuation, evaluation tool exposure, or tool-call
checks.

The inherited contracts remain:

- `ToolDefinition` is the portable, provider-neutral descriptor shown to the
  model.
- `ToolBinding` is device-local execution capability and does not travel in a
  project, experiment plan, or trace.
- Interactive tool calls pause before execution. The pause is the per-call
  approval gate.
- Repeated runs and evaluations may execute only bindings covered by an
  explicit standing grant and disclosed in preflight.
- Executor behavior is normalized into the existing execution outcome and
  RunTrace event vocabulary.
- Non-text executor content is projected visibly into the current text-only
  provider vocabulary; it is never silently discarded.
- `packages/core` remains independent of MCP SDK and host dependencies.

The earlier MCP exploration treated generic ecosystem interoperability as the
main value. The clarified product target is narrower and more testable:

1. Observe the exact provider-wire tool contract produced by n8n sub-workflow
   tools.
2. Connect Inference Lens to a separately operated MCP server.
3. Snapshot selected MCP tools into ordinary Inference Lens tool definitions.
4. Present those definitions and later tool results to the model using the
   measured n8n-compatible contract.
5. Route the model's ordinary tool call back to the MCP server without making
   MCP part of the provider-visible protocol.

## Executive design

MCP is the execution and discovery boundary. It is not the model-facing
protocol.

```text
User-run MCP server
    │
    │ tools/list
    ▼
Inference Lens MCP adapter
    │
    │ immutable ToolDefinition snapshot
    ▼
Provider request builder
    │
    │ ordinary OpenAI-compatible `tools`
    ▼
Model
    │
    │ ordinary `tool_calls`
    ▼
Inference Lens approval / standing-grant gate
    │
    │ tools/call
    ▼
User-run MCP server
    │
    │ MCP tool result
    ▼
Inference Lens result projection
    │
    │ ordinary provider `role: "tool"` message
    ▼
Model continuation
```

For the same descriptor, arguments, and projected result, the provider should
not be able to tell whether a call was served by a project mock, an
operator-declared command, an MCP server, or a person. Executor provenance is
for Inference Lens and its trace, not for accidental insertion into the prompt.

## Product outcome

A user can:

1. Configure an approved MCP server on the device running Inference Lens.
2. Test the connection and inspect its identity and supported capabilities.
3. Browse its discovered tools without exposing them automatically.
4. Attach selected tools as detached, immutable snapshots to a project or the
   next request.
5. See and approve an MCP-backed call before an interactive execution.
6. Run repeated requests and evaluations against explicitly granted MCP tools.
7. Inspect normalized execution evidence, duration, failure class, result
   projection, and secret-free executor identity.
8. Compare the exact provider-visible tool definition and tool-result message
   against a captured n8n reference contract.
9. Refresh discovery, review a schema/description diff, and deliberately create
   an updated tool snapshot without changing previous runs or attached tools.

## Non-goals for the first release

- Inference Lens acting as an MCP server.
- Reimplementing the n8n workflow engine or executing n8n workflow JSON.
- Claiming compatibility from authored n8n workflow fields alone.
- MCP resources, prompts, roots, sampling, elicitation, subscriptions, or
  experimental tasks.
- OAuth, dynamic client registration, or arbitrary browser-provided headers.
- Direct browser-to-MCP connections.
- Stdio process management.
- Tauri MCP parity in the first product slice.
- Silent exposure of every discovered tool.
- Automatic replacement of attached definitions when a server changes.
- A proprietary MCP SDK or an Inference Lens-specific Python runtime.
- A general conditional-mock language.
- Provider-specific tool behavior hidden inside `packages/core`.

## Terms and identities

The following identities must remain distinct:

| Identity | Owner | Portable | Purpose |
| --- | --- | --- | --- |
| MCP server profile ID | Local host | No | Selects an approved endpoint and host-owned authorization. |
| Remote MCP tool name | MCP server | No | Dispatch key supplied to `tools/call`. |
| Attached `ToolId` | Project or request | Yes | Stable identity of the immutable descriptor snapshot. |
| Model-visible tool name | Attached definition | Yes | Name serialized into the provider request and returned by the model. |
| Executor identity | Run evidence | Secret-free only | Explains which approved capability served the call. |
| n8n contract version | Compatibility adapter | If used by a run | Names the measured transformation rules used for serialization. |

The remote name and model-visible name are often equal but must not be treated
as the same identity. A collision or n8n-compatible normalization may require a
different model-visible name while execution must still dispatch the original
remote name.

## Ownership and contracts

### Portable descriptor

The existing `ToolDefinition` remains the only tool contract the run kernel and
provider request builder consume. Attaching an MCP tool copies at least:

- chosen model-visible name;
- title, when useful as display-only metadata;
- description;
- input JSON Schema;
- optional output-schema snapshot if retained outside the provider contract;
- secret-free source receipt sufficient to explain where the snapshot came
  from, without making the project depend on the source server.

The attachment is detached. A project copied to another device remains
readable and evaluable with a mock or another local binding even if the source
MCP server is unavailable.

No MCP endpoint, authorization header, token, session identifier, process
command, or local server profile ID enters the portable descriptor.

### Device-local MCP profile

Recommended first contract, owned by the host service rather than project
data:

```ts
interface McpServerDeclaration {
  schemaVersion: 1;
  id: string;
  label: string;
  transport: "streamable-http";
  endpoint: string;
  authorization:
    | { kind: "none" }
    | { kind: "bearer-env"; environmentVariable: string }
    | {
        kind: "header-env";
        headerName: string;
        environmentVariable: string;
      };
  connectTimeoutMs: number;
  callTimeoutMs: number;
  maxResponseBytes: number;
}
```

As with command tools, the page selects a declaration by ID but cannot invent a
URL, header, environment variable, or timeout. The operator-owned declaration
is the security ceiling. This is appropriate for local and self-hosted web
deployments, including deployments reachable by more than one browser user.

A later desktop-only profile UI may own native secure persistence, but it must
not weaken the service-hosted boundary by letting an arbitrary page cause SSRF
or attach credentials to an unapproved origin.

### Device-local grant and binding

M2 should generalize the command-specific grant concept instead of adding a
second consent system. Conceptually:

```ts
interface LocalToolGrant {
  toolId: ToolId;
  binding:
    | { kind: "command"; declarationId: string }
    | {
        kind: "mcp";
        serverId: string;
        remoteToolName: string;
        discoveryFingerprint: string;
      };
  grantedAt: string;
}
```

The concrete migration from the current command-grant storage needs its own
compatibility test. Existing command grants must continue to resolve after the
storage shape is generalized.

An MCP binding added to `ToolBindingConfig` should contain only what execution
needs after the host declaration is resolved:

```ts
type McpToolBinding = {
  kind: "mcp";
  executorId: string; // stable, secret-free identity
  label?: string;
  grantedAt: string;
  serverId: string;
  remoteToolName: string;
  discoveryFingerprint: string;
};
```

`toolExecutorIdentity` must construct the recorded MCP identity explicitly. It
must not record the endpoint, authorization mode, headers, token references,
grant timestamp, or protocol session data.

### Discovery snapshot and fingerprint

Discovery is live catalog data; attachment is an immutable snapshot.

The fingerprint should be derived from a documented canonical representation
of the remote tool name, description, input schema, output schema, and the MCP
fields that materially affect execution or presentation. It should not include
pagination order, server timestamps, icons, or connection/session metadata.

On refresh:

- unchanged fingerprint: binding remains current;
- changed fingerprint: show a field-level diff and keep the existing snapshot;
- missing remote name: mark the binding unavailable but keep the snapshot;
- malformed tool: show it as undiscoverable/invalid and do not attach it;
- replacement accepted: create or update through the same deliberate immutable
  revision semantics used by the tool registry, never mutate historical input.

### Name policy

Faithful n8n comparison argues against unconditional server-prefixing.

Recommendation:

1. Preserve the remote name as the default model-visible name when it is valid
   and unique in the request.
2. Require an explicit model-visible alias when it is invalid or collides.
3. Persist that alias in the attached portable `ToolDefinition`.
4. Keep `remoteToolName` only in the local binding.
5. Show both identities in discovery, approval, and trace evidence when they
   differ.

Do not silently rename a tool at run preparation time. That would make prompts,
checks, replay, and n8n comparison depend on request ordering.

### Result projection

The MCP adapter returns the existing normalized `ToolExecutionOutcome`.

- MCP application result with `isError: false` → completed execution.
- MCP application result with `isError: true` → completed execution carrying a
  tool-reported error; the model receives it.
- JSON-RPC error, invalid response, timeout, disconnect, cancellation, or
  policy rejection → failed execution; no fabricated tool result.
- Text content → current text result vocabulary.
- Image, audio, and resource content → existing explicit placeholders plus
  projection notes.
- Structured content → retain a bounded, redacted normalized form in MCP
  evidence and project it according to the chosen presentation contract.

The exact concatenation and serialization of multiple MCP content items is a
compatibility decision. Phase 0 must measure n8n sub-workflow result
serialization before the product claims n8n compatibility.

### Compatibility presentation profile

Do not add an `n8n mode` merely because n8n is the reference environment.

After Phase 0, compare n8n's provider-wire contract with the current Inference
Lens OpenAI-compatible serializer. There are two outcomes:

1. **Equivalent contract:** no new mode. Capture fixtures become regression
   tests for the ordinary serializer.
2. **Stable material differences:** add a small, versioned presentation policy
   that transforms the provider-visible descriptor or result message while
   leaving `ToolDefinition`, `ToolBinding`, and MCP execution provider-neutral.

If introduced, the policy must be recorded with resolved run input or another
immutable run-owned contract. A historical trace must say which rules produced
the request. It must not be an ambient UI preference that can change replay.

Potential measured differences include:

- tool-name normalization;
- omission or rewriting of schema keywords;
- required-field construction;
- description formatting;
- order or shape of provider tool fields;
- tool-choice defaults;
- serialization of scalar, object, array, empty, and multi-item workflow
  results into a provider `role: "tool"` message.

JSON object key order should be preserved in raw captures but should not by
itself trigger a semantic compatibility feature unless a provider is shown to
depend on it.

## Phase 0 — capture the n8n provider-wire contract

### Purpose

Measure the contract that matters. n8n's authored workflow JSON and retained
execution data are useful provenance, but the controlled provider request is
the authoritative evidence of what the model saw.

The existing `scripts/n8n-echo-provider.mjs` is a useful starting point, but it
currently echoes only messages and intentionally supports fixtures with no
agent tools. Extend or replace it with a scripted capture provider rather than
teaching production code about n8n internals.

### Scripted provider behavior

The fixture supports `/v1/models` and `/v1/chat/completions` and runs one named
scenario at a time.

For a tool-call scenario:

1. Receive the initial n8n provider request.
2. Validate the expected model and scenario sentinel.
3. Save the complete redacted body without reserializing nested values.
4. Return a deterministic assistant `tool_calls` response with fixed call ID,
   tool name, and arguments.
5. Receive the continuation request after n8n runs the sub-workflow.
6. Save the complete redacted continuation body.
7. Validate the assistant call and provider `role: "tool"` result linkage.
8. Return a deterministic final assistant response.
9. Expose a local-only status endpoint or output file saying whether the
   scenario completed and why it failed.

The provider must never forward requests to a real model. Its purpose is
contract observation, not proxying production traffic.

### Fixture layout

Recommended location:

```text
tests/fixtures/n8n/captures/<n8n-version>/<scenario>/
  manifest.json
  workflow.json
  subworkflow.json
  execution.json
  provider-request-initial.json
  provider-response-tool-call.json
  provider-request-continuation.json
  provider-response-final.json
  observations.md
```

`manifest.json` should include:

- n8n version;
- AI Agent node type and version;
- OpenAI Chat Model node type and version;
- Call n8n Workflow Tool node type and version;
- Execute Sub-workflow Trigger node type and version;
- capture timestamp;
- scenario ID;
- request count;
- expected remote/model-visible tool name;
- redaction version;
- hashes of the raw staged inputs used to create the committed projection.

Raw API responses and unredacted provider captures remain under
`.n8n-contract-staging/` and are never committed.

### Fixture matrix

Start with the exact node versions installed on the home n8n server. Do not
upgrade a fixture in place; a migrated node version creates a new fixture.

Minimum cases:

| Case | What it establishes |
| --- | --- |
| One string input | Baseline name, description, schema, required list, and result message. |
| Name with spaces/punctuation | n8n's model-visible normalization rule. |
| Long description | Whether description text is preserved or wrapped/rewritten. |
| String, number, boolean | Primitive schema mapping and coercion. |
| Object and array | Nested schema preservation and argument acceptance. |
| Required and optional-looking fields | Actual required-list behavior, including n8n limitations. |
| Fixed plus `$fromAI()` inputs | Which fields reach the model and which are resolved only by n8n. |
| Multiple attached tools | Ordering, naming collisions, and aggregate request shape. |
| Empty workflow output | Tool-result serialization for no items/content. |
| Scalar/object output | Serialization boundary between workflow data and tool text. |
| Multiple output items | Array/wrapper behavior and ordering. |
| Workflow-reported error | Whether the model receives a tool message and its exact content. |
| Schema-rejected arguments | Whether execution reaches the sub-workflow and what continuation occurs. |

Where n8n cannot express a schema distinction, record that as a finding rather
than manufacturing an expected representation.

### Redaction rules

The capture/redaction pipeline must remove or deterministically replace:

- workflow, project, execution, node, and credential IDs;
- instance URLs and instance IDs;
- authorization headers and credential material;
- webhook URLs;
- timestamps that do not define behavior;
- user/account metadata;
- unrelated execution data.

It must preserve:

- complete messages relevant to the target agent/model run;
- the complete provider `tools` and `tool_choice` fields;
- tool-call IDs after deterministic replacement;
- tool names, descriptions, schemas, and arguments;
- role ordering;
- tool-result content exactly after secret replacement;
- model options that affect the request contract.

### Phase 0 acceptance

- At least one complete two-turn tool execution is captured from the home n8n
  server.
- The committed fixture can prove what the initial model request contained and
  how the sub-workflow output returned to the model.
- The fixture is reproducible from documented disposable workflows.
- Redaction tests prove sentinel secrets, URLs, and credential IDs cannot enter
  committed output.
- A review records which differences from current Inference Lens serialization
  are semantic, cosmetic, version-specific, or unknown.
- No production Inference Lens schema changes in this phase.

## Phase 1 — throwaway MCP interoperability spike

### Reference MCP server

Build a separate, disposable Python server with the official stable MCP Python
SDK. It is a development fixture and potential starting point for the user's
real tool server, not code embedded in Inference Lens.

Expose two synthetic tools:

- `lookup_test_record`: read-only, deterministic, structured input and output;
- `submit_test_action`: harmless mutation sentinel capable of success,
  tool-reported error, delay/timeout, and controlled exception paths.

Use decorator/type-hint schema generation for the ordinary case. Add one
low-level exact-schema tool only if Phase 0 shows that generated schemas cannot
represent a required n8n reference case.

### Inference Lens spike

From a throwaway server-side route or script:

- connect over Streamable HTTP;
- negotiate the released protocol version supported by the pinned SDK;
- list tools, including pagination if the SDK/server exposes it;
- call each tool;
- cancel a delayed call;
- classify application error versus transport/protocol failure;
- measure raw and normalized response sizes;
- prove authorization remains host-side;
- record the SDK dependency and bundle impact;
- verify that no SDK type is needed by `packages/core`.

Also determine whether the current MCP revision used by the selected n8n/server
environment is served by the pinned client. Protocol fallback must come from
the official SDK, not an Inference Lens reimplementation.

### Phase 1 decisions

The spike must produce a short decision record settling:

- exact TypeScript SDK package and pinned version;
- exact supported MCP protocol revision(s);
- Node host placement;
- connection lifetime: per discovery/call versus pooled client;
- cancellation and timeout ownership;
- maximum discovery and result sizes;
- raw MCP evidence boundary;
- support or explicit rejection of legacy HTTP+SSE fallback;
- error mapping into `ToolExecutionFailure`;
- feasibility of the proposed operator-owned server catalog.

Throw away the spike implementation after recording the decisions. No product
format should depend on experimental SDK types.

### Phase 1 acceptance

- The Python server is callable by an official independent MCP client and the
  Inference Lens spike.
- Both clients observe the same tool list and results.
- Cancellation, timeout, tool error, and connection failure are distinguishable.
- A captured schema can be converted to an existing `ToolDefinition` without
  losing model-visible fields required by the n8n fixture.
- The provider request produced from that definition can be structurally
  compared with the n8n reference fixture.

## Phase 2 — connections and discovery, without execution

Land discovery separately because remote names, descriptions, schemas, icons,
and annotations are untrusted inputs shown in the same application that grants
execution capability.

### Host service

- Parse and validate an `INFERENCE_LENS_MCP_SERVERS` operator catalog.
- Resolve authorization from named environment variables only when contacting
  the declaration's pinned origin.
- Apply HTTPS by default with an explicit loopback HTTP development exception.
- Reject credentials in URLs.
- Enforce SSRF policy before attaching authorization.
- Bound redirects, response sizes, connection time, and discovery time.
- Return normalized server identity, capabilities, and discovered tools to the
  UI without returning credentials or arbitrary response headers.
- Redact endpoint and authorization details from errors shown to untrusted
  browser clients where deployment policy requires it.

### UI

- List operator-declared MCP servers and availability.
- Connect deliberately; do not probe every server on app startup.
- Show server label, safe endpoint identity, negotiated protocol, capabilities,
  and last refresh time.
- Browse, search, and inspect tools.
- Show complete normalized input schema and source name.
- Attach selected tools to the project or next request as snapshots.
- Require explicit aliases for invalid/colliding names.
- Show invalid or unsupported schemas without offering attachment.
- Do not create an execution grant merely by browsing or attaching.

### Phase 2 acceptance

- A fixture server with paginated discovery is fully listed.
- A tool-list change produces a diff and does not mutate an attached tool.
- Malicious descriptions render as text and cannot execute markup/script.
- Oversized, recursive/pathological, or malformed schemas fail recoverably.
- Attachment writes only portable descriptor data.
- Project export contains no server ID, endpoint, authorization reference, or
  MCP session value.
- No MCP tool can execute in this phase.

## Phase 3 — interactive MCP execution

### Core extension

- Add the `mcp` member to `ToolBindingConfig`.
- Add its explicit `toolExecutorIdentity` projection.
- Add an MCP case to the single executor factory.
- Reuse `executeToolCall`; do not introduce MCP-specific run events.
- Reuse the existing manual fallback after executor failure.
- Keep argument validation and provider continuation behavior independent of
  the transport.

### Host execution endpoint

The browser submits only:

- declared server ID;
- remote tool name resolved from an existing local grant;
- invocation arguments;
- correlation identifier needed by Inference Lens;
- cancellation signal through the host API contract.

The host re-resolves the server declaration and grant. It must not trust a URL,
authorization header, timeout, or alternate remote name supplied by the page.

The endpoint:

- calls `tools/call` through the pinned official SDK;
- enforces configured timeout and response-size limits;
- handles cancellation;
- normalizes MCP application errors separately from protocol/transport errors;
- returns the bounded normalized content required by `ToolExecutionOutcome`;
- retains raw protocol evidence only behind the redaction/evidence boundary
  decided in Phase 1.

### Interactive approval

Before execution, show:

- model-visible tool name;
- MCP server label;
- remote tool name when different;
- parsed arguments and raw argument text if parsing differed;
- a statement that approval will contact the configured server;
- cancel/reject and execute actions.

Approval applies to that call only. Rejecting does not contact the server and
does not fabricate a tool result. A user may still type a manual result.

### Phase 3 acceptance

- A deterministic provider fixture requests the attached MCP tool.
- The MCP server receives exactly one call only after approval.
- The continuation provider request contains the expected ordinary tool result.
- Rejecting produces zero MCP and provider continuation calls.
- A tool-reported error is supplied to the model as a completed tool result.
- Timeout, cancellation, malformed response, and connection loss remain failed
  executions with manual fallback.
- RunTrace records only the secret-free MCP executor identity and normalized
  execution events.
- Imported traces render without access to the original MCP server.
- The same provider-visible request can be compared with the Phase 0 n8n fixture.

## Phase 4 — n8n compatibility decision and replay

### Structural comparator

Build a pure comparison over provider requests that separates:

- semantic difference;
- allowed redaction/identifier difference;
- ordering-only difference;
- unsupported evidence;
- version-specific difference.

At minimum compare:

- message roles and content;
- model-visible tool names and descriptions;
- parameter schema structure and required lists;
- tool ordering;
- `tool_choice` and parallel-tool-call options;
- assistant tool-call structure;
- tool-call ID linkage;
- provider tool-result content.

The comparator must show the exact path and both values for a mismatch. A
single pass/fail badge is insufficient for compatibility work.

### Compatibility outcome

If current serialization matches semantically, ship the n8n fixture as a
regression test and call the capability **n8n-reference verified** for the
captured versions. Do not add UI mode.

If it does not match, design the smallest versioned presentation policy that
accounts for measured differences. Before implementing that policy, decide:

- its type and owner;
- where the selected policy is persisted;
- how it appears in resolved run input and trace inspection;
- whether it affects every tool or selected tool sources;
- how unsupported n8n/node versions are reported;
- whether result projection is reversible or only reproducible from raw
  evidence.

Do not use the name “n8n compatible” without naming the captured n8n and node
versions. Compatibility is evidence-backed and versioned, not a blanket claim.

### Phase 4 acceptance

- One MCP-backed Inference Lens run matches a captured n8n provider request for
  the baseline sub-workflow tool scenario, or the UI reports exact remaining
  differences.
- The comparison covers both the initial tool definition and continuation
  result message.
- A deliberate schema/name/result mutation makes the regression fail for the
  correct value.
- The fixture identifies all n8n and node versions that support the claim.

## Phase 5 — evaluations and repeated runs

Implemented by M4. The shared sequential controller resolves both command and
MCP bindings. The [M4 contract](MCP_M4_BATCH_DESIGN.md) supersedes the original
assumption that no artifact change was needed: v5 adds a truthful `stopped`
status and reason for a batch stopped by tool unavailability.

### Scope

- Generalize command grants into the shared local capability grant model.
- Allow a project tool to bind to one approved MCP server tool on the device.
- Treat a valid MCP binding as automatically resolvable in batch preflight.
- List the exact server/tool serving each exposed tool in confirmation.
- Snapshot only portable descriptors into the experiment plan.
- Join MCP bindings at execution time like runtime inference targets and
  command bindings.
- Enforce the suite/repeated-run turn ceiling and existing provider-call cost
  bounds.
- Fail only the affected repetition on MCP execution failure.
- Keep later repetitions runnable unless the connection-wide failure policy
  explicitly stops the batch.

### Standing consent

Interactive approval does not scale to unattended batches. The local binding
grant is the standing consent, while the batch confirmation discloses the
resolved capability before cost is incurred.

The confirmation must state:

- portable tool name;
- server label and remote tool name;
- number of selected cases/configurations/repetitions;
- provider-call floor and turn-ceiling worst case;
- that MCP tools may have side effects;
- how to revoke the grant.

MCP annotations such as read-only or idempotent are display hints, never the
authorization decision.

### Phase 5 acceptance

- A tool-using evaluation completes through MCP without human interaction after
  confirmation.
- Tool-call checks can assert the name and argument subset.
- Missing/revoked/stale bindings block before the first provider request.
- A timeout or post-call execution failure fails one repetition and later
  repetitions continue; pre-call binding unavailability stops the batch and
  leaves later cells not-run.
- Saved experiment artifacts contain no MCP connection or credential details.
- Reopening results does not reconnect to the MCP server.

## Phase 6 — hardening and deferred capabilities

Prioritize from observed needs:

- list-change notifications and refresh caching;
- reconnection policy and server restart recovery;
- output-schema validation;
- richer structured/image/audio/resource inspection;
- linked raw MCP evidence artifact with retention and size bounds;
- parallel tool-call concurrency and cancellation grouping;
- OAuth and secure token storage;
- Tauri host implementation;
- stdio server lifecycle and exact-command consent;
- a declarative server/tool scaffold if repeated user-written MCP boilerplate is
  demonstrated.

Resources, prompts, sampling, and MCP server/export behavior remain separate
features with their own product cases.

## Security model

MCP servers, tool descriptions, schemas, arguments, and results are untrusted.

### Connection security

- Operator declarations are the allowlist.
- The browser never supplies an arbitrary target URL.
- Credentials resolve only in the host and only for the declaration's pinned
  origin.
- HTTPS is required except explicit loopback development declarations.
- Redirects are bounded and may not move credentials to another origin.
- Private/link-local/metadata addresses follow an explicit SSRF policy.
- Connection, call, idle, and shutdown timeouts are distinct.
- Request and response sizes are bounded before parsing large content.
- Error messages and logs pass through the existing redaction policy.

### Tool security

- Discovery never implies attachment.
- Attachment never implies execution grant.
- Interactive execution requires per-call approval.
- Batch execution requires a standing grant plus confirmation disclosure.
- Schema annotations never grant permissions.
- A result cannot grant or modify another capability.
- Arguments shown for approval are the arguments sent.
- A stale fingerprint is visible and blocks unattended execution by default.
- A removed operator declaration revokes all derived bindings immediately.

### Evidence security

- No endpoint, token, authorization header, secret reference, or session value
  enters portable traces or projects.
- Raw MCP evidence is separately bounded and redacted before persistence.
- Tool result content is treated as potentially sensitive user data.
- Diagnostics report redaction counts and categories without retaining removed
  values.

## Verification strategy

Follow `AGENTS.md`: write the regression test first, run it red for the actual
incorrect contract, implement, run the affected browser specs, then run the
full browser suite once for each user-visible slice.

### Pure/core tests

- canonical discovery fingerprint;
- MCP descriptor → `ToolDefinition` mapping;
- explicit executor identity redaction;
- MCP result → normalized outcome mapping;
- text projection for every supported content part;
- n8n provider request structural comparator;
- grant migration and resolution;
- name collision and alias policy;
- no SDK imports in `packages/core`;
- portable serialization contains no local MCP configuration.

### Host tests

- catalog parsing and environment credential lookup;
- origin pinning and redirects;
- SSRF rejection;
- connection/discovery/call timeouts;
- cancellation;
- oversized and malformed responses;
- application error versus JSON-RPC/transport failure;
- authorization and endpoint redaction;
- catalog removal revokes execution;
- process/application shutdown releases clients.

### Browser tests

- deliberate discovery and selective attachment;
- no execution from discovery-only slice;
- changed-definition diff;
- interactive approval, rejection, and focus restoration;
- manual fallback after failure;
- ordinary provider continuation after MCP success;
- exact n8n contract comparison;
- batch preflight and standing-grant disclosure;
- missing/revoked/stale binding refusal with zero provider calls.

### Interoperability tests

- official TypeScript client against the Python reference server;
- Inference Lens against the Python reference server;
- Inference Lens against at least one independently implemented server;
- claimed tool capability subset of the official conformance suite;
- explicit expected failures for unsupported MCP capabilities;
- home n8n contract capture after each intentionally supported n8n upgrade.

## Home n8n operating procedure

The home server is a reference system, not an automated CI dependency.

1. Create a disposable project containing only contract workflows.
2. Use synthetic values and dedicated test credentials.
3. Keep workflows inactive except while manually capturing a scenario.
4. Point the OpenAI Chat Model credential at the controlled capture provider.
5. If n8n runs in Docker, expose the fixture only on the minimum test-safe
   interface and remove that exposure afterward.
6. Record workflow and execution IDs only in `.n8n-contract-staging/`.
7. Capture the execution immediately, before editing or upgrading nodes.
8. Inspect staged provider requests and execution data manually.
9. Run the deterministic redactor into a versioned fixture directory.
10. Run secret scans and fixture contract tests.
11. Stop the capture provider and remove temporary tunnels or credentials.

Do not capture work n8n data into this repository. A later work-server check
should use the same synthetic workflow and organizational approval appropriate
to that environment.

## Delivery sequence

Each slice should be independently reviewable and usable as evidence for the
next.

| Slice | Current status | Deliverable / gate |
| --- | --- | --- |
| N0 | Eleven captures committed | Scripted n8n provider evidence; empty-output still lacks a capture. |
| M1 | Accepted | SDK/protocol and host/security decisions recorded. |
| M2 | Implemented | Operator catalog, discovery, diff, and detached attachment. |
| M3 | Local slice accepted; live checks automated | Interactive execution, interruption/manual continuation, server-less trace import, Python protocol lane. |
| N1 | String-input reviewed; expanded harness ready | Review four additional captures, resolve the empty-output reference gap, then decide whether a presentation policy is justified. |
| M4 | Implemented | Shared browser-local grants, live preflight, batch execution and v5 stopped results. |
| M5 | Deferred | Prioritize observed failures and concrete user needs. |

## Decisions required before implementation

The recommendations below are part of this proposed plan but should be
explicitly confirmed before the corresponding contract is coded.

1. **Transport:** Streamable HTTP first; stdio deferred.
2. **Protocol placement:** official TypeScript SDK in the Node host service;
   `packages/core` receives normalized values only.
3. **Configuration:** operator-owned server catalog for the web/self-hosted
   product; no arbitrary browser-configured endpoint in v1.
4. **Authorization:** none or static bearer/header secret from an environment
   reference; OAuth deferred.
5. **Portability:** detached tool snapshots in projects; server profiles and
   bindings remain device-local. No portable MCP server requirement in v1.
6. **Names:** preserve valid unique remote names; require an explicit attached
   alias for invalid/colliding names; never silently rename at run time.
7. **Refresh:** live discovery plus explicit immutable snapshot updates; no
   automatic attached-definition mutation.
8. **Consent:** browse, attach, grant, and execute are distinct actions;
   per-call interactive approval and standing batch grants reuse one local
   capability model.
9. **Results:** use existing normalized outcomes and explicit text projection;
   measure n8n result serialization before claiming compatibility.
10. **Compatibility:** add no n8n mode unless captures prove stable material
    differences; any policy is versioned and run-owned.
11. **Shells:** local/self-hosted web first; Tauri explicitly unavailable until
    a later host design is approved.
12. **SDK/builder:** use official MCP SDKs; defer an Inference Lens declarative
    builder until repeated real-server work demonstrates missing ergonomics.

## Stop conditions and reassessment

Pause before the next phase if:

- n8n does not expose a stable provider-wire tool contract for the installed
  versions;
- the selected SDK cannot interoperate with the home/reference server revision;
- host-side Streamable HTTP cannot enforce origin/credential boundaries;
- mapping an MCP schema to `ToolDefinition` would require weakening project
  validation;
- n8n-compatible result serialization would discard or fabricate evidence;
- implementing compatibility would make n8n types part of the run kernel;
- unattended MCP calls cannot be explained and revoked through the existing
  grant/preflight model.

At those points, preserve the capture and spike evidence, revise the contract,
and do not code around the mismatch with ambient flags or unversioned coercion.

## Definition of complete for the initial feature

The initial feature is complete when:

- a user-run Streamable HTTP MCP server can be declared safely;
- selected tools can be discovered and attached as immutable portable
  definitions;
- an interactive model call can be approved, executed over MCP, continued, and
  inspected;
- a tool-using evaluation can run with explicit standing consent;
- projects and traces remain credential- and endpoint-free;
- a captured n8n sub-workflow-tool fixture can be compared against the
  equivalent Inference Lens provider requests;
- the product either matches the captured contract or reports precise,
  versioned differences without making a broader compatibility claim;
- affected and full browser suites pass, alongside core, integration,
  typecheck, lint, build, and relevant host tests;
- remaining shell, transport, auth, and rich-content limitations are visible
  rather than silently degraded.

## Primary references

- Existing executor contract: [`TOOL_EXECUTION.md`](TOOL_EXECUTION.md)
- Existing command host/security pattern: [`COMMAND_TOOLS.md`](COMMAND_TOOLS.md)
- Existing n8n fixture process: [`../tests/fixtures/n8n/README.md`](../tests/fixtures/n8n/README.md)
- Existing provider fixture guidance: [`PROVIDER_FIXTURES.md`](PROVIDER_FIXTURES.md)
- Project portability boundary: [`PROJECT_FORMAT.md`](PROJECT_FORMAT.md)
- Run evidence boundary: [`RUN_TRACE_FORMAT.md`](RUN_TRACE_FORMAT.md)
- n8n Call n8n Workflow Tool documentation:
  <https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolworkflow/>
- n8n Tool Workflow implementation:
  <https://github.com/n8n-io/n8n/blob/master/packages/@n8n/nodes-langchain/nodes/tools/ToolWorkflow/v2/ToolWorkflowV2.node.ts>
- Official MCP TypeScript SDK:
  <https://github.com/modelcontextprotocol/typescript-sdk>
- Official MCP Python SDK:
  <https://github.com/modelcontextprotocol/python-sdk>
- MCP specification:
  <https://modelcontextprotocol.io/specification/>
- MCP conformance project:
  <https://github.com/modelcontextprotocol/conformance>
