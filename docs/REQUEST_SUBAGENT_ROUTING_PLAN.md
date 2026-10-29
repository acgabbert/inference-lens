# Request-backed sub-agent routing

**Status:** Proposal for review; no runtime implementation or contract approval.
**Date:** 2026-10-27. **Inspected baseline:** `main` at `406cb03`.
**Sequencing (2026-10-29):** [prompt environments](PROMPT_ENVIRONMENTS_PLAN.md)
land first and supply the child input layer; see the revised Input row below.

## Outcome and effort

Let a parent request expose a named specialist, execute another saved request
when the parent selects that specialist, return the child's answer as a tool
result, and continue the parent. Each invocation creates an independent child
run whose input, output, target, usage, and failure evidence remain inspectable.

Working interpretation: "tools are optional" means tools **inside the child**
are optional. The recommended parent routing mechanism is an ordinary model
tool call. This interpretation is still proposed: a manual "answer this pending
call with another request" flow is a viable smaller alternative. Neither path
requires an MCP server, a new provider protocol, or actual agent processes.

This is a medium feature, not just another executor switch case. The existing
executor and provider-turn seams make execution approachable; reproducible
configuration, nested evidence, UI ownership, and bounded continuation are most
of the work.

Estimates below are engineering days for one developer familiar with this repo,
including tests and review fixes, assuming the proposed contracts are accepted.
They are code-inspection estimates, not measurements from a completed spike.

| Scope | Estimate | Deliverable / limitation |
| --- | --- | --- |
| Proof of concept | 1–2 days | One configured child, one parent tool call, child text returned to parent; demonstrates transport reuse, not a shippable history/authoring feature. |
| Recommended interactive MVP | 5–8 days total | Saved configuration, automatic routing, one child level, separate targets, bounded execution, cancellation, inspectable/exportable child traces, and browser coverage. Includes the spike work. |
| Batch, evaluation, and CLI execution | +2–4 days | Immutable child snapshots, target-aware credentials/scheduling, shared budgets, checks and summaries; do not silently enable these in the MVP. |
| Tools inside a child | +2–4 days for a restricted implementation | Existing mock/command/MCP executors with standing grants and bounded child turns. Interactive nested approval UI adds more work. Overlaps batch work; re-estimate together. |
| Arbitrary recursive agents, concurrent fan-out, shared memory | Separate design | Not included in any estimate above. |

Recommend shipping the 5–8 day interactive slice first. A usable version with
batch/CLI support is roughly 7–12 engineering days. Include child tools only if
the spike shows a small addition (at most about one day) without new
approval UI or scheduler behavior; otherwise keep the MVP tool-free.

## Existing seams and missing pieces

| Owner / evidence | Reuse | Gap |
| --- | --- | --- |
| [`tool-execution.ts`](../packages/core/src/tool-execution.ts) | `ToolExecutor.execute`, normalized outcomes, abort signal, execution recorder. | Only mock/command/MCP binding kinds; no child-run evidence contract. Runtime currently carries only a signal. |
| [`run-kernel/types.ts`](../packages/core/src/run-kernel/types.ts) | Provider-neutral tools, calls/results, `ResolvedRunInput`, execution records. | No delegation configuration or parent-execution/child-run relationship. |
| [`provider-turn-driver.ts`](../packages/runner/src/provider-turn-driver.ts) | Drive a fresh `RunCoordinator` through any supported chat transport; report child state. | It drives one turn, not a bounded child workflow or parent scheduler. |
| [`project.ts`](../packages/core/src/project.ts) | Immutable conversation revisions, pinned prompt uses, connection requirements, target/options and variable resolution. | A conversation revision owns content only; model/options/tools live elsewhere. A prompt's recommended target is advisory, not an executable request configuration. |
| [`use-run-session.client.ts`](../app/run/use-run-session.client.ts) and [`run-session-state.client.ts`](../app/run/run-session-state.client.ts) | Parent pending-call handling, manual replacement, execution and continuation. | One live session; automatic execution/approval handling is currently MCP-specific. A child must not replace the parent's active Compose session. |
| [`chat-cell-executor.ts`](../packages/runner/src/chat-cell-executor.ts) | Bounded tool loop, terminal failure handling, resource locks. | Coupled to experiment plans and parent-cell credentials; cannot be recursively instantiated unchanged for another target. |
| [`run-trace.ts`](../packages/core/src/run-trace.ts), [`run-metrics.ts`](../packages/core/src/run-metrics.ts) | Event replay, validation, per-run evidence and usage. | Flat traces; parent usage does not include child requests. |
| App and [CLI executor factories](../packages/cli/src/tool-executor.ts) | Host-specific execution stays outside pure core. | Both factories need injected child-run services, not embedded React or service calls in core. |

