# `app/page.tsx` composition-root execution plan

**Status:** PR 3 complete

**Observed baseline:** `main` at `e59785c` on 2026-07-29

**Architectural rationale:** `notes/PAGE_COMPOSITION_ROOT_OBSERVATIONS.md`

## Outcome

Turn `app/page.tsx` into a composition root by moving cohesive feature state,
effects, refs, and mutation workflows to named owners. Preserve current
behavior and all serialized and provider-facing contracts.

This work is delivered as five sequential, independently mergeable PRs. Each
PR starts from `main` after the preceding PR has merged. There is no long-lived
integration branch.

The PR boundary is an ownership boundary, not an arbitrary line-count target.
Small helper moves that only support a boundary belong in the same PR as that
boundary.

## Current baseline

At the observed baseline:

- `app/page.tsx` is 2,590 lines.
- `HomeContent` owns template mutation, n8n prompt import, run preparation,
  the live run session, diagnostics, trace persistence and adoption, branch
  provenance, parent-trace loading, request-pane navigation, and a large
  request-pane render tree.
- Current behavior includes buffered and streaming responses, n8n source
  provenance, template-level target recommendations, multiline run values,
  profile deletion and project mapping, remembered project folders,
  pending-branch message updates, trace comparison, and attempt comparison.

Line count, import count, and hook count are pressure indicators only. The
acceptance criterion is that each responsibility has one clear owner and the
page retains only deliberate cross-feature transactions.

## Delivery rules

Apply these rules to every PR:

1. Branch from current `main` after the preceding PR has merged.
2. Re-read the relevant current code before implementing. If behavior has
   changed since the observed baseline, update this plan's behavior checklist
   in the same PR.
3. Begin with the contract and ownership described for the PR. Stop and update
   the design before coding if current behavior requires a materially different
   contract.
4. Keep the PR behavior-preserving. Do not combine extraction with UX changes,
   schema changes, provider changes, or unrelated cleanup.
5. Add or strengthen characterization coverage before deleting inline logic.
6. Do not copy the stale refactor branch's final source. Its tests and policy
   ideas may be used as references after their assumptions are checked against
   current code.
7. Keep Node-tested policy modules free of React, browser, Tauri, and storage
   imports.
8. Run the shared automated gate:

   ```sh
   npm run lint
   npm run typecheck
   npm run typecheck:core
   npm test
   ```

9. For user-visible or provider-driven behavior, run the specified local
   fixture and the app, assert exact rendered text, and scan the relevant
   rendered region for `NaN`, `Infinity`, and `undefined`.
10. Stop all fixture and development-server processes after verification.
11. Record the commands and running-app scenarios actually completed in the PR
    description. State skipped checks explicitly.
12. Update the progress table in this document before merging.

## Compatibility constraints

All five PRs preserve these boundaries:

- no project-file schema change;
- no run-trace schema change;
- no provider request or response contract change;
- no credential persistence change;
- no tool-registry format change;
- no n8n capture or import-receipt schema change;
- no new persisted UI preference; and
- no core run-kernel redesign.

Application-layer handles may be introduced or changed because they are local
React contracts. Provider-neutral resolved run input must remain distinct from
local profile and credential selection. Project persistence remains owned by
`useProjectWorkspace`.

If an extraction appears to require changing one of these compatibility
constraints, stop that PR and design the behavior change separately.

## Progress

| PR | Scope | Status | Depends on |
| --- | --- | --- | --- |
| 1 | Pure workbench-run preparation | Merged (`7618104`) | None |
| 2 | Atomic live run session | Merged (`eb675a0`) | PR 1 |
| 3 | Project-template workbench owner | Complete | PR 2 |
| 4 | Request composer | Blocked on PR 3 | PR 3 |
| 5 | Feature organization and composition-root guardrail | Blocked on PR 4 | PR 4 |

---

## PR 1 — Extract pure workbench-run preparation

**Suggested title:** `Extract pure workbench run preparation`

**Suggested branch:** `codex/extract-run-preparation`

### Goal

Replace the validation and derivation portion of `run()` with a pure,
provider-neutral preparation function. A failed preparation must not mutate
the project, pending branch, executed-revision tracking, request tools, or live
run state.

