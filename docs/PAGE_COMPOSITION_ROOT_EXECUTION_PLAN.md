# `app/page.tsx` composition-root execution plan

**Status:** Complete. PR 5 closed the plan on 2026-10-08; the final ownership
map is in `docs/ARCHITECTURE.md`.

**Observed baseline:** `main` at `e59785c` on 2026-07-29

**Architectural rationale:** `notes/PAGE_COMPOSITION_ROOT_OBSERVATIONS.md`

## Outcome

Turn `app/page.tsx` into a composition root by moving cohesive feature state,
effects, refs, and mutation workflows to named owners. Preserve current
behavior and all serialized and provider-facing contracts.

This work is delivered as sequential, independently mergeable PRs: the five
originally planned, plus PRs 5a–5g added by the
[PR 5 ownership inventory](#pr-5-ownership-inventory). Each
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

Every PR in this plan preserves these boundaries:

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
| 4 | Request composer | Complete | PR 3 |
| 5a | Evaluation workspace and case-source owners | Complete | PR 4 |
| 5b | Prompts mode and prompt navigation | Complete | PR 5a |
| 5c | Response view | Complete | PR 5b |
| 5d | Batch completion signals | Complete | PR 5c |
| 5e | Pending branch | Complete | PR 5d |
| 5f | Request settings | Complete | PR 5e |
| 5g | Tool registry | Complete | PR 5f |
| 5 | Feature organization and composition-root guardrail | Complete | PR 5g |

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

- Add `app/run/prepare-workbench-run.client.ts`.
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

- Add `app/run/use-run-session.client.ts`.
- Add a Node-safe `app/run/run-session-state.client.ts` if pure helpers warrant it.
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

- Add `app/templates/use-project-templates.client.ts`.
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

- Add `app/request/request-composer.client.tsx`.
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

### Verification completed

- `npm run lint`, `npm run typecheck`, `npm run typecheck:core`, and `npm test`
  passed.
- The extracted composer has direct SSR coverage for an ad hoc request and for
  pending-branch/template-error presentation. The existing rendered suites
  continue to cover project templates, tool selection, connection controls,
  n8n import, and request-pane text.
- In the running app, the local echo fixture rendered exactly
  `Fixture received system="You are a concise, thoughtful assistant." | user="Explain the tradeoff between a cache and a database index to a new engineer in two sentences."`.
  Messages, Templates, and Tools navigation all rendered their expected
  surfaces. The request pane contained no `NaN`, `Infinity`, or `undefined`
  text.

---

## PR 5 ownership inventory

**Observed:** `main` at `2746222` on 2026-10-08. `app/page.tsx` is 2,436
lines. `HomeContent` holds 57 hook calls (`useState`, `useRef`, `useEffect`).

PR 5's ownership review was performed before its file moves. It found seven
responsibilities that still need a feature owner. Most arrived with features
merged after PR 4: MCP execution, the Runs evidence workspace, the Prompts
mode, evaluation baselines, and trace-to-case promotion. Under PR 5's own rule,
those extractions are not hidden in the mechanical PR. They are delivered first
as PRs 5a–5g.

### Remains in the page

Each item below has a reason to stay. PR 5 records the final list in
`docs/ARCHITECTURE.md`.

| Responsibility | Classification | Reason |
| --- | --- | --- |
| `mode`, `workbenchView`, `changeMode`, `traceOpen` | Top-level view selection | The page decides which region is mounted. |
| `comparisonTraceOpen`, `comparisonReturnTarget` | Cross-feature transaction | A comparison unmounts while its trace is read in Compose; the return target must outlive both. |
| `pendingReadinessDestination`, `resolveReadiness` | Cross-feature transaction | Routes a readiness action across the mode boundary to Connections, Prompts, or the composer. |
| Overlay visibility: tool library, n8n import, `confirmation`, `projectCreationMode`, connections drawer and `sessionPromptProjectNotice`, run history | Top-level composition | Opened from several features; rendered at the root. |
| `run()`, `repeat()` | Cross-feature transaction | Join request settings, project, templates, branch, run session, and Runs navigation. |
| `openHistoryTrace`, `openHistoryExperiment`, `dismissFinishedExperiment` | Cross-feature transaction | Join run history, the run and batch sessions, and navigation. |
| `chooseProfile`, `confirmDeleteActiveProfile`, `confirmUpdateProjectEndpoint`, `changeCapability` | Cross-feature transaction | Join connection profiles and the project's connection mapping. |
| Banner candidates and `chooseAppBanner` | Cross-feature adapter | One slot ranks failures and advisories from several owners. |
| `savedRunVersion`, `importedRevision` | Cross-feature signal | Counters that invalidate a history listing and return the composer to Messages. |
| `suiteHistoryRequested` | Cross-feature signal | One of two demands — with Runs — that load the shared run-history listing, which is called before the evaluation owners exist. Settled in PR 5a. |
| `useDesktopRuntime`, `useProjectFolderAccess`, `inferenceTransport` | Route/runtime concern | Hydration-safe runtime detection and the single transport instance. |
| Cmd+Enter and Cmd+S handlers | Top-level composition | Dispatch to whichever workspace is active. |

### Needs an owner

| PR | Owner | Moves out of the page |
| --- | --- | --- |
| 5a | Evaluation workspace and `useEvaluationCaseSource` | `suiteHistoryExpanded`, `evaluationSetupOpen`, `evaluationPreviewPreference`; local targets, start readiness, `evaluationExecutionActions`, the `evaluationHistory` adapter, `startEvaluation`, `confirmEvaluation`; `caseSource`, its loading effect, `onOpenSourceTrace`, and the `promotion` dialog workflow. About 220 lines. |
| 5b | `PromptsMode` and prompt navigation | The inline `ProjectTemplatesPane` tree; `promptNavigationTarget`, `editPromptSource`, `returnFromPromptSource`, return-target clearing on insert and save-and-insert, and `compatibleEvaluationSuitesByTemplate`. |
| 5c | `useResponseView` | `markdownPreview` and its storage effects; `outputFollowing`, `outputScrollRef`, the follow effect, `updateOutputFollowState`, `jumpToLatestOutput`; `displayStatus` and the output, reasoning, status, and completed-tool-call derivation. |
| 5d | `useBatchCompletion` | `finishedBatchesRef`, `finishedBatchCount`, `viewedExperimentId`, unread tracking, `runsIndicator`, `announceFinishedBatch`, and its draining effect. |
| 5e | `usePendingBranch` | `branchContext`, `adHocConversationIdRef`, `editFromHere`, `branchFromHistoryTrace`, and `nonBranchableMessageIds`. |
| 5f | `useRequestSettings` | `sessionModel`, `sessionTemperature`, `streamingPreferred` and its storage effects; `requestProfile` and `requestCapabilities`, `activeModel`, `activeTemperature`, `activeResponseMode`, `setEditorModel`, `setEditorTemperature`, and `currentRequest`. |
| 5g | `useToolRegistry` | `toolRegistry`, `toolRegistryLoaded`, and the read and write effects around the existing store. |

The order puts the largest, lowest-risk owners first and the request settings
last of the substantive ones, because of the hook-order dependency described
under PR 5f.

### Left for PR 5's mechanical cleanup

These change no ownership and need no separate PR:

- delete the pass-through wrappers `continueRun`, `retryRun`, `stop`, and
  `downloadDiagnostics`;
- move `defaultUserPrompts`, `createInitialMessages`, and
  `chooseDefaultUserPrompt` beside `useRequestDraft`;
- make `templateRequestPreview` and the `runReadiness` input assembly pure
  functions in their feature modules;
- share the prepared-run application steps duplicated between `run()` and
  `repeat()` through one page-local helper; and
- move `ProjectCreationDialog`'s per-mode copy into the dialog behind a mode
  prop.

### Rules for PRs 5a–5g

The delivery rules and compatibility constraints above apply unchanged. In
addition:

- Each PR starts with a short contract note in its description: the owner's
  inputs, returned snapshot and commands, and what it does not own. Ambiguous or
  consequential contract choices are agreed with the user before coding.
- An owner whose state must survive a mode unmounting is a hook called by the
  page, not state inside the mode component.
- Owners take narrow callbacks, such as `onError`, `publishToast`, or
  `onNavigate`, instead of complete project, session, or toast handles. This
  follows the pattern `useRunSession` and the evaluation hooks already use.
- Iterate against the affected Playwright specs and run the full suite once
  before handing the PR back.

## PR 5a — Extract the evaluation workspace and case source

**Suggested branch:** `claude/extract-evaluation-workspace`

### Ownership

- **Evaluation workspace hook.** Owns setup and preview layout state, the
  past-executions disclosure (the request latch stays in the page; see
  Decisions), local target resolution, start readiness, the execution actions
  passed to the editor and preview, and the history adapter. It exposes `start()` and the disabled reason the topbar and
  shortcut read. It survives the Evaluations mode unmounting.
- **`useEvaluationCaseSource`.** Owns the focused case's source annotation:
  loading, validating it against its trace, saving after promotion, and its
  toasts.
- **Promotion workflow.** The `promotion` target and the promote-to-case
  mutation move to whichever of the two owners the contract note settles on.
  Navigating to the promoted case stays a page callback.

### Stays in the page

`confirmEvaluation`'s reset of other sessions and switch to Runs, opening a
source trace in Compose, and the baseline-comparison handoff into Runs. Each is
a cross-feature transaction.

### Decide before coding

Whether start readiness and the execution actions belong in the workspace hook
or in a pure module the hook calls, and where the promotion target lives.

### Decisions (agreed 2026-10-08)

- **History latch stays in the page.** `useProjectRunHistory` takes the latch
  as one of three demands and must be called before evaluation authoring, the
  run sessions, and tool bindings exist, which the workspace hook needs. The
  hook reports `onHistoryRequested()`; the page keeps the boolean. The
  disclosure's open state moves into the hook.
- **Start readiness is a pure function the hook calls.**
  `evaluationWorkspaceExecution` in `evaluation-start.client.ts` resolves local
  targets, the disabled reason, and preview targets, and is Node-tested. The
  hook `useEvaluationWorkspace` adds layout state, `start()`, and the history
  adapter.
- **Promotion lives in `useEvaluationCaseSource`**, which already writes the
  source annotation after promotion. The page supplies `onPromoted(suiteId,
  caseId)` for navigation and `onOpenTrace(trace, origin)` for reading a
  source trace in Compose.

### Verification completed

- Characterization added before extraction and run green against unchanged
  code: setup band and past-executions disclosure surviving a mode switch;
  a source annotation loaded from disk opens its trace; a source whose trace
  is missing is reported and the case stays usable.
- `tests/evaluation-workspace-execution.test.ts` covers the pure function.
- Shared automated gate, affected evaluation specs, and the full Playwright
  suite; see the PR description for counts.

## PR 5b — Extract the Prompts mode

**Suggested branch:** `claude/extract-prompts-mode`

### Ownership

- **`PromptsMode`.** A mode component in `app/modes/` alongside
  `EvaluationsMode` and `RunsMode`. It renders `ProjectTemplatesPane`, derives
  the persistence status, and builds the compatible-suites map.
- **Prompt navigation hook.** Owns `promptNavigationTarget`, its key, and the
  return target. It exposes `editSource`, `returnFromSource`, `clearReturn`, and
  `selectionChanged`.

### Stays in the page

Mode switches into Compose and Evaluations, and the `pendingReadinessDestination`
set on return. The return target remains IDs only, with the existing fallback
toast when the use has been removed.

### Decide before coding

The return path: does the navigation hook report a result for the page to act
on, or receive navigation callbacks?

### Decisions (agreed 2026-10-08)

- **The hook reports a result.** `usePromptNavigation().returnFromSource()`
  clears the return path and returns the `{ kind, useId }` target, or
  `undefined`. The page switches to Compose, checks that the use still exists,
  and either sets the readiness destination or posts the fallback toast. The
  hook never switches modes and knows nothing about composer items or toasts.
- **The state transitions are a pure module.** `app/templates/prompt-navigation.ts`
  holds `openPromptSource`, `followPromptSelection`, and `clearPromptReturn`,
  Node-tested in `tests/prompt-navigation.test.ts`. Opening a source bumps the
  remount key; following the author's selection keeps it.
- **`PromptsMode` takes the templates handle plus narrow callbacks.** It takes
  `ProjectTemplatesHandle` as `EvaluationsMode` takes `authoring`, a `Pick` of
  the evaluation authoring handle, the navigation handle, and the page
  callbacks `onInserted`, `onReturn`, `onRevisionEvaluationStarted`,
  `onEvaluationSuiteOpened`, and `onOpenN8nImport`. It wraps insert and
  save-and-insert and calls `onInserted` on success.

### Verification completed

- Characterization added before extraction and run green against unchanged
  code: re-entering Prompts from the mode strip drops "Back to request" but
  keeps the source revision selected; adding the viewed source revision
  returns to Compose with a second use; an unsaved imported project reports
  drafts as kept in this session.
- Not covered in the browser: the fallback toast when the originating use has
  been removed while its source is open. The only route found is an n8n import
  during source navigation. That branch stays in the page, reshaped only to
  read the hook's result.
- Shared automated gate, affected Prompts and evaluation specs, and the full
  Playwright suite; see the PR description for counts.

## PR 5c — Extract the response view

**Suggested branch:** `claude/extract-response-view`

### Ownership

`useResponseView` owns the Markdown preview preference (same storage key and
values), output following, the scroll ref, and the derivation of output,
reasoning, display status, and completed tool calls from `RunState`.

### Stays in the page

`responseSurface` remains composed once in the page, because Compose and Runs
both mount it. `useRunSession`'s `onShowResponse` calls the hook's command to
resume following.

### Decide before coding

Whether the pure derivation moves to a Node-tested module beside the hook.
Recommendation: yes.

### Decisions (agreed 2026-10-08)

- **The hook is called after the run session.** `useResponseView(runState)`
  reads the session's `runState`, and the session's `onShowResponse` calls the
  hook's `followLatest()` through a `const` declared later in the same render.
  That is safe because `useRunSession` calls `onShowResponse` only from its
  run, continue, and retry commands, never during render; a comment at the
  call site records this. No ref is added to the page.
- **The derivation is a pure module.** `app/run/response-view.ts` holds
  `DisplayStatus`, `displayStatus`, and `responseContentOf`, Node-tested in
  `tests/response-view.test.ts`. The hook lives beside it in
  `app/run/use-response-view.client.ts` and owns the storage key, the follow
  state, the scroll ref, `updateFollowState`, and `jumpToLatest`. The topbar's
  `responseStatus` reads the same `status`.

### Verification completed

- Characterization added before extraction and run green against unchanged
  code in `tests/e2e/response-view.spec.ts`: the pane follows output, scrolling
  away shows "Jump to latest ↓", jumping returns to the bottom, and a new run
  resumes following; the Markdown or Raw choice is written as `markdown` or
  `raw`, survives a reload without being overwritten by the default, and
  applies to the next run. Removing the resume from `onShowResponse` turned
  the follow spec red on the lingering jump button.
- Not covered in the browser: following during a streamed response, since no
  streaming fixture produces overflowing output. The buffered answer exercises
  the same effect on its output change.
- Shared automated gate, the affected response and Markdown specs, and the full
  Playwright suite; see the PR description for counts.

## PR 5d — Extract batch completion signals

**Suggested branch:** `claude/extract-batch-completion`

### Ownership

`useBatchCompletion` owns the finished-batch queue and the counter that drains
it, `viewedExperimentId`, unread derivation, the Runs indicator, and the
completion toast. It takes the current mode, both execution snapshots, a
toast publisher, and a `viewResults` navigation callback. It exposes
`recordFinished` for the two sessions' `onFinished` and `indicator` for the
topbar.

### Preserve

The render-time adjustment of `viewedExperimentId` and the post-commit drain
are deliberate (see their comments) and move unchanged.

### Decisions (2026-10-08)

Settled by the PR 5c precedent; no open contract choice remained.

- **The hook is called after both batch sessions.** `useBatchCompletion` reads
  their `isRunning` and `execution` snapshots, and each session's `onFinished`
  calls `batchCompletion.recordFinished` through a `const` declared later in
  the same render. Sessions report completion only after awaiting their batch,
  never during render; a comment at the call site records this.
- **The Runs dot and toast copy are a pure module.** `app/run/batch-completion.ts`
  holds `FinishedBatch`, `runsIndicator`, and `finishedBatchToast`, Node-tested
  in `tests/batch-completion.test.ts`. The hook in
  `app/run/use-batch-completion.client.ts` owns the queue and its counter,
  `viewedExperimentId`, unread derivation, and the draining effect. It takes
  `mode`, the two snapshots, `publishToast`, and `viewResults`; it never
  switches modes itself.

### Verification completed

- Characterization added before extraction and run green against unchanged
  code in `tests/e2e/repeated-experiment-completion.spec.ts`: a repeated
  experiment that finishes while Compose is open shows "Repeated experiment
  finished" with "2 repetitions completed.", leaves a neutral "finished, not
  yet viewed" dot, and "View results" lands on Runs and retires both. Removing
  the repeated session's `recordFinished` call turned it red on the missing
  toast. Evaluation outcomes were already covered by
  `runs-indicator.spec.ts` and `evaluation-completion-toast.spec.ts`.
- Not covered in the browser: the singular "1 repetition" copy, which the
  dialog's two-repetition minimum makes unreachable; the Node test covers it.

## PR 5e — Extract the pending branch

**Suggested branch:** `claude/extract-pending-branch`

### Ownership

`usePendingBranch` owns `branchContext`, the ad hoc conversation ID, edit-from-
here and branch-from-saved-trace preparation, and `nonBranchableMessageIds`.
It takes `resetMessages` and an error callback. Its returned commands report
whether a branch was created so the page can navigate.

### Stays in the page

Clearing the branch when a project draft or n8n import is applied, a trace is
adopted, or a run consumes it. Those are calls into the hook from existing
transactions.

### Decisions (agreed 2026-10-08)

- **Run preparation reads and settles through the hook.** The ad hoc
  conversation ID stays a private ref. `run()` and `repeat()` spread
  `pendingBranch.preparationInputs()` into `prepareWorkbenchRun` and call
  `pendingBranch.settle(prepared)` once the run is committed to, which
  remembers the ad hoc conversation and drops a consumed branch. `repeat()`
  still settles only after its dialog confirms.
- **The hook is called after the run session.** It reads `runState`,
  `transcript`, and `traceStorage`. `useProjectWorkspace`'s `onApplyDraft` and
  `useRunSession`'s `onResetBranch` call `pendingBranch.clear()` through a
  `const` declared later in the same render, as the page already did with the
  branch state setter; neither runs during render.
- **The derivation is a pure module.** `app/run/pending-branch.ts` holds
  `PendingBranch`, `branchFromTranscript`, `branchFromSavedTrace`, and
  `nonBranchableMessageIds`, Node-tested in `tests/pending-branch.test.ts`. The
  hook in `app/run/use-pending-branch.client.ts` takes `resetMessages` and
  `onError`; `editFromHere` and `branchFromTrace` return whether a branch
  started, and the page navigates.

### Verification completed

- Characterization added before extraction and run green against unchanged
  code in `tests/e2e/pending-branch.spec.ts`: "Edit from here" drafts the
  transcript through that message and shows the pending-branch chip with
  "Save trace…" for an unsaved parent; the next run records "Branched from run
  …" and drops the chip; "Discard branch" leaves an ordinary run; importing a
  project drops the branch. Removing the consumption in `settle` and the clear
  in `onApplyDraft` turned the first and last red on the lingering chip.
  Branching from a saved trace in Runs was already covered by
  `runs-result-discovery.spec.ts`.
- Not covered in the browser: the disabled "Edit from here" inside a
  message-set template, and a saved trace with no message to branch from. The
  Node test covers the first; the second has no route through the UI.

## PR 5f — Extract request settings

**Suggested branch:** `claude/extract-request-settings`

### Ownership

`useRequestSettings` owns the session model and temperature, the streaming
preference (same storage key and values), resolution of the request's
profile from the project mapping or active profile, request capabilities, the
effective model, temperature, and response mode, the editor setters, and
`currentRequest()`.

### Hook-order dependency

`useProjectWorkspace`'s callbacks (`createFreshProject`, `createProject`,
`currentDraft`, `onApplyDraft`) read these values through closures, while
resolving the request profile needs `projectFile` and `mappedProfileIds` from
that same hook. The contract note must settle this cycle explicitly, for
example with a ref-backed reader or by splitting profile resolution from the
session values, and must not rely on incidental closure timing. Check whether
the `clearTemplateOverridesRef` workaround can be removed in the same change.

