# UI/UX re-audit of the current application

**Reviewed:** September 20, 2026 · **Repository baseline:** `77a5f22` plus the current prompt-draft-retention working-tree changes
**Compared with:** [UI/UX usability review and proposed implementation plan](UI_UX_REVIEW_2026-09-20.md), whose declared source baseline is `50f48b7`
**Scope:** Reassess which earlier findings still describe the product, identify the current priorities, and preserve the original review as a historical record. Assessment only; no product behavior was changed for this re-audit.

## Assessment

The original report is now most misleading where it describes prompt authoring as lossy and evaluation authoring as an undifferentiated collection of controls. Prompt drafts, named immutable revisions, exact historical-revision insertion, pinned revision labels, focus-mode editing, editable evaluation titles, and a more coherent desktop evaluation setup all arrived after its stated baseline. Two of its P1 findings have been fixed, and the current working tree completes the intended Save-shortcut behavior for a third.

The remaining reliability problems are concentrated at the boundaries between local state and portable project state:

1. **Prompt creation still crashes in a fresh, unconfigured session.** Authoring unnecessarily depends on having an executable project target.
2. **A failed runtime-status probe still mutates managed connection identity.** Recovery can create two indistinguishable `Server default` profiles.
3. **Selecting a local connection still conflicts with the project's saved mapping.** The UI simultaneously presents the new profile as selected and the old profile as mapped.
4. **The mobile authoring layouts remain materially unusable.** At 390 CSS pixels the prompt rail overlaps the editor, and evaluation provider input displaces the actual editing task below the fold.
5. **Tool attachment, run browsing, and prompt reuse still follow implementation boundaries rather than the user's task.** These are no longer the highest data-integrity risks, but they continue to make correct behavior difficult to predict.

This changes the recommended order from the earlier audit. Do not lead with a broad prompt-versioning redesign: the current versioning contract is substantially better and should be preserved. Repair first-use authoring and server-profile reconciliation first, then make connection mapping and responsive ownership coherent, and only then consolidate the larger reuse and results workflows.

## How this re-audit was performed

This is a task-based expert review, not a measured usability study.

| Area | Review coverage |
| --- | --- |
| Change history | Compared `50f48b7..77a5f22`, including prompt autosave/revisions, project isolation, evaluation authoring/reassessment, and the audit-driven insertion/shortcut fixes. |
| Current working tree | Included the existing uncommitted prompt editor Save-shortcut change and its regression spec. Those changes were inspected and exercised, not authored by this review. |
| Earlier findings | Re-ran the retained characterization scenarios for first use, server reconciliation, tool copying, connection mapping, menus/dialogs, run discovery, tool continuation, and responsive layouts. |
| Prompt reliability | Exercised exact draft retention across tabs and modes and the focused editor's Cmd/Ctrl+S behavior. |
| Visual layout | Inspected current captures at 1440, 1280, 880, 390, and 320 CSS pixels for prompts and evaluations, plus current connection, tool, Runs, and evaluation-results states. |
| Source contracts | Reviewed the current prompt insertion, draft persistence, run readiness, server-default reconciliation, topbar menu, and Runs-mode implementations. |

All browser work used disposable contexts, synthetic projects, and the committed loopback provider fixtures. No real provider, credential, n8n account, native credential store, or user project was inspected.

## What is outdated in the earlier audit

The disposition below evaluates the earlier finding as written. **Resolved** means its reproduced defect no longer occurs. **Superseded** means the product has materially changed and the old analysis should not guide implementation unchanged. **Current** means the retained scenario still reproduces. **Partial** means an important part improved while the underlying usability issue remains.