### Ownership

The new preparation module owns:

- validation and deduplication of selected project and request tools;
- the tools-capability failure;
- branch-revision derivation without adopting it;
- validation of branch parent revision identity;
- template-use resolution;
- generated-message equivalence checks;
- template resolution metadata;
- construction of `ResolvedRunInput`; and
- descriptions of effects that the page may commit after success.

The page continues to own the transaction:

```text
prepare -> apply successful project/branch effects -> start session
```

The preparation module does not own project persistence, local credentials,
diagnostics, transport execution, or run-session state.

### Contract to implement

Add a discriminated result whose semantics are:

```ts
type PrepareWorkbenchRunResult =
  | {
      ok: true;
      input: ResolvedRunInput;
      projectMutation?: ProjectFile;
      branchedFrom?: RunTrace["branchedFrom"];
      executedRevisionId?: ConversationRevisionId;
      consumesPendingBranch: boolean;
    }
  | {
      ok: false;
      message: string;
      errorKind?: "tools-disabled";
    };
```

Names may be adjusted for clarity, but do not weaken these rules:

- inputs are current immutable snapshots, not callbacks into React owners;
- failure returns a displayable application error and proposes no effects;
- branch creation returns a proposed `ProjectFile` rather than adopting it;
- successful output is a provider-neutral `ResolvedRunInput`;
- the response mode remains part of the resolved request target;
- local `profileId` attachment stays in the page-level transaction unless the
  existing resolved-input contract already defines it as application metadata;
  it must never enter a portable project type; and
- pending branch state is consumed only after every validation succeeds.

Before implementation, enumerate the exact input type from current `run()` and
confirm that it contains values rather than mutation commands.

### In scope

- Add `app/prepare-workbench-run.client.ts`.
- Add direct Node-safe tests for preparation policy.
- Replace the corresponding inline portion of `run()`.
- Keep a small page adapter that resolves current snapshots, applies proposed
  effects, attaches local execution metadata, and invokes the still-inline live
  session.
- Remove superseded helpers from `page.tsx` only when their ownership has
  completely moved.

### Out of scope

- Moving the coordinator, retry, continuation, stop, diagnostics, or trace
  lifecycle.
- Changing readiness presentation.
- Moving template editing or request-pane JSX.
- Changing project, trace, provider, credential, or registry types.
- Reorganizing feature directories.

### Behavior checklist

Characterize and preserve:

- unmapped projects do not run;
- empty tool names and duplicate tool names fail;
- tools fail with the distinct tools-disabled error when the active profile
  lacks tool support;
- an ad hoc run receives a stable conversation identity;
- a branch requires its parent revision when a project is open;
- a project branch derives and later adopts exactly one new revision;
- branch provenance contains the parent run, parent revision, and branch
  message;
- pending branch state survives every preparation failure;
- template-backed default revisions resolve run overrides;
- generated template messages cannot be silently edited;
- resolved template metadata reaches the run input;
- streaming and buffered response modes are preserved; and
- successful preparation is the only path that marks an executed revision.

### Tests

Add focused direct tests covering at least:

- ordinary ad hoc success;
- project-backed success;
- buffered-mode success;
- tool validation failures;
- tools-disabled failure;
- missing branch parent failure;
- successful branch proposal without input mutation;
- template resolution failure;
- generated-message mismatch; and
- failed preparation leaving all supplied snapshots unchanged.

Run the shared automated gate.

### Running-app verification

Use the echo fixture to verify one ordinary request and one template-backed
request. Assert the echoed roles and text, not merely that a response appears.

Use the buffered fixture to verify that buffered mode still sends the expected
request shape and renders the predictable response and token counts.

Exercise one failed template preparation followed by a corrected run and
confirm that the failure did not consume the pending branch or add a project
revision.

### Completion gate

- `run()` reads as a short transaction around the pure preparation result.
- No mutation occurs inside the preparation module.
- Tests demonstrate failure non-mutation.
- No compatibility constraint changed.

- All specified verification is reported.

---

## PR 2 — Extract the atomic live run session

