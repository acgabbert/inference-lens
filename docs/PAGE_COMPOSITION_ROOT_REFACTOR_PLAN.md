# `app/page.tsx` composition-root refactor plan

**Status:** Ready to execute

**Branch:** `refactor/page-composition-root`

**Starting point:** `app/page.tsx` is 2,118 lines; `HomeContent` is about
1,866 lines.

This plan follows the completed handoff in the untracked, symlinked
`notes/page.tsx refactor.md`. That effort reduced the page to 1,061 lines by
extracting diagnostics, model discovery, connection profiles, request drafts,
project workspace state, and several presentational components. Subsequent run
history, retry, branch/replay, trace, and project-template work has doubled the
page again.

The goal is not a small file for its own sake. The goal is for `page.tsx` to be
a composition root: it chooses feature owners, connects the few genuinely
cross-feature actions, and renders the workbench. Feature state machines and
cohesive mutation workflows should have named owners outside the route.

## Evidence and current pressure points

- `page.tsx` contains 22 `useState` calls, 11 refs, 7 effects, 39 inner
  functions, and imports from 46 modules.
- Project-template orchestration occupies roughly lines 530–965: project
  materialization, branch-on-first-edit, immutable template revision actions,
  template-use overrides, composer item mutation, confirmation requests, and
  request preview.
- Live run orchestration begins around line 1,017 and owns tool-result drafts,
  transport execution, retry, continuation, cancellation, diagnostics, trace
  persistence, trace import/export, trace adoption, and branch provenance.
- The request side of `WorkbenchShell` remains roughly 300 lines of inline JSX.
- `docs/reviews/PROJECT_TEMPLATES_REVIEW.md` already identified the missing
  `use-project-templates.client.ts` boundary and connected real state-wiring
  defects to the unextracted orchestration.
- The prior handoff's advice to leave run machinery alone applied when it was
  about 250 lines. The machinery is now a larger subsystem, and its refs have
  enough shared ownership to justify moving them together.

## Decisions fixed by this plan

### 1. `page.tsx` is a composition root, not a default feature owner

The page may retain:

- hook composition and dependency injection;
- small view-selection state that coordinates top-level regions;
- narrow adapters that deliberately join two feature owners;
- keyboard shortcuts that invoke already-owned commands; and
- final assembly of `Topbar`, request, response, drawers, and dialogs.

The page should not retain a feature's state/effect/ref cluster or its mutation
workflow merely because the feature is rendered on the page.

There is no hard line cap. A likely result is roughly 800–1,100 lines, but
ownership and readability are the acceptance criteria.

### 2. Project-template orchestration gets one owner

Add `useProjectTemplates` in `app/use-project-templates.client.ts`.

It owns:

- transient template-use run overrides;
- the executed-revision set and branch-on-first-edit policy;
- the derived template workbench, active resolution, composer items, and usage
  counts;
- create/save/insert/update-to-latest/detach/remove workflows;
- authored literal-message mutation inside project revisions;
- structured confirmation requests for destructive or revision-changing
  actions; and
- the resolved request preview.

It does **not** own project persistence or the general editable request draft.
Those remain with `useProjectWorkspace` and `useRequestDraft`. The new hook
receives narrow callbacks and snapshots from those owners.

The hook must not receive the complete project-workspace or connection-profile
handles. Its input contract should name only the operations it actually needs:
ensure a current project document, adopt a project mutation, replace the
derived draft, report a project error, and read the current authored request
settings.

The hook returns a named `ProjectTemplatesHandle`. That handle is an
application-layer contract, not a serialized or provider-facing type.

### 3. Pure template policy remains importable without React or Tauri

Add `app/project-template-actions.client.ts` for pure, testable policy used by
the hook. Candidate responsibilities include:

- selecting or creating the project revision to mutate;
- deriving the next override map;
- preparing update-to-latest metadata and extra output message IDs;
- authored item updates for add/edit/remove message; and
- building the resolved request-preview result.

The module must have a Node-test-safe import graph and use explicit `.ts`
extensions in imports reachable from `tests/*.test.ts`.