Current formats: active Project v15, RunTrace v8, ExperimentPlan v5, and
ExperimentResult v6. [`shared-project.ts`](../packages/core/src/shared-project.ts)
also defines a **staged** shared format that app/CLI do not yet use, renumbered
to v17 on 2026-10-29 when [prompt environments](PROMPT_ENVIRONMENTS_PLAN.md)
took active v16 and RunTrace v9. Coordinate schema allocation with that
migration, environments, and the
[final-output tool plan](N8N_FINAL_OUTPUT_TOOL_PLAN.md); neither is a dependency
that this feature should accidentally turn on.

## Decisions to review before implementation

These recommendations are intentionally reviewable alternatives, not approved
contracts. Per [AGENTS.md](../AGENTS.md), resolve the material choices before
changing types or runtime behavior. Writing and committing this proposal does
not require selecting them now.

| Decision | Options and tradeoff | Recommendation |
| --- | --- | --- |
| Routing | Manual dispatch is smaller but cannot emulate autonomous selection; model tool calls reproduce the parent/child loop; parsing routing instructions from text introduces another protocol. | Ordinary tool calls, with explicit local permission to run automatically. Retain manual result replacement. |
| Child source | A saved prompt is convenient but has no complete execution contract; a saved conversation revision preserves messages and pinned prompt uses; a new general-purpose agent entity is broader. | A project-owned request-tool definition pins a conversation revision and supplies target/options. Offer creation from a saved chat prompt by materializing a pinned template-use conversation. |
| Input | One text argument is easy to author and inspect but cannot drive what the child's prompt says; arbitrary JSON-path mapping adds validation and UI. | **Revised 2026-10-29; depends on [prompt environments](PROMPT_ENVIRONMENTS_PLAN.md).** Child template variables render against the parent's environment snapshot by name. Tool arguments are a further layer, each bound explicitly to a named child variable; the input schema is derived from those bindings (string properties, no extra properties). An optional free-text `input` may still be appended as a user message. Bound values are inserted literally and never re-templated. |
| Context | Inheriting the parent transcript is convenient but creates hidden context and size growth. | Fresh child context on every invocation; only pinned child content, the snapshotted environment, and bound arguments cross the boundary. |
| Targets | Inheriting the parent model is simpler but prevents specialist comparisons; explicit child targets require mapping each connection. | Explicit child `ExecutionTarget` and inference options, initially copied from the current selection for convenience; freeze them at parent start. |
| Result | Final text is directly usable; JSON extraction, transcript forwarding and structured decisions require additional semantics. | Return the completed child's final assistant text exactly. Exclude reasoning, intermediate messages and raw transport material. |
| Scope | One-level chat requests are bounded; decision requests and recursive routing need new contracts. | Chat parent and child only; serial child invocations; no child tools, recursion, shared memory, or cross-project sources in MVP. |
| Failures | An error tool result lets the parent improvise, but claims that an executor produced an answer. | Preserve current execution-failure semantics: no fabricated result; parent pauses for explicit retry/manual replacement. Cancellation cancels both runs. |
| Evidence storage | Linked child files are smaller per artifact but complicate export, missing files and partial writes; embedding grows the parent trace. | Embed bounded child traces with explicit links in the parent trace for MVP. Keep child inspection separate in the UI. |
| Rollout | Enabling all surfaces increases initial work; an interactive slice is useful if unsupported runners refuse it explicitly. | Interactive first; preflight-block batch/CLI execution of request-backed tools until the follow-up lands. |