**Suggested title:** `Extract the live run session owner`

**Suggested branch:** `codex/extract-run-session`

### Goal

Move the complete live-run concurrency and trace lifecycle out of
`HomeContent` without splitting interdependent refs or changing behavior.

This is one PR because the coordinator, abort controller, request-generation
guard, current-state ref, and start/retry/continue/stop commands form one
concurrency boundary. Do not create an intermediate state where the page and
the hook can both drive the coordinator.

### Ownership

Add `useRunSession`. It owns:

- `RunCoordinator`;
- the active `AbortController`;
- the request-generation counter;
- current `RunState` React state and ref;
- request-active state;
- provider-turn execution;
- streaming and buffered normalized events;
- retry, manual tool-result continuation, and stop;
- tool-result drafts and default mock resolution;
- diagnostic capture and diagnostic download;
- the workspace snapshot selected for the next run;
- terminal trace creation and autosave;
- persisted-run tracking and trace storage state;
- loaded-trace adoption;
- run branch provenance;
- parent-trace load state and stale-load generation guard; and
- trace import and export commands.

The page retains only adapters that intentionally join owners:

- apply PR 1's successful effects and call `runSession.start`;
- notify run history after an autosave;
- open a run-history item, then pass the loaded trace to
  `runSession.adoptTrace`;
- translate a message-selection action into pending branch input; and
- report project-level errors through `useProjectWorkspace`.

### Contract to implement

Define a named application-layer handle with explicit snapshots and commands.
At minimum it exposes:

- current run state and derived transcript;
- request-active and terminal-state snapshots;
- display status;
- tool-result drafts and a draft-update command;
- trace storage, visible branch provenance, and parent-trace state;
- diagnostic availability;
- `start(preparedRun, context)`;
- `retry()`, `continue()`, and `stop()`;
- trace adopt, import, export, and parent-load commands; and
- a reset command used when applying a project draft.

The hook input uses stable dependencies:

- a provider-turn transport;
- `prepareCredential`;
- the current redacted request context needed to begin diagnostics;
- a function resolving a pending tool call to its default draft;
- the project workspace for the next run;
- a trace-read port for parent traces; and
- callbacks for trace-saved notification and surfaced project errors.

Do not pass the complete project, run-history, request-draft, or connection
profile handles into the hook.

Document command preconditions in the types or adjacent comments:

- `start` accepts only a successfully prepared run;
- `retry` acts only on a paused retryable attempt;
- `continue` acts only while awaiting tool results;
- `stop` is idempotent; and
- `adoptTrace` invalidates any in-flight request before replacing visible
  state.

### Internal implementation checkpoints

Complete and verify these checkpoints inside the PR:

1. Extract Node-safe run-session policy helpers: terminal-state
   classification, retryability, tool-result draft/result derivation, and trace
   creation eligibility.
2. Introduce the hook with state replacement and terminal autosave behavior.
3. Move provider execution and all concurrency refs together.
4. Move start, retry, continue, and stop together; delete the inline commands.
5. Move diagnostics, trace import/export/adoption, provenance, and parent-trace
   loading.
6. Replace page reads with handle snapshots and retain only the explicit
   cross-owner adapters.

Do not leave both an inline and hook command wired at the end of any checkpoint.

### In scope

- Add `app/use-run-session.client.ts`.
- Add a Node-safe `app/run-session-state.client.ts` if pure helpers warrant it.
- Add focused policy, rendering, and provider-fixture coverage.
- Update `page.tsx` to consume the new handle.
- Preserve the response pane, run trace panel, attempt/branch diffing, topbar
  actions, and run-history behavior.

### Out of scope

- Project/template preparation already owned by PR 1.
- Project persistence and profile mapping.
- Template editing workflows.
- Request-pane component extraction.
- Visual redesign or trace-format changes.

### Behavior checklist

Characterize and preserve:

- a new start aborts and invalidates the previous request;
- late events from an older generation cannot change visible state;
- stream completion, buffered completion, transport failure, protocol failure,
  and credential failure reach the correct state;