No React testing dependency will be added solely for this refactor. Pure policy
gets direct unit coverage; hook wiring gets SSR and running-app coverage.

### 4. The request composer becomes a feature component

Add `app/request-composer.client.tsx`.

It owns request-pane presentation and feature-local navigation:

- Messages/Templates/Tools tab state;
- run settings and selected-tool summary;
- readiness notice actions that switch request tabs;
- pending-branch notice;
- message and template-use card rendering;
- resolved request preview; and
- delegation to `ProjectTemplatesPane` and `ToolsPane`.

Props remain explicit snapshots and callbacks. Do not pass entire
`useProjectWorkspace` or `useConnectionProfiles` handles. It is acceptable to
pass the named `ProjectTemplatesHandle`, because the component is the primary
view for that feature and the handle is already a deliberately narrow contract.

The component owns only presentation state. Models, temperature, project
documents, messages, tools, and run state remain owned by their existing
feature hooks.

### 5. Run preparation and live run execution are separate contracts

Add a pure application-layer preparation seam in
`app/prepare-workbench-run.client.ts`.

It converts current UI/application snapshots into a discriminated result:

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

The exact exported names may change during implementation, but these semantics
must not:

- validation and project/template resolution are pure;
- a failed preparation produces no project, branch, or run-session mutation;
- any project mutation is returned for the caller to adopt explicitly;
- the result contains a provider-neutral `ResolvedRunInput`; and
- local profile identifiers are attached only at the application boundary and
  are never persisted into portable project contracts.

This seam owns selected-tool validation, branch revision preparation, template
resolution and generated-message equivalence checks, and construction of the
resolved run input.

### 6. The complete live run session moves atomically

Add `useRunSession` in `app/use-run-session.client.ts`.

The extraction must move the interlocked live-run state together:

- `RunCoordinator`;
- active `AbortController`;
- request-generation counter;
- current run-state ref and React state;
- request-active state;
- provider-turn execution;
- retry, manual tool-result continuation, and stop;
- tool-result drafts;
- diagnostic capture;
- trace workspace snapshot and terminal autosave;
- persisted run IDs and trace storage status;
- loaded-trace adoption;
- run branch provenance; and
- trace import/export.

Do not temporarily split `coordinatorRef`, `abortRef`, or
`requestGenerationRef` across the page and hook. The old generation guard must
remain inside the same owner that starts, retries, continues, and stops a
request.

`useRunSession` is provider-neutral. It receives:

- a `ProviderTurnTransport`;
- a `prepareCredential` callback;
- a callback for the current redacted diagnostic request context;
- a tool-call-to-default-draft resolver;
- an optional project workspace for the next run; and
- a callback notifying run history that a trace was saved.

Starting a run accepts an already prepared `ResolvedRunInput` and optional
branch provenance. The hook must not know how to mutate a `ProjectFile`, map a
profile, resolve a prompt template, or mark a project dirty.

Trace adoption is a run-session command. Opening a history item remains a
page-level adapter because it intentionally joins `useProjectRunHistory` to
`useRunSession`.

Pure helpers that deserve direct tests belong in a Node-safe
`app/run-session-state.client.ts`, including terminal-state classification,
retryability, pending tool-call draft/result derivation, and trace creation
eligibility. The React hook retains browser, transport, and persistence side
effects.

### 7. Serialization and compatibility boundaries do not change

This is a behavior-preserving application-layer refactor:

- no Project file schema change;
- no Run Trace schema change;
- no provider request/stream contract change;
- no credential storage change;
- no tool registry format change;
- no new persisted UI state; and
- no core run-kernel redesign.

If implementation exposes a necessary behavior or schema change, stop that
session and design it separately. Do not hide it inside the refactor.

### 8. Add a composition-root guardrail to `AGENTS.md`

Add a section with this policy:

> ## Keep route components as composition roots
>
> Route and page components should primarily compose feature owners. When a
> feature adds cohesive state, effects, refs, or mutation workflows, define a
> feature hook or component boundary as part of that feature. Keep only
> genuinely cross-feature adapters in the route.
>
> Before materially expanding a route component, identify the intended owner
> for the new responsibility. If the route must own it, record why it cannot
> belong to an existing or new feature boundary. Treat a substantial increase
> in route-local state or orchestration as a design decision, not a default
> implementation detail.
>
> Prefer ownership and cohesive contracts over arbitrary file-size limits.
> Extract presentational JSX for local readability, but do not create global
> state or generic abstractions without a durable ownership, compatibility, or
> reuse reason.

Minor wording adjustments are fine, but retain the distinction between an
ownership trigger and a hard line limit.

## Target ownership

| Concern | Target owner | Notes |
| --- | --- | --- |
| Profile, capability, credential | `useConnectionProfiles` | Unchanged; project-agnostic |
| Portable project lifecycle | `useProjectWorkspace` | Unchanged |
| Messages, tools, mocks, one-shot tools | `useRequestDraft` | Unchanged |
| Template definitions, uses, overrides, authored-item mutation | `useProjectTemplates` | New |
| Template mutation policy | `project-template-actions.client.ts` | New, pure and directly tested |
| Request pane and its tabs | `RequestComposer` | New presentation boundary |
| Cross-feature run preparation | `prepare-workbench-run.client.ts` | New, pure and directly tested |
| Live coordinator, transport, retry/continue/stop | `useRunSession` | New |
| Diagnostics and trace lifecycle for the current run | `useRunSession` | Moves with live run ownership |
| Run-session pure derivations | `run-session-state.client.ts` | New, directly tested |
| Project trace list/read | `useProjectRunHistory` | Unchanged |
| Top-level drawers/view selection/keyboard commands | `page.tsx` | Small composition concerns |

## Execution sessions

Each session must start by re-reading this plan, `AGENTS.md`, and the current
diff. Keep each session behavior-preserving and leave the branch lint- and
typecheck-clean. Commit boundaries may match sessions, but commits are left to
the executor unless explicitly requested.

### Session 01 — Guardrail and baseline

**Goal:** Make the architectural rule durable before moving code.

1. Add the composition-root section to `AGENTS.md`.
2. Record the current `page.tsx` metrics in the session handoff:
   line count, state/ref/effect count, and the main function ranges.
3. Run the full non-Rust baseline:
   - `npm run lint`
   - `npx tsc -p tsconfig.json --noEmit`
   - `npm run typecheck:core`
   - `npm test`
4. Record the actual test counts. Do not copy the stale counts from the old
   notes handoff.

**Exit condition:** Documentation-only diff, with the existing application
baseline verified.

#### Session 01 handoff — 2026-07-26

`app/page.tsx` baseline: 2,118 lines; 22 `useState` calls; 11 `useRef` calls;
7 `useEffect` calls; and 46 import declarations.

Main `HomeContent` ranges at this baseline:

- Lines 244–508: feature-hook composition, route-local state, and terminal
  run-state/trace autosave adapter.
- Lines 509–964: project-template workbench derivation and template mutation
  workflows.
- Lines 965–1,016: project-aware request-setting and authored-message
  mutations.
- Lines 1,017–1,596: live run coordination, diagnostics, retry/continuation,
  trace persistence, import/export, and trace adoption.
- Lines 1,597–1,640: project run-history adapter and readiness routing.
- Lines 1,641–2,110: workbench, drawer, and dialog composition/rendering.

Automated baseline results:

- `npm run lint`: passed.
- `npx tsc -p tsconfig.json --noEmit`: passed.
- `npm run typecheck:core`: passed.
- `npm test`: passed after the suite was permitted to bind its localhost
  standalone-runtime fixture. The initial sandboxed attempt could not bind the
  fixture and failed with `EPERM`; the elevated rerun passed 195 core tests and
  25 rendered/standalone tests (220 total).

### Session 02 — Project-template owner

**Goal:** Remove template state and mutation workflows from `HomeContent`.