## Proposed ownership and contracts

### Authored data and preparation

Add a pure core owner such as `packages/core/src/request-tool.ts`. Proposed
`RequestToolDefinition` fields are a stable ID, associated `toolId`, pinned
`conversationRevisionId`, explicit `ExecutionTarget`, inference options,
response mode, and execution limits. The existing `ToolDefinition` continues
to own the model-visible name, description and input schema. The request-tool
definition is project-authored execution intent; it is not a device-local
credential/grant and should not be hidden in `providerOptions` or registry data.

Use a project collection for reusable definitions; snapshot the selected
definition and its resolved content in every prepared parent run. Changing a
definition or prompt revision affects future preparations only. Template edits
never retarget an in-flight parent. Deletion/reference checks must cover these
new uses, and archived prompt revisions must remain resolvable for existing
pins. The tool registry remains a descriptor library; copying a descriptor
alone must not imply copying an executable child configuration.

Preparation produces a serializable `ResolvedRequestTool` snapshot: descriptor,
source identifiers, resolved base messages and template provenance, explicit
target/capability snapshot, options, response mode, and limits. Each invocation
adds the validated input message and creates fresh run/message IDs. No lookup
of "latest revision" occurs at call time. Preview shows the actual child base
request and the appended input convention.

Preflight all selected child targets, capabilities, variables and local mappings
before sending the parent request. Reject source conversations with unresolved
tool calls/results. Enforce the child's no-tools policy on the effective request,
including provider-specific overrides, rather than only hiding a tool picker.

Local connection/profile mapping, credentials, and automatic-run consent remain
runtime inputs. Derive a `kind: "request"` binding from the prepared definition
and runtime mapping. Extend the executor identity and result-resolution switches
explicitly; keep provenance as a live execution with a separate child link.
Do not serialize credentials, grants, or closures in snapshots.

Resolve collisions explicitly: one selected execution source per exposed tool.
A request-backed tool must not silently lose to a stale MCP/command grant or an
enabled mock under today's binding precedence. Show the selected source before
execution; reject ambiguous configuration rather than silently choosing.

### Shared execution

Add `packages/runner/src/request-tool-executor.ts`, depending on pure core types
and injected transport, credential resolution, lifecycle reporting, and limits.
It creates a fresh child coordinator and calls the shared provider-turn driver.
It does not call the UI's `start()` or manufacture an experiment cell.

The ordinary provider-facing sequence remains:

```text
parent request → delegate_review({input})
  → child request with its own model and pinned content → final child text
  → tool result under the original parent call ID
  → parent continuation → final parent answer
```

With one child invocation and no retries this is three provider requests, not
two. Two child calls in the same parent turn followed by one parent continuation
require four. Keep
each provider's existing continuation material attached to its own run; an
Anthropic child and a Chat Completions parent need no shared wire format.

Extend the executor context deliberately to carry parent run/execution identity
and report child progress/evidence. The current signal-only runtime and
`ToolExecutionOutcome` cannot carry that relationship alone. Settle exact types
and event fields in the contract slice; do not smuggle traces into tool-result
text or generic failure details. Bind links to an execution attempt, not only
to a tool call, so retrying a child preserves both attempts.

For MVP, children make one provider turn and expose no tools. Unexpected child
tool calls, malformed input, missing final text, transport failure, timeout,
and nonterminal stream completion produce classified failures and retain the
child evidence. Reject empty/whitespace-only final text explicitly. A model's
ordinary textual refusal is still text, not an infrastructure failure. Drain
the transport before accepting success so trailing usage is retained.