| Earlier finding | Disposition | Current evidence |
| --- | --- | --- |
| F01 · Prompt drafts can disappear after a successful project Save | **Superseded; resolved in the reviewed working tree** | Prompt edits now create an autosaved project draft or a clearly labeled session draft. Drafts survive request-tab and app-mode navigation. The focused editor's Cmd/Ctrl+S creates the visible revision in the current working tree instead of invoking project Save. |
| F02 · Historical revision insertion uses the latest revision | **Resolved** | Insertion now carries an explicit template revision ID. Historical actions are labeled `Use Revision …`, and pinned cards display the selected revision. Covered by the saved-prompt revision regression suite. |
| F03 · Runtime-status failure duplicates `Server default` | **Current** | Both confirmed removal and an HTTP 503 still strip the managed credential reference; recovery then creates a second profile with the same visible name. Both retained scenarios passed as characterizations of the defect. |
| F04 · Run shortcut operates behind the tool-library modal | **Resolved** | Global run dispatch now checks the standard modal boundary. The dedicated modal command-scope regression covers the tool library and import dialogs. |
| F05 · First-use prompt creation fails | **Current** | `New prompt` in a fresh session still raises `ProjectValidationError` because an empty endpoint/model is materialized as a valid portable project before authoring can begin. |
| F06 · Prompt reuse is organized around the library | **Current, with safer revision handling** | `Add to conversation` now has correct revision semantics and dirty drafts can be saved-and-added atomically. Reuse still requires leaving Messages for Prompts; Messages still has no `Insert saved prompt…`, and a pinned use still has no direct `Edit source` action. |
| F07 · Tool creation, attachment, and execution are scattered | **Current** | `Copy to project` still saves a library definition, copies it, and attaches it. On a profile without tool calling, this immediately blocks Run and repeats the capability warning across the request and response surfaces. |
| F08 · A project can be both mapped and “not connected” | **Current** | Selecting profile B while the project remains mapped to A produces the same contradictory presentation. `Map “B”` still opens the mapping surface rather than performing the action its label states. |
| F09 · Connection/model scope is difficult to infer | **Current** | The topbar profile, project requirement, suite target, model, and delivery controls still have different persistence and execution scopes. The missing-model detail still says `Choose one in Connections` even though its primary action routes to request settings. |
| F10 · Runs is not where ordinary runs are found | **Current** | After a successful Compose run, Runs still says `No results open`; ordinary history remains under `Run data → Run history…`, and the empty state offers only `Go to Evaluations`. |
| F11 · Project durability is too implicit | **Partial** | The header now exposes an `Unsaved` state, and prompt draft copy distinguishes project autosave, session retention, and failure. Folder-backed versus imported/in-memory durability and the disabled history path are still not summarized as a stable project state. |
| F12 · Authoring wastes desktop space and is cramped on mobile | **Partial** | Prompt focus mode and compact editable titles improve focused desktop work. The normal prompt editor still shares the screen with an unrelated empty response pane, while the 390px layout visibly overlaps the prompt rail and editor. Evaluation provider input still dominates the top of the narrow layout. |
| F13 · Menus and dialogs lack predictable keyboard behavior | **Partial** | Background shortcuts are now scoped away from modals. Escape still leaves the Project menu open, Project and Run data menus can overlap, and opening the tool library still leaves focus outside the dialog. |
| F14 · Labels expose implementation concepts or wrong destinations | **Current** | `Map`, prompt/tool `Detach`, `Once`, `Expand`, and the missing-model destination remain as documented. Revision labels are a meaningful exception: they now communicate the pinned immutable revision. |
| F15 · Evaluation setup needs a task-oriented sequence | **Partially superseded** | Desktop setup now has a clear readiness summary, Setup/Configurations/Dataset/Evidence regions, editable titles, and a concrete provider-input preview. It is a substantial improvement. Narrow-screen ordering and the connection/configuration vocabulary still make the workflow harder than necessary. |

## Current findings

**P1** means an ordinary path crashes, corrupts identity, loses work, or performs the wrong action. **P2** means a recurring obstacle to understanding or completing a task. **P3** means polish or a lower-confidence follow-up. Priorities describe the current build, not the earlier report.

### R01 · P1 · First-use prompt authoring still requires a valid run target

**Reproduced.** In a fresh browser context, open Prompts and click **New prompt** before configuring an endpoint or model. The action attempts to create a portable project and raises `ProjectValidationError` for the invalid endpoint and empty model.

The problem is not prompt validation. It is ownership: a reusable text draft is being forced through the executable-project boundary before it needs provider configuration.

**Recommendation:** allow a retained local authoring draft before a valid project exists, then materialize or attach it when the user deliberately saves to a project. A smaller safe alternative is to replace the enabled action with an explicit setup route, but that preserves an unnecessary dependency between writing and credentials.

**Acceptance:** a user can begin authoring in a fresh session without an endpoint, model, or API key; no uncaught error occurs; the UI states whether the draft is session-only or project-backed; creating the eventual portable project still enforces its endpoint/model schema.

Source: `createProjectTemplate` in [use-project-templates.client.ts](../../app/templates/use-project-templates.client.ts), `materializeProject` in [use-project-workspace.client.ts](../../app/use-project-workspace.client.ts), and the retained `fresh setup` browser scenario.

### R02 · P1 · Runtime-status uncertainty still destroys managed-profile provenance

**Reproduced.** Start with a configured server default, reload while `/api/runtime-status` returns 503, and reload after it recovers. The profile list ends with two distinct local records both named **Server default**. Confirmed configuration removal followed by restoration reaches the same state.