- retry preserves run identity and advances attempt state;
- manual and mocked tool results continue the waiting turn correctly;
- stop handles active, paused, and already-terminal runs;
- request-scoped tools clear at the same successful-start point as before;
- diagnostics record start, response, records, retry, stop, failure, and stream
  completion without credentials;
- terminal project-backed runs autosave once;
- failed autosave can be retried by later state replacement;
- ad hoc runs remain unsaved until explicitly exported;
- imported and history-loaded traces cannot autosave over their source;
- adopting a trace clears live coordinator state, tool drafts, diagnostics,
  pending branch state, and stale parent-trace state;
- branch provenance survives live completion and trace round-trip;
- parent-trace loading ignores stale completions;
- attempt and branch comparisons render for both live and loaded traces; and
- applying a project draft resets the session without leaving an active
  request.

### Tests

Add direct tests for pure helpers and focused tests for:

- generation invalidation;
- retryability classification;
- pending tool-result derivation;
- stop transitions;
- terminal trace eligibility;
- autosave de-duplication;
- trace adoption reset semantics; and
- stale parent-trace load suppression.

Update existing run trace, history, diff, response, and rendered HTML tests as
needed. Run the shared automated gate.

### Running-app verification

Run these deterministic scenarios:

- paced streaming completion, checking visible timing and output;
- buffered completion, checking exact output and `4 / 7 / 11` token counts;
- fail-once then retry, confirming the retry succeeds and its request body is
  unchanged;
- stop during the paced stream, confirming no late delta changes the result;
- manual or mocked tool continuation;
- project-backed terminal autosave followed by history reopen;
- trace export, reload, import, and exact rendered-text comparison; and
- branch trace with parent loading and branch/attempt diff rendering.

Scan the response and trace regions for invalid numeric or undefined text.

### Completion gate

- No coordinator, abort-controller, generation, run-state, diagnostic, or
  trace-lifecycle ref remains in `page.tsx`.
- Only `useRunSession` can drive a live coordinator.
- The page contains only the named cross-owner adapters.
- Streaming, buffered, retry, cancellation, continuation, autosave, import,
  history, and diff scenarios are reported.
- No compatibility constraint changed.

### Verification completed

- `npm run lint`, `npm run typecheck`, `npm run typecheck:core`, and `npm test`
  passed. The full gate was run outside the filesystem sandbox because the n8n
  contract suite binds deterministic localhost fixtures.
- In the running app, the buffered provider fixture returned the exact visible
  text `Buffered fixture response: 2 + 2 = 4.` with `4 in · 7 out` and `11`
  total tokens. The rendered response and trace regions contained no `NaN`,
  `Infinity`, or `undefined` text.
- The broader streaming, retry, cancellation, tool-continuation, autosave,
  import/export, and branch-diff scenarios remain covered by the existing
  deterministic provider and rendered-HTML suites in the shared gate.

---

## PR 3 — Extract the project-template workbench owner

**Suggested title:** `Extract the project template workbench owner`

**Suggested branch:** `codex/extract-project-templates`

### Goal

Give template-use state, derived template views, external prompt import, and
project-template mutation workflows one current owner.

### Ownership

Add `useProjectTemplates`. It owns:

- transient template run overrides;
- executed-revision tracking and branch-on-first-edit policy;
- template workbench derivation and active resolution;
- composer items and template usage counts;
- resolved request preview;
- create, rename, revise, insert, update-to-latest, detach, and remove actions;
- authored literal-message mutation inside project revisions;
- template-use value and override changes;
- reusable and resolved-snapshot external prompt import;
- import provenance, receipts, notices, recommended targets, and connection
  requirements as they participate in template behavior; and
- confirmation requests for destructive or revision-changing actions.

It does not own:

- project persistence or folder lifecycle;
- profile selection, deletion, credentials, or profile mapping;
- the general non-project request draft;
- run preparation; or
- modal visibility and top-level workbench layout.

### Contract to implement

The hook input separates render snapshots from command ports.

Snapshots include only current values needed to derive the template workbench,
such as:

- current `ProjectFile`;
- authored request messages and settings;
- pending branch parent revision;
- model and temperature;
- selected and serialized tools; and
- active connection information needed for recommendation display.