### Decisions (agreed 2026-10-08)

- **The cycle is broken by call order, not by a ref.** `useRequestSettings` is
  called after `useProjectWorkspace` and `useRequestDraft`, because it reads
  `projectFile`, `mappedProfileIds`, and `messages`. The workspace's callbacks
  read `requestSettings` through a `const` declared later in the same render,
  as they already do for `pendingBranch`. The workspace calls them only from
  project commands and effects, never during render; a comment above the
  workspace call records this. Splitting session state from resolution was
  rejected because `currentDraft` and `createProject` need the effective
  model, which depends on the mapping, so a forward reference would remain. A
  ref-backed reader was rejected as machinery that reads the same committed
  values the closures already do.
- **`clearTemplateOverridesRef` is removed.** `onApplyDraft` calls
  `projectTemplates.clearTransientOverrides()` directly under the same rule.
- **Resolution is a pure module.** `app/request/resolve-request-settings.ts`
  holds `resolveRequestSettings` and `requestFromSettings`, Node-tested in
  `tests/resolve-request-settings.test.ts`. The hook in
  `app/request/use-request-settings.client.ts` owns the session model and
  temperature, the streaming preference and its storage key, and the editor
  setters. It takes `updateActiveProfile` and `onProjectEdited` and returns the
  resolved connection requirement, profile, `profileMapped`, capabilities,
  model, temperature, and response mode, with `setModel`, `setTemperature`,
  `setStreamingPreferred`, `applyDraft`, and `currentRequest`. Model discovery
  and credentials stay in the page and read `requestSettings.profile`.