1. Add `project-template-actions.client.ts` and focused tests.
2. Add `use-project-templates.client.ts` with the ownership described above.
3. Move `templateRunOverrides`, `executedRevisionIdsRef`, template workbench
   derivation, usage counts, confirmations, request preview, and all template
   and project-aware composer mutations into the new owner.
4. Replace the page functions with one hook call and a narrow returned handle.
5. Preserve immutable revision creation, branch-on-first-edit, override
   clearing, output message IDs, and project dirtying exactly.
6. Extend SSR tests where a visible contract changes location, even if markup
   remains byte-for-byte equivalent.

**Focused tests:**

- first edit after execution creates one child revision;
- later edits target the new revision rather than branching repeatedly;
- run-only override update and clearing;
- update-to-latest clears removed assignments and its run override;
- add/edit/remove literal messages around template uses;
- detach preserves resolved message IDs and values;
- request preview uses resolved messages and selected tools; and
- invalid template resolution becomes an error result rather than escaping
  during render.

**Running-app check:** With `scripts/echo-openai-provider.mjs`, create a
fragment template, insert it, exercise saved and run-only values, and confirm
the fixture's exact echoed messages match the resolved preview. Run once, edit
the authored conversation, and verify a single new revision is created.

**Exit condition:** No project-template mutation function, override state, or
executed-revision ref remains in `page.tsx`.

#### Session 02 handoff — 2026-07-26

- Added `project-template-actions.client.ts` for Node-safe template mutation
  policy and request-preview construction, with direct coverage in
  `tests/project-template-actions.test.ts`.
- Added `use-project-templates.client.ts`, which owns run-only overrides,
  executed revisions, template workbench derivation, usage counts,
  confirmations, request preview, and all template/authored-composer
  mutations. `page.tsx` supplies explicit project and request-draft
  operations and consumes its named handle.
- `app/page.tsx` is now 1,734 lines. It contains no template override state,
  executed-revision ref, or project-template mutation workflow.

Automated verification:

- `npx tsc -p tsconfig.json --noEmit`: passed.
- `npm run typecheck:core`: passed.
- `npm run lint`: passed.
- `npm test`: passed with 198 core tests and 25 rendered/standalone tests.

Running-app note: the echo fixture and development server both started and
were reachable from the workspace. The in-app browser is network-isolated from
that host and refused both `127.0.0.1:3000` and `localhost:3000`, so the
interactive template/branch sequence could not be performed in this
environment. Both servers were stopped. The Session 06 matrix should repeat
this check from a browser with access to the local host.

### Session 03 — Request composer presentation

**Goal:** Remove the large request JSX subtree without moving domain ownership.

1. Add `request-composer.client.tsx`.
2. Move request tabs, settings UI, selected-tool summary, readiness notice,
   pending-branch notice, message cards, template-use cards, request preview,
   `ProjectTemplatesPane`, and `ToolsPane` composition into it.
3. Move `requestTab` and tab-only readiness routing into the component.
4. Keep profile mapping and opening connection settings as explicit callbacks
   supplied by the page.
5. Add SSR tests for:
   - all three tabs and counts;
   - tools-disabled summary and action;
   - project versus profile run-setting label;
   - structural tool/assistant message rendering;
   - pending branch status and actions; and
   - resolved preview success, warnings, and error.

**Running-app check:** Exercise keyboard save/run, switch all request tabs,
edit each supported message role, open the tool library and connection drawer,
and verify readiness actions land on the intended tab or drawer.

**Exit condition:** `WorkbenchShell.request` in `page.tsx` is one
`RequestComposer` element with explicit props.

#### Session 03 handoff — 2026-07-27

- Added `request-composer.client.tsx`. It owns request-tab state, readiness
  routing to request tabs, request settings and selected-tool presentation,
  branch notice controls, message/template-use cards, preview rendering, and
  `ProjectTemplatesPane`/`ToolsPane` composition. The page supplies explicit
  snapshots and callbacks, including only the named `ProjectTemplatesHandle`
  for the template feature.