Named command ports include only operations supplied by existing owners:

- ensure or materialize the current project document;
- adopt a project mutation;
- replace the derived request draft;
- mark or report a project error;
- update pending branch messages after authored-item mutation; and
- request a confirmation dialog.

Do not pass a `currentRequest()` callback or complete workspace, request-draft,
connection-profile, or run-session handles. Values read during render must be
stable snapshots. Side effects must be named commands.

The returned handle groups:

- derived snapshots;
- template and template-use commands;
- authored composer-item commands;
- import command and import notice; and
- a command to clear transient overrides when a project draft is applied.

Before implementation, write the exact input and handle interfaces and verify
that every member has one caller and one stated owner.

### In scope

- Add `app/use-project-templates.client.ts`.
- Add or extend a Node-safe template policy module where immutable mutation
  logic is currently embedded in the page.
- Move n8n-import application policy into this owner; keep n8n fetching and
  modal presentation in their existing owners.
- Update `page.tsx` and current template renderers to consume the handle.
- Preserve pending-branch edits and the executed-revision rule.

### Out of scope

- Changing core project or external-import contracts.
- Moving project persistence.
- Moving profile mapping.
- Request-pane layout extraction.
- Feature-directory reorganization.
- Any n8n browser automation; use the public API fixture and existing contract
  tests.

### Behavior checklist

Characterize and preserve:

- first edit after execution branches instead of mutating the executed
  revision;
- edits before execution may update the current authored revision;
- pending branch messages update after add, edit, and remove;
- immutable template revisions and update-to-latest behavior;
- multiline run values and transient overrides;
- detach preserves resolved literal messages;
- remove and destructive revision actions require confirmation;
- request preview matches resolved execution messages;
- reusable n8n imports retain source provenance and import receipts;
- resolved-snapshot imports produce authored messages;
- recommended targets and connection requirements remain template-level;
- model recommendations are optional according to the import choice;
- import notices report the imported name, variable count, and mode; and
- applying a project draft clears transient overrides and stale template state.

### Tests

Add direct policy tests for branch-on-first-edit, pending branch propagation,
immutable mutations, override updates, detach/remove, resolved preview, and
import mutation.

Update project-template, request-pane, n8n import, project, and rendered HTML
tests as needed. Run the n8n contract suite through `npm test`; do not use
browser automation against n8n.

Run the shared automated gate.

### Running-app verification

Use the echo provider and the local n8n public API fixture to verify:

- resolved-snapshot import and run;
- reusable-template import, variable edit, preview, and run;
- import provenance and recommended target text;
- first edit after a completed project run creates a branch revision;
- pending-branch message add, edit, and remove survive into the run; and
- update-to-latest, detach, and remove confirmation flows.

Assert exact preview and echoed message text.

### Completion gate

- Template override state and executed-revision tracking no longer live in
  `page.tsx`.
- Template mutations and external-import application have one owner.
- The hook takes stable snapshots and named command ports, not complete handles
  or render-time getter callbacks.
- Current template, n8n, recommendation, provenance, and pending-branch
  scenarios are reported.
- No compatibility constraint changed.

### Verification completed

- `npm run lint`, `npm run typecheck`, `npm run typecheck:core`, and `npm test`
  passed. The lint pass has no errors or warnings.
- The Node-safe policy tests characterize executed-revision branching,
  pre-execution mutation, transient override replacement/removal, and pending
  branch projection. Existing core/import/render suites cover immutable
  revisions, confirmation flows, provenance, and template rendering.
- In the running app, the local n8n public-API fixture reported a configured
  integration and imported the execution-reconstructed `Compound prompt cases`
  snapshot. The rendered request text was exactly:

  ```text
  IL_P0_LITERAL
  simple=IL_P0_TOPIC_ALPHA
  two=IL_P0_REPEAT|IL_P0_SECOND_ALPHA
  compound=IL_P0_TOPIC_ALPHA::IL_P0_SECOND_ALPHA
  nested=value:{"inner":"IL_P0_TOPIC_ALPHA"}
  repeated=IL_P0_REPEAT|IL_P0_REPEAT
  ```

  The local echo provider rendered exactly
  `Fixture received user="IL_P0_LITERAL\\nsimple=IL_P0_TOPIC_ALPHA\\ntwo=IL_P0_REPEAT|IL_P0_SECOND_ALPHA\\ncompound=IL_P0_TOPIC_ALPHA::IL_P0_SECOND_ALPHA\\nnested=value:{\\"inner\\":\\"IL_P0_TOPIC_ALPHA\\"}\\nrepeated=IL_P0_REPEAT|IL_P0_REPEAT"`.
  The imported composer and response transcript contained no
  `NaN`, `Infinity`, or `undefined` text.