### Verification completed

- Characterization added before extraction and run green against unchanged
  code in `tests/e2e/request-settings-ownership.spec.ts`: without a project,
  editing model and temperature writes the active profile and the run sends
  them; in a project, the same edits mark it unsaved, reach the provider, leave
  the stored profile untouched, and a re-import restores the project's values;
  toggling streaming writes `buffered` and `streaming` to the preference key.
  Making `applyDraft` a no-op turned the project test red on `profile-model`
  where `project-model` was expected.
- Not covered in the browser: `createFreshProject`'s response mode when a
  folder project is created from an open project. The existing streaming
  preference race is covered by `streaming-preference.spec.ts`.

## PR 5g — Extract the tool registry

**Suggested branch:** `claude/extract-tool-registry`

### Ownership

`useToolRegistry` owns the device-local registry state, its deferred load, and
write-back through the existing `tool-registry-store.client.ts`. The modal's
visibility stays in the page. The registry format is unchanged.

### Decisions (2026-10-08)

Settled by the plan's ownership note; no open contract choice remained.

- **The hook takes nothing and returns `registry` and `setRegistry`.** It
  lives in `app/tools/use-tool-registry.client.ts` beside the other tool
  owners. The load flag stays private: nothing outside the hook read it.
  The store module stays where it is; PR 5 decides any move.