The probe currently collapses three states—configured, confirmed absent, and unknown/unreachable—into a boolean-like result. On unknown it removes the only durable marker that identifies the managed profile. Recovery therefore cannot reconcile the same identity.

**Recommendation:** model runtime status as a discriminated state such as `configured | absent | unavailable`, and keep managed provenance independent from current credential availability. Only a confirmed `absent` result may release the credential binding. A retained former managed profile needs an explicit visible state and a deliberate cleanup/remapping action.

**Acceptance:** a failed or malformed status response followed by recovery preserves profile count, record identity, project mappings, and credential-mode preference; a confirmed removal is visibly different from an outage; equal labels or endpoints are never used as credential identity.

Source: `reconcileServerDefaultProfile` in [use-connection-profiles.client.ts](../../app/use-connection-profiles.client.ts) and both retained server-default browser scenarios.

### R03 · P2 · Active-profile selection and project mapping still form a contradictory target control

**Reproduced.** A project mapped to Local model A becomes blocked after Local model B is selected in the topbar. The topbar identifies B as the active connection, the blocker says the project is not connected, and the Connections drawer says the project is mapped while showing A in its mapping control.

**Recommendation:** make the contextual target control display the full resolved relationship: project requirement, mapped local profile, endpoint match, and model. Selecting another profile should offer explicit choices to use it for this requirement or return to the mapped profile. Editing a saved profile and choosing what a project uses should not be the same selection gesture.

**Acceptance:** every visible target summary agrees on the profile that will be used; remapping names its project/device scope and affected consumers; `Map B` either performs that exact operation or is relabeled as navigation.

Source: `chooseProfile` composition in [page.tsx](../../app/page.tsx), [run-readiness.client.ts](../../app/run-readiness.client.ts), [connection-drawer.client.tsx](../../app/connection-drawer.client.tsx), and the retained two-profile browser scenario.

### R04 · P2 · Narrow prompt and evaluation layouts do not preserve the primary task

**Visually reproduced.** At 390 CSS pixels, the fixed prompt list/rail remains beside the editor and overlaps the revision-name controls and prompt identity. At 320–390 pixels the available text-editing width is not credible for authoring. In Evaluations, the provider-input preview appears before the suite editor and consumes most of the initial viewport; the user must pass inspection detail before reaching setup and cases.

Avoid treating “no horizontal page overflow” as success. The current layouts technically reflow while obscuring or displacing the controls that own the task.

**Recommendation:** below a deliberate breakpoint, make prompt list and prompt detail separate views with a clear back action. In Evaluations, default provider input to a summary/drawer on narrow screens and keep Setup/Dataset first. Preserve selected prompt, revision, draft, suite, case, and scroll intent across the transition.

**Acceptance:** at 320 and 390 CSS pixels, no rail or control overlaps content; the primary editor receives the viewport width; prompt selection remains reachable; evaluation setup and the focused case appear before optional resolved-input detail.

Source: [project-templates-pane.client.tsx](../../app/project-templates-pane.client.tsx), the prompt/evaluation styles, and retained responsive captures at 1440/1280/880/390/320.

### R05 · P2 · Tool reuse still makes definition, attachment, capability, and execution policy look like one action

**Reproduced.** In the local library, **Copy to project** also saves the edited library definition and attaches the copy to requests. If the selected profile disallows tools, this new attachment immediately blocks Run. The screen then presents multiple calls to enable tool calling but still does not summarize whether calls will be answered manually, by a mock, or by a granted command.

**Recommendation:** separate **Copy to project** from **Copy and attach**, or rename the action to describe both effects. Give each attached tool a compact request-facing summary: included state, response source, and approval behavior. Keep schema editing and command grants behind explicit actions; attachment must never imply device execution authorization.

**Acceptance:** before Run, the user can answer which definitions will be sent, what will answer each call, and when a person will be asked; copying has no unstated attachment or save side effect; disabling tool capability points to one coherent resolution path.

Source: [tool-registry-modal.client.tsx](../../app/tool-registry-modal.client.tsx), [tools-pane.client.tsx](../../app/tools-pane.client.tsx), and the retained copy/attach and mock-continuation scenarios.

### R06 · P2 · Results navigation still excludes the most common meaning of “run”

**Reproduced.** A successful Compose request remains in the response surface. Moving to **Runs** produces **No results open** because the mode owns evaluation batches, repeated experiments, and comparisons, while ordinary run history lives in a topbar menu.