- `WorkbenchShell.request` in `app/page.tsx` is now a single
  `RequestComposer` element. The page is 1,461 lines, with 11 `useState`
  calls, 3 `useRef` calls, and 7 `useEffect` calls.
- Extended `tests/request-pane-render.test.mjs` with SSR assertions for the
  tab counts, tool-disabled readiness action, project/profile run-setting
  label, structural messages, pending-branch actions, and resolved-preview
  success, warning, and error states.

Automated verification:

- `npm run lint`: passed.
- `npx tsc -p tsconfig.json --noEmit`: passed.
- `npm run typecheck:core`: passed.
- `npm test`: passed with 198 core tests and 31 rendered/standalone tests
  (229 total). The sandboxed attempt could not bind the standalone fixture;
  the permitted localhost rerun passed.

Running-app verification:

- Started `scripts/echo-openai-provider.mjs` and the local development server,
  then stopped both after the check.
- Switched each request tab, edited a user message, opened and closed the
  connection drawer, and ran with the keyboard shortcut using the echo fixture.
  The completed response exactly echoed `Echo this exact Session 3 request.`
- The rendered application contained no `NaN`, `Infinity`, or `undefined`, and
  the browser reported no console errors.

### Session 04 — Pure workbench-run preparation

**Goal:** Separate project/template/tool validation from live transport state.

1. Add `prepare-workbench-run.client.ts` and its discriminated result.
2. Move selected-tool validation, tools-capability enforcement, branch project
   creation, template preparation, generated-message equivalence checking,
   identity selection inputs, and `createResolvedRunInput` into it.
3. Keep application of returned effects explicit in `page.tsx`:
   adopt a returned project mutation, mark the executed revision, clear a
   consumed pending branch, and report a returned project error.
4. Do not start or mutate `RunCoordinator` from the preparation module.

**Focused tests:**

- blank and duplicate tool names;
- tools selected against a tools-disabled capability;
- ad hoc identity preparation;
- ordinary project revision preparation;
- branch preparation with and without a valid parent revision;
- template diagnostics block preparation without mutations;
- generated template text mismatch;
- run-only overrides survive branch preparation;
- preparation returns the expected branch provenance; and
- failure leaves input project and pending branch snapshots unchanged.

**Exit condition:** The page's run-start adapter reads as prepare → apply
returned application effects → `runSession.start`.

#### Session 04 handoff — 2026-07-27

- Added `prepare-workbench-run.client.ts`. It owns selected-tool validation and
  the tools-disabled capability check, branch project creation, ordinary and
  branch identity resolution (including the ad hoc conversation id previously
  held only in a page ref), template preparation via
  `prepareProjectRevisionRun`, generated-message equivalence checking, and
  `createResolvedRunInput` construction. It returns the discriminated
  `PrepareWorkbenchRunResult` from the plan verbatim, plus `request` (the
  final, possibly template-resolved request) and `adHocConversationId` so the
  caller can persist state the module itself never mutates.
- `page.tsx`'s `run()` now reads as prepare → apply returned effects
  (`project.adoptBranchRevision`, `adHocConversationIdRef.current`,
  `templates.markRevisionExecuted`, `setBranchContext(null)`) →
  `new RunCoordinator(prepared.input)`. `currentRunIdentity` and
  `templateRunErrorMessage` were deleted from the page; both moved into the
  new module. `RunCoordinator`, the abort controller, and the generation
  counter are untouched, per the plan's "do not start or mutate
  `RunCoordinator`" constraint.