- **Attaching stays with the request draft.** `attachRegistryToolToProject`
  and `attachRegistryToolToRequest` copy a snapshot and are unchanged; the
  page still wires them and the confirmation dialog into the modal.

### Verification completed

- Characterization added before extraction and run green against unchanged
  code in `tests/e2e/tool-registry-ownership.spec.ts`: a library stored before
  load is listed and left in storage, a new tool saved in the modal is written
  back, and both survive a reload. Removing the wait for the initial read
  turned it red with the library empty where `lookup_order` was expected.
- Not covered in the browser: a stored library that fails to parse, which
  `tests/tool-registry.test.ts` covers at the parser.

---

## PR 5 — Organize feature modules and enforce the composition root

**Suggested title:** `Organize workbench features and guard the composition root`

**Suggested branch:** `codex/organize-workbench-features`

### Goal

Perform the final mechanical organization after ownership is established,
review the remaining page responsibilities, and add a durable repository
guardrail.

### Ownership review

The initial inventory was recorded on 2026-10-08 as the
[PR 5 ownership inventory](#pr-5-ownership-inventory), and its findings became
PRs 5a–5g. After those merge, repeat the inventory against current code: check
every state value, ref, effect, and inner function still in `HomeContent`. Classify each as:

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
- Apply the inventory's
  [mechanical cleanup](#left-for-pr-5s-mechanical-cleanup) list.
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

### Ownership review (2026-10-08)

Repeated on `main` at `31f822e`, after PR 5g: `app/page.tsx` was 1,750 lines
with 18 `useState`, `useRef`, and `useEffect` calls in `HomeContent`. Every
remaining state value, ref, and effect matched the
[Remains in the page](#remains-in-the-page) list except the default-prompt
effect, which the cleanup list already moved. The review also classified the
smaller adapters the inventory had not named — `bindingForTool`,
`unservableTools`, `runHistoryBlocked`, `n8nImportDisabledReason`,
`confirmEvaluation`, `ensureProjectDocument`, and the shared response and
trace surfaces — as cross-feature adapters. No further owner was found.

### Decisions (agreed 2026-10-08)

- **Narrow file moves.** Only modules with an existing feature directory and a
  single owning feature moved: `use-request-draft.client.ts` to
  `app/request/`, and `tool-registry-store.client.ts` and
  `tool-registry-modal.client.tsx` to `app/tools/`. The project, connection,
  and run-history hooks stay at the app root; giving them new directories
  would be a move for symmetry.
- **The request draft owns the default prompt.** `app/request/default-messages.ts`
  holds the prompt list, `createInitialMessages`, and
  `chooseDefaultUserPrompt`. `useRequestDraft` drops its `initialMessages`
  option, renders the first prompt on the server, and picks a random one after
  hydration. `createFreshProject` imports the helpers.
- **Template derivations are one pure module.** `app/templates/template-run-view.ts`
  holds `templateRequestPreview` and `templateReadinessInputs`, Node-tested in
  `tests/template-run-view.test.ts`. The page still assembles the readiness
  input because it joins templates with request settings and the tool count.
- **`run()` and `repeat()` share two page-local steps.** `prepareComposerRun`
  prepares and reports, `commitPreparedRun` applies the branch revision,
  executed revision, and branch consumption. `repeat()` still commits only
  after its dialog confirms.
- **`ProjectCreationDialog` takes a required `mode`** and owns each mode's
  copy. The `copy` prop is removed.
- **`AGENTS.md` needed no change.** Its "Route composition roots" section,
  added in PR #75, already states the required policy.

### Verification completed

- Characterization added before the cleanup and run green against unchanged
  code in `tests/e2e/workbench-composition.spec.ts`: a fresh workbench opens on
  the system prompt and the randomly chosen user prompt (with `Math.random`
  pinned); two pinned prompts resolve into the request preview's messages and
  raw body; and their differing recommended targets are named in run
  readiness. Removing the default-prompt effect turned the first test red on
  the server-rendered prompt; emptying the template targets turned the second
  red on the missing readiness notice. Dropping the preview's message override
  stayed green, because in that fixture the composer's messages already hold
  the resolved output.
- `tests/project-creation-render.test.mjs` now renders both save modes. The
  dialog copy for all three modes was already covered in the browser by
  `new-project-isolation`, `project-storage-clarity`, and
  `project-replacement-guard`.
- Final metrics, recorded as observations: `app/page.tsx` is 1,586 lines with
  17 `useState`, `useRef`, and `useEffect` calls in `HomeContent`.

---

## Review follow-ups (2026-10-08)

- Added the explicit `RunSessionHandle` and exported trace-origin type beside
  `useRunSession`, documenting command preconditions and callback timing.
- Strengthened the preview characterization with a branch/discard sequence:
  the draft remains truncated while the pinned revision resolves both prompts.
  Removing the raw body's resolved-message override now fails on the missing
  `Summarize the rollback.` content; the mutation was restored after checking.
- Added a controlled real SSE provider and browser assertions across successive
  overflowing deltas, scrolling away, and jumping back while still streaming.
  Before the fix, the second delta left the view 996 pixels from the bottom.
  A delayed event from an automatic scroll was interpreted as scrolling away
  after new content arrived. The response-view owner now ignores that matching
  programmatic event while still honoring a changed scroll position. Browser
  scroll anchoring is disabled for this pane so it cannot undo the owner’s
  scroll-to-bottom after the jump button disappears.

Verification: lint, both typechecks, and `npm test` passed (940 tests).
The two focused browser specs passed all five tests; the streaming regression
also passed five repeated runs after the final fix. The final full browser run
passed 243 tests with seven opt-in Python MCP/N1 tests skipped. An earlier full
run hit a Vite request-body error whose overlay blocked three tests; the fresh
server rerun passed. Native Tauri and hosted providers were not exercised.

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
| Evaluation layout, start readiness, history adapter | Evaluation workspace hook (PR 5a) |
| Case-source annotation and trace-to-case promotion | `useEvaluationCaseSource` (PR 5a) |
| Prompt library presentation and edit-source/return navigation | `PromptsMode` and the prompt navigation hook (PR 5b) |
| Response presentation preferences, output following, output derivation | `useResponseView` (PR 5c) |
| Finished-batch announcement and the Runs indicator | `useBatchCompletion` (PR 5d) |
| Pending branch and ad hoc conversation identity | `usePendingBranch` (PR 5e) |
| Session model, temperature, streaming preference, request profile | `useRequestSettings` (PR 5f) |
| Device-local tool registry | `useToolRegistry` (PR 5g) |
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