**Recommendation:** make Runs the browse-and-inspect home for ordinary, repeated, evaluation, and comparison results, with type and persistence status visible. If that consolidation is intentionally out of scope, rename the mode to the narrower concept and add direct **Open run history** and **View current response** actions to its empty state.

**Acceptance:** after any completed request, Runs either contains it or clearly routes to it without requiring knowledge of trace storage; session-only and folder-saved results are distinguishable.

Source: [runs-mode.client.tsx](../../app/modes/runs-mode.client.tsx), [topbar.client.tsx](../../app/topbar.client.tsx), and the retained completed-run scenario.

### R07 · P2 · Prompt reuse is safe now, but still not direct

**Observed/source-confirmed.** The revised contract is good: selecting a historical revision and inserting it pins that exact immutable ID; dirty work can be atomically turned into a revision and inserted. The remaining problem is discoverability. Messages offers **Add message** and **Add tools**, but not **Insert saved prompt**. The insertion bar is at the bottom of the prompt authoring surface, after optional metadata and variables. A pinned prompt exposes revision, review-latest, detach, remove, and preview actions, but no direct source navigation.

**Recommendation:** add **Insert saved prompt…** beside the conversation actions, with search, revision, values, and position. Add **Edit source** to the pinned prompt card while preserving the request and exact revision. Consider **Save as reusable prompt…** from authored messages. Keep the existing immutable insertion and save-and-add contracts.

**Acceptance:** insert → fill → run → edit source → deliberately update can be completed without discovering the library tab or losing request context; every handoff continues to name the immutable revision.

Source: [request-composer.client.tsx](../../app/request/request-composer.client.tsx), [project-templates-pane.client.tsx](../../app/project-templates-pane.client.tsx), and [use-project-templates.client.ts](../../app/templates/use-project-templates.client.ts).

### R08 · P2 · Header menus and dialogs still lack one keyboard interaction contract

**Reproduced.** Escape does not close the Project menu. Opening Run data while Project is open leaves both menus layered. Opening the local tool library does not move focus into the modal. The new modal command scope correctly prevents background execution, but it does not supply focus placement, trapping, restoration, or menu dismissal.

**Recommendation:** replace independent native-details behavior with a shared menu owner and apply a shared dialog contract: one header menu at a time, Escape/outside-click dismissal, initial focus, contained modal tab order, and focus restoration. Add keyboard-equivalent resizing or a discrete layout alternative where pointer-only resizing is present.

**Acceptance:** keyboard users never land behind a modal, never encounter overlapping header menus, and can dismiss and return to the invoking control predictably. Background run/save commands remain suppressed while a modal owns attention.

Source: [topbar.client.tsx](../../app/topbar.client.tsx), [tool-registry-modal.client.tsx](../../app/tool-registry-modal.client.tsx), [keyboard-command-scope.client.ts](../../app/keyboard-command-scope.client.ts), and the retained menu/dialog scenario.

### R09 · P2 · Durability and settings scope are improved locally but not summarized globally

**Observed/source-confirmed.** The prompt editor now distinguishes `Draft autosaved`, session retention, and save failure; the project title exposes an `Unsaved` marker. The rest of the app still asks the user to infer whether a project is folder-backed, imported/in-memory, pending, or unable to provide history. Similarly, profile defaults, project settings, evaluation settings, prompt recommendations, and session-only values use related controls with different persistence scopes.

**Recommendation:** give the project header a stable durability state and relevant action: folder-backed/saved, pending, session-only, or failed. Place a concise `Used for this run · saved in …` scope cue beside contextual target/settings summaries rather than relying on implementation terms such as connection requirement. Correct labels whose destination or effect is inaccurate: `Choose one in Connections`, `Map`, prompt `Detach`, tool `Once`, and focus-mode `Expand`.

**Acceptance:** before closing or running, the user can identify what survives, where it is stored, which target will execute, and which settings are temporary without opening source-specific documentation.

Source: [topbar.client.tsx](../../app/topbar.client.tsx), [inference-settings-panel.client.tsx](../../app/inference-settings-panel.client.tsx), [run-readiness.client.ts](../../app/run-readiness.client.ts), and current prompt draft copy.

### R10 · P3 · Evaluation desktop hierarchy is improved; responsive disclosure is now the main follow-up

**Visually observed.** At desktop width, the current evaluation surface has a credible task sequence: readiness, Setup, Configurations, Dataset, and Evidence, with resolved provider input kept in a dedicated inspector. Editable suite and case titles reduce form chrome, and results now provide a clear evidence path plus saved-output reassessment.

The remaining concern is not a wholesale setup redesign. It is progressive disclosure across width and scale: the narrow screen promotes provider input above editing, nested configuration detail still requires the user to understand inheritance, and small synthetic suites do not establish behavior with large case/configuration sets.