- One intentional behavior tightening, required by the plan's own invariant
  ("a failed preparation produces no project, branch, or run-session
  mutation"): previously `project.adoptBranchRevision(branchedProject)` ran
  immediately after branch creation, before template-resolution validation
  could still fail and abort the run. A branch could be silently created even
  though the run itself was then rejected. The new seam defers
  `projectMutation` until `prepareWorkbenchRun` returns `ok: true`, so a
  rejected run — including one that fails only after an internal branch was
  computed — leaves the caller's project untouched. Covered by the
  "branch preparation without a resolvable parent revision" and "unresolved
  template diagnostics" tests below.
- `app/page.tsx` is now 1,334 lines, with 11 `useState`, 3 `useRef`, and 7
  `useEffect` calls — unchanged from Session 03, since this session moved
  validation/derivation logic, not React state.

**Focused tests** (`tests/prepare-workbench-run.test.ts`, 10 tests, all
Node-safe with no Tauri or React import):

- blank and duplicate tool names;
- tools selected against a tools-disabled capability (default capability
  profile already has `tools: false`, matching production defaults);
- ad hoc identity minted once and reused across a second call;
- an ordinary project revision resolves its template use into the run input;
- branch preparation with a valid parent produces a project mutation and the
  expected branch provenance, leaving the original project object untouched;
- branch preparation with a missing or unknown parent revision id fails
  without mutating the project;
- run-only template overrides survive branch preparation and appear in the
  resolved run input;
- unresolved template diagnostics block preparation without a project
  mutation; and
- a manually edited template-backed conversation fails preparation instead of
  running.

Automated verification:

- `npm run lint`: passed.
- `npx tsc -p tsconfig.json --noEmit`: passed.
- `npm run typecheck:core`: passed.
- `npm test`: passed with 208 core tests (198 + 10 new) and 31
  rendered/standalone tests (239 total).

Running-app verification: this session reached full browser-driven
verification, unlike Sessions 02 and 03's environment. `npx playwright
install chromium` succeeded (binaries cached under
`~/Library/Caches/ms-playwright`, no project dependency added), and a
Playwright script drove `http://localhost:3000/` against
`scripts/echo-openai-provider.mjs`. Both `npm run dev:echo-provider` and
`npm run dev` bound their ports directly, with no `EPERM`. One local
toolchain quirk: this project's dev server (`vinext dev`, an RSC-streaming
Vite wrapper) needs `waitUntil: "networkidle"` plus a further ~2s settle
before client `onClick` handlers are attached — clicking immediately after
the SSR text becomes visible is a no-op. With that wait:

- an ordinary run (no project open) completed and the transcript showed
  exactly `Fixture received system="You are a concise, thoughtful
  assistant." | user="Echo this exact Session 4 request."`, with a
  `Complete` status and 12 recorded events;
- clicking "Edit from here" showed the `Branching from run <run id>` notice,
  editing the truncated conversation and running again completed with
  `Branched from run <run id>.` provenance visible and the accumulated
  transcript echoed back exactly; and
- the rendered document contained no `NaN`, `Infinity`, or `undefined`, and no
  browser console errors were recorded.

This exercised the ad hoc (no active project) identity and branch-identity
paths end to end. It did not exercise the project-backed `createBranchRevision`
path in the browser, since no project was open; that path's invariants
(project mutation deferred until success, branch provenance, revision count)
are covered directly by the unit tests above. The Session 06 matrix should
repeat this check with a materialized project open, ideally in an environment
with folder access, to close that gap.

Both servers were stopped (`lsof -ti:3000/4012 -sTCP:LISTEN | xargs kill`)
after verification.

### Session 05 — Atomic live run-session extraction

**Goal:** Move the interlocked coordinator/transport/trace subsystem to one
owner.

1. Add `run-session-state.client.ts` with direct unit tests.
2. Add `use-run-session.client.ts`.
3. Move the coordinator, abort, generation, run-state, active-request,
   diagnostic, tool-result, trace-storage, trace-workspace, persisted-run, and
   provenance state together.
4. Move `executeProviderTurn`, start, continue, retry, stop, trace creation and
   autosave, export/import, and loaded-trace adoption.
5. Preserve the ordering invariants:
   - invalidate the generation before aborting/replacing an old request;
   - ignore events from stale generations;
   - install the coordinator before the first rendered run state;
   - snapshot the project workspace at run start;
   - save a terminal trace at most once per run ID;
   - never autosave an imported trace back over its source;
   - clear active state only for the generation that owns it; and
   - retain all prior attempts when retrying.