Proposed default bounds, to settle with the contract: five parent turns, eight
child invocations across the parent run, one active child, and a 120-second
deadline per child. Count failed attempts toward invocation/request budgets;
no automatic child retry in MVP. Set concrete input/output/trace byte limits
using existing repository conventions before implementation. Reject over-limit
input before sending; never silently truncate a child result or persist a trace
claiming complete evidence after dropping children.

Stop and supersede must abort child transport and prevent late completion from
supplying a parent result. A completed sibling is not rerun when a later child
fails. Subsequent manual replacement is recorded as manual, retaining the failed
child attempt. Final-result checks still evaluate the parent's answer by
default; descendant checks are a later explicit feature.

### Feature owners and user experience

A request-tool editor under `app/tools/` owns selection of source, target,
options, input preview and validation. A child-execution owner under `app/run/`
owns child state/progress and supplies services to `useRunSession`. The route
composes these owners and cross-feature adapters; it does not gain another
coordinator, execution loop, or persistence effect.

The user can attach "Review" to a parent, select its saved child request and
model, then run. The parent sees its name/description/schema and chooses it.
The response view shows "Review running", the child's target, and expandable
child request/response evidence. The parent resumes after success. On failure,
show what failed and allow retry or a manual result without replacing Compose.

Automatic child execution needs an explicit local setting covering the displayed
definition/target and limits. Imported project content does not grant consent.
Generalize the current MCP-only automatic-continuation trigger carefully, while
preserving existing command/MCP approval policy. Mixed parent tool calls cannot
bypass another tool's required approval.

### Persistence, inspection, and compatibility

Extend project parsing, serialization and reference validation for authored
definitions. Version the parent resolved input/trace to hold prepared child
snapshots and bounded child traces. Add typed lifecycle/link evidence that
joins `parentRunId`, `toolCallId`, `executionId`, and `childRunId`; validate
identity, completion/result agreement and event-derived projections on import.
Failed and cancelled children remain evidence too. Depth is one, IDs are unique,
and duplicate, dangling, cyclic or inconsistent relationships are invalid.

Save/export the parent and embedded children as one artifact. Reopening needs
neither source prompts nor local credentials, and never reruns children.
Historical parent traces remain inspectable with zero children. Unsupported
new formats must fail explicitly in old readers rather than run as ordinary
unbound tools. Allocate actual format versions after environments and the
staged v17 work; update both the active path and staged compatibility tests as needed.

Show parent-only metrics and an explicitly labelled combined request/token
summary. Do not add child tokens to parent provider usage events, double-count
embedded children in history, sum overlapping wall times, or treat missing
provider usage as zero. Keep per-model usage available; a combined token count
does not imply comparable throughput or a dollar cost estimate.

Branch/adopt keeps ordinary parent tool-call/result messages while preserving
their execution provenance. Historical children are evidence, not runnable
sessions. A new run needs newly prepared configuration and local authorization.
Snapshot child settings in experiment plans when batch support lands, and keep
existing historical check results/metric definitions stable.

## Why child tools are a follow-up unless proven cheap

Mock, command and MCP executors already exist, so the execution loop is reusable.
The surrounding behavior is not free: child bindings must be preflighted,
standing grants respected, time/turn budgets shared, and command/MCP resource
locks shared across parents and children. Nested per-call prompts need a UI
that does not deadlock a parent waiting on its child.

The smallest optional addition allows only already-bound tools with standing
permission, a short child-turn ceiling and no request-backed tools inside the
child. Never inherit the parent's entire tool list or grants implicitly. If a
child needs interactive approval, reject that configuration for this slice.
The spike's inclusion gate requires working cancellation, trace linkage,
permission checks, and a bounded loop through the shared runner; reusing an
executor factory alone is not enough to call it easy.

Batch/CLI support also needs a target-aware scheduler/credential path: today's
cell context supplies the parent's credential and rate-limit policy. A child
target cannot reuse those blindly, bypass connection concurrency limits, or
wait forever for a connection slot held by its paused parent. Release/lease
capacity per provider request, apply 429 policy to the actual child connection,
and propagate root cancellation and budgets. Include that design in the batch
slice before enabling child execution there.