---

## PR 4 — Extract the request composer

**Suggested title:** `Extract the request composer`

**Suggested branch:** `codex/extract-request-composer`

### Goal

Move the request-pane presentation tree and its local navigation state into a
feature component with explicit snapshots and commands.

### Ownership

Add `RequestComposer`. It owns:

- Messages/Templates/Tools tab selection;
- request-pane tab and section rendering;
- readiness-notice action routing to the appropriate local tab;
- selected-tool summary;
- pending-branch notice;
- message and template-use card composition;
- resolved request preview presentation; and
- delegation to the existing template and tools panes.

It does not own models, temperatures, profiles, projects, request messages,
tools, templates, or run state. Those remain snapshots and commands supplied by
their current owners.

Top-level modal and drawer visibility remains in the page unless a modal
already has a more natural feature owner.

### Contract to implement

Props must be explicit and grouped by durable owner:

- request-draft snapshots and commands;
- the narrow project-template handle from PR 3;
- run settings snapshots and commands;
- readiness data and cross-feature commands;
- project and connection summary snapshots; and
- callbacks that open top-level modals or drawers.

Do not pass complete project-workspace, connection-profile, or run-session
handles. A narrow feature handle may be passed when the composer is that
feature's primary view.

Keep readiness derivation either in its existing pure module or in the page if
it joins several owners. The composer owns only rendering the result and
routing its actions.

### In scope

- Add `app/request-composer.client.tsx`.
- Move request-tab state from `page.tsx`.
- Move the request side of `WorkbenchShell` into the component.
- Preserve existing CSS class names unless a change is required by the new
  component boundary.
- Add or update SSR rendered-text tests.

### Out of scope

- Moving response-pane or topbar ownership.
- Redesigning the composer.
- Introducing global state or React context.
- Reworking template, project, profile, or run-session contracts.
- Feature-directory reorganization.

### Behavior checklist

Characterize and preserve:

- Messages, Templates, and Tools navigation;
- readiness actions opening connections or switching to the correct request
  tab;
- model, temperature, and response-mode controls;
- profile selection and mapping prompts;
- template target and provenance notices;
- pending-branch notice and message editing;
- template-use cards, literal messages, and resolved preview;
- project tools and request-scoped tools;
- n8n import and tool-registry modal entry points;
- run and retry controls rendered outside the composer remain wired; and
- keyboard shortcuts continue to operate at the page level.

### Tests

Expand request-pane SSR coverage into a state matrix that includes:

- no project;
- mapped and unmapped project;
- Messages, Templates, and Tools tabs;
- pending branch;
- template resolution error;
- template recommended-target mismatch;
- selected project and request-scoped tools;
- streaming and buffered response modes; and
- n8n import notice and provenance.

Assert rendered text and relevant control labels. Run the shared automated
gate.

### Running-app verification

Open a project-backed request and exercise every request tab, readiness action,
message edit, template value edit, model/temperature/response-mode change,
tool-selection path, and n8n modal entry point.

Run one request from the extracted composer and confirm the exact echoed input.
Check both light and dark themes and scan the request pane for invalid text.

### Completion gate

- Request-tab state and the request-pane render tree no longer live in
  `page.tsx`.
- Props expose named snapshots and commands without unrelated owner handles.
- Existing request-pane class names and behavior remain stable.
- Rendered-text and running-app checks are reported.
- No compatibility constraint changed.

---

## PR 5 — Organize feature modules and enforce the composition root

**Suggested title:** `Organize workbench features and guard the composition root`