6. Keep history reading outside the hook; pass the read trace to
   `runSession.adoptTrace`.
7. Keep project/template/profile mutations outside the hook.

**Focused tests:**

- retryability classification for protocol, 408, 429, 5xx, and non-retryable
  failures;
- manual and mock default tool-result drafts;
- tool-result construction preserves call IDs and resolution metadata;
- stale generation events cannot replace current state;
- retry reuses resolved input and increments attempt/exchange identity;
- terminal trace eligibility and branch provenance;
- duplicate terminal notifications do not produce duplicate save requests; and
- imported trace origin prevents automatic overwrite.

Where a pure test cannot exercise the hook wiring, add a deterministic local
fixture or an SSR assertion rather than importing a Tauri-connected module
into `node --test`.

**Running-app checks:**

- basic completion with the echo fixture;
- first-attempt 503 followed by successful retry with
  `scripts/flaky-openai-provider.mjs`; verify its log says the request bodies
  match;
- stop a paced response and verify no later chunks update the output;
- a deterministic tool-call fixture covering waiting, manual/mock result
  submission, and continuation;
- diagnostics export with credentials redacted;
- terminal trace export and re-import; and
- project trace autosave/history reopen where folder access is available.

**Exit condition:** `page.tsx` contains no `RunCoordinator`, abort controller,
request-generation counter, diagnostic capture ref, persisted-run set,
trace-workspace ref, or provider-turn loop.

### Session 06 — Composition cleanup and end-to-end verification

**Goal:** Finish with a coherent route rather than a mechanically smaller one.

1. Remove obsolete imports, duplicate adapters, and comments tied to old
   locations.
2. Review every remaining page-local state value and inner function against
   the composition-root rule. Keep small view state; move only a clearly
   cohesive leftover concern.
3. Check that feature modules expose narrow named types and do not leak
   portable project or provider-specific representations across the wrong
   boundary.
4. Update this document with final file/line counts and any approved deviations.
5. Run the complete verification loop:
   - `npm run lint`
   - `npx tsc -p tsconfig.json --noEmit`
   - `npm run typecheck:core`
   - `npm test`
   - `npm run check:rust` if no environment limitation prevents it
6. Repeat the running-app matrix from Sessions 02, 03, and 05. Assert on
   rendered text and scan the rendered document for `NaN`, `Infinity`, and
   `undefined`.
7. Stop every fixture and dev server.

**Exit condition:** The acceptance criteria below are met and the final handoff
states exactly what was run, what was skipped, and why.

## Acceptance criteria

- `page.tsx` visibly reads as composition plus narrow cross-feature adapters.
- Template state and mutation workflows have one named owner.
- The request JSX is behind one feature component.
- Run preparation is pure and separately tested.
- The coordinator, abort controller, and generation counter have one owner.
- Run-session code remains provider-neutral and project-schema-agnostic.
- No persistence or provider contract changes are hidden in the refactor.
- `AGENTS.md` contains the composition-root guardrail.
- Each extraction has direct pure tests and/or focused SSR tests.
- The full automated suite passes.
- Deterministic running-app checks cover templates, branching, retry,
  cancellation, tool continuation, diagnostics, and trace handling.

The final line count is evidence, not the goal. If the page remains above the
expected range but every remaining responsibility is genuinely top-level
composition, document that result instead of forcing another abstraction.

## Known hazards from the previous refactor

- `credential.prepare` must exist before model discovery reads it during
  render.
- Do not create a local `credential` declaration that collides with the
  connection handle and triggers a temporal-dead-zone failure.
- Tests run with `node --experimental-strip-types`; imports reachable from
  TypeScript tests need explicit `.ts` extensions.
- Do not pull `@tauri-apps/api` into the Node test graph. Keep pure policy in
  test-safe modules.
- Preserve hydration-safe initialization for the randomized first prompt,
  tool registry, and markdown preference.
- Audit source files for literal NUL bytes after scripted edits involving
  `\u0000`.
- Keep refactor changes separate from behavior changes so failures have a
  meaningful baseline.