## Delivery sequence

1. **Contracts and bounded spike (1–2 days, included in MVP).** Review the decision
   table. Finalize authored/resolved/runtime types, lifecycle events, numeric
   limits, version/migration rules, permission scope, and exact result selection.
   Prove a child with another target works through the shared transport, including
   cancellation and usage drain. Decide whether child tools meet the inclusion
   gate. No UI contract should depend on a disposable spike implementation.
2. **Core and runner (about 2 days).** Add preflight, snapshots, request executor,
   attempt-linked evidence and versioned trace round trips. Block unsupported
   runner surfaces and protect existing binding/approval behavior.
3. **Interactive feature and acceptance (2–4 days).** Add authoring, permission,
   automatic continuation, child inspection, save/export/reopen, metrics and
   browser coverage. Deliver a complete usable slice rather than a tool result
   whose child evidence disappears when the page closes.
4. **Batch/evaluation/CLI follow-up (+2–4 days).** Snapshot child definitions in
   plans, preflight all targets/bindings, extend scheduling/budgets, integrate
   headless execution and result summaries, and verify parity. Re-estimate if
   child tools are combined with this work.

## Verification and acceptance

Follow [the browser mechanics](../tests/e2e/README.md) and
[provider fixture rules](PROVIDER_FIXTURES.md). Write behavioral regression
coverage before each fix and run it red for the actual wrong value. The initial
behavior can be expressed with today's pending parent tool call: assert the
missing child request/result and the resulting parent state. A missing proposed
API or selector is not evidence of a behavioral failure; report that limitation
if a pre-implementation red case cannot be represented.

Add a committed `tests/e2e/request-subagent-routing.spec.ts` using shared drivers
and fixture lifecycle. The fixture must reject the wrong tool descriptor, child
model/content, inherited parent context, extra child tools, mismatched call ID,
or parent continuation missing the exact child answer. Assert three requests
for the single-child happy path, exact displayed child and parent text, and
separate plus combined usage. A fixture returning a canned parent answer
regardless of the child result proves nothing about routing.

Required coverage:

- Core: input validation, pinned resolution, target isolation, binding collisions,
  source deletion rules, limits, exact final-text extraction, attempt links,
  failure/manual replacement, cancellation and rejection of late results.
- Protocols: current Chat Completions, Responses and Anthropic adapters; at least
  one mixed-provider parent/child pair; streaming usage drain and buffered mode;
  preserve the parent's provider-specific continuation material.
- App/artifacts: create/edit/save configuration, local consent, multiple children
  served serially, parent final answer, child failure/retry, stop, source changes
  during a run, combined usage with missing values, export/import and history
  reopen after source removal. Reject corrupted links and over-limit artifacts.
- Compatibility: old projects/traces retain behavior; staged v17 validation does
  not discard new definitions; batch/CLI fail preflight before network activity
  until supported. After that slice, prove app/CLI evidence and check parity.

Iterate with the affected spec, then run the full browser suite once before
handing back a user-visible implementation:

```sh
npm run test:e2e -- tests/e2e/request-subagent-routing.spec.ts
npm run lint
npm run typecheck
npm run typecheck:core
npm test
npm run test:e2e
```

Run `npm run build:cli` and relevant headless tests for the CLI slice; run native
checks if native host contracts change. Report deterministic fixture coverage
separately from live-provider and Tauri checks. The user's own review should
focus on whether source/target selection and parent-versus-child evidence are
clear; it complements the browser suite. Fixture tests establish orchestration,
not whether a real model reliably chooses the best specialist. No n8n agent-tool
compatibility claim is included without separate captures.

## Verification of this plan change

Documentation only. Check local Markdown link targets, run `git diff --check`,
and inspect the staged diff. No unit, runtime or browser suite is needed for this
change under AGENTS.md. The implementation commands above are future requirements,
not checks already performed. Effort and optional-tool feasibility remain
estimates until the contract review and spike.