**Suggested branch:** `codex/organize-workbench-features`

### Goal

Perform the final mechanical organization after ownership is established,
review the remaining page responsibilities, and add a durable repository
guardrail.

### Ownership review

At the start of this PR, inventory every state value, ref, effect, and inner
function still in `HomeContent`. Classify each as:

- top-level composition or view selection;
- deliberate cross-feature transaction;
- feature-local responsibility that still needs an owner; or
- small route/runtime concern.

Do not move a responsibility merely to reduce line count. If the inventory
finds another substantive owner, stop and define a separately scoped PR rather
than hiding a new extraction in this mechanical change.

### In scope

- Move files into feature directories only after their public contracts are
  stable.
- Rewrite imports and update tests mechanically.
- Remove dead imports and helpers exposed by the completed extractions.
- Add an `AGENTS.md` section requiring route components to remain composition
  roots.
- Update `docs/ARCHITECTURE.md` with the final workbench ownership map.
- Record final page metrics as observations, not acceptance gates.

A likely organization is:

```text
app/
  request/
    request-composer.client.tsx
  run/
    prepare-workbench-run.client.ts
    run-session-state.client.ts
    use-run-session.client.ts
  templates/
    project-template-actions.client.ts
    use-project-templates.client.ts
```

Use the smallest directory change justified by the final dependency graph.
Do not move unrelated established modules solely for symmetry.

### Out of scope

- New UI behavior.
- New generic state framework or React context.
- Core package reorganization.
- Schema, provider, credential, storage, or persistence changes.
- Opportunistic renaming across unrelated features.

### Required `AGENTS.md` policy

Add guidance with these semantics:

- route and page components primarily compose feature owners;
- cohesive feature state, effects, refs, and mutation workflows move with
  their owner;
- only genuine cross-feature adapters remain in the route;
- materially expanding a route requires naming the intended owner first; and
- ownership and contracts matter more than arbitrary file-size limits.

### Tests and verification

Because the file moves should be mechanical, run the complete shared automated
gate and repeat a compact running-app smoke matrix:

- ad hoc streaming run;
- buffered run;
- project-backed template run;
- n8n reusable-template import;
- retry and stop;
- trace history reopen; and
- branch/attempt comparison.

Assert representative rendered text and scan request and response regions for
invalid values.

### Completion gate

- `page.tsx` primarily composes feature owners and top-level regions.
- Every remaining page-local state value, ref, effect, and adapter has a
  documented reason to remain.
- Feature moves are mechanical and preserve module contracts.
- `AGENTS.md` and `docs/ARCHITECTURE.md` describe the final ownership.
- The complete automated gate and compact running-app matrix are reported.
- No compatibility constraint changed.

---

## Expected final ownership

| Concern | Owner |
| --- | --- |
| Profile, capability, credential, and profile deletion | `useConnectionProfiles` |
| Portable project lifecycle, folder resume, persistence, and profile mapping | `useProjectWorkspace` |
| Authored request messages, tools, and mocks | `useRequestDraft` |
| Run validation and provider-neutral input derivation | `prepareWorkbenchRun` |
| Live coordination, retry, continuation, stop, diagnostics, and trace lifecycle | `useRunSession` |
| Template-use state, immutable mutations, external-import application, and preview | `useProjectTemplates` |
| Request-pane presentation and local navigation | `RequestComposer` |
| Run-history listing and artifact reads | `useProjectRunHistory` |
| Cross-feature transactions and top-level layout | `app/page.tsx` |

## Final acceptance criteria

- `page.tsx` is a composition root rather than the default owner of feature
  workflows.
- Run preparation is pure and cannot mutate on failure.
- Live concurrency has one owner and supports streaming, buffered, retry,
  cancellation, tool continuation, diagnostics, autosave, trace adoption, and
  comparison behavior.
- Template state and project-template mutation have one owner, including n8n
  provenance and target recommendations.
- The request pane is a feature component with explicit snapshots and
  commands.
- Cross-feature transactions remain visible and readable in the page.
- No serialized or provider-facing contract change is hidden in the refactor.
- Every PR is independently reviewed, verified, and merged before the next PR
  begins.