**Recommendation:** preserve the present desktop information architecture. On narrow screens, make Edit and Provider input peer views or use a drawer. In configuration rows, summarize the resolved connection/model/delivery first and explain inheritance on demand. Validate the layout with long names, multiple targets, and dozens of cases before changing the underlying suite schema.

**Acceptance:** the same evaluation can be authored at desktop and narrow widths without losing the focused case or navigating through inspection detail; inherited versus overridden settings are visible from the collapsed row; large suite navigation remains stable.

Source: [evaluation-suite-editor.client.tsx](../../app/evaluations/evaluation-suite-editor.client.tsx), evaluation surface styles, and the current responsive/evaluation-result captures.

## Design decisions to agree before implementation

The remaining P1 work crosses persistence and compatibility boundaries, so these decisions should be explicit before coding:

1. **Pre-project prompt ownership.** Recommended: a session-owned authoring draft that can later create or join a project. This keeps the portable project schema strict. The alternative—allowing incomplete portable projects—changes validation and compatibility for every reader and is not justified solely by first-use authoring.
2. **Managed connection provenance.** Recommended: persist provenance separately from current credential availability and model runtime status as `configured`, `absent`, or `unavailable`. Do not infer identity from a mutable name or endpoint and do not merge equal-looking profiles.
3. **Project target selection.** Recommended: project requirement mapping is the executable choice; profile editing is a separate operation. The topbar should present the resolved mapping in project context rather than a competing global selection.
4. **Runs taxonomy.** Recommended: `Runs` includes all run kinds and exposes persistence/type filters. If it remains batch-only, its public label must narrow accordingly.
5. **Responsive ownership.** Recommended: list/detail navigation owns prompt authoring below the breakpoint, and the evaluation editor owns the initial narrow viewport. Do not encode responsive behavior by duplicating draft state in separate mobile components.

## Proposed delivery order

| Phase | Work | Verification target |
| --- | --- | --- |
| 1 · Reliability | R01 pre-project authoring and R02 tri-state managed-profile reconciliation. | Red regressions for fresh-session New prompt and failed-status recovery, then focused green browser runs. |
| 2 · Target coherence | R03 contextual mapping and the target/scope portion of R09. | Two-profile project, multiple requirements/configurations, endpoint mismatch, missing credential, and model-selection routing. |
| 3 · Responsive ownership | R04 plus the narrow-screen portion of R10. | Assert geometry and task order at 320/390/880, not only absence of page overflow; visually inspect long names and large cases. |
| 4 · Direct workflows | R05 tool summary/actions and R07 contextual prompt insertion/source navigation. | Copy-only versus copy-and-attach; manual/mock/command policies; insert historical/draft prompt and return to source. |
| 5 · Navigation and durability | R06 Runs consolidation, R08 shared menu/dialog behavior, and the durability portion of R09. | Ordinary/repeated/evaluation history, session-versus-folder status, keyboard-only menu/modal traversal, and focus restoration. |

## Checks actually run and limits

Command run against the current working tree:

```sh
npm run test:e2e -- tests/e2e/ui-ux-audit.spec.ts tests/e2e/prompt-draft-retention.spec.ts --workers=2
```

Result: **10 passed**.

- Two prompt regressions passed: exact draft retention across request navigation, and focused Cmd/Ctrl+S creating the visible prompt revision.
- Eight retained audit scenarios passed as characterizations of current behavior: fresh-session failure, two server-default duplication paths, tool copy/attach, profile-selection/mapping conflict, tool mock continuation plus empty Runs, menu/dialog keyboard behavior, and responsive/evaluation capture.
- The fresh-session run emitted the expected `ProjectValidationError`; that is evidence for R01, not a clean error-free run.
- The responsive scenario emitted duplicate React-key warnings for `evaluation-suite_audit`. The fixture still completed and the visual assertions ran, but the warning was not isolated enough in this review to classify as a product finding.
- The first invocation was blocked because port 4300 was reported in use; no listener remained when checked, and an immediate clean rerun passed. This was test-environment noise, not treated as product evidence.
- The full Playwright, build, unit, Rust, native desktop, cross-browser, screen-reader, real filesystem-permission, real credential-store, and live provider/n8n paths were not run for this documentation-only review.

The most valuable product review before implementation is a short interactive decision session around the three consequential contracts: pre-project prompt ownership, tri-state managed-profile provenance, and whether Runs becomes the universal result browser. The responsive list/detail and inspector behavior can then be prototyped without changing persisted data.
