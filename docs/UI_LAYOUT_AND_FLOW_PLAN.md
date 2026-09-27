# Layout and flow improvement plan

**Status:** proposed; no product implementation authorized by this document.  
**Baseline:** `main` at `950f76d`, reviewed September 21, 2026.  
**Scope:** workspace hierarchy, layout, navigation, and task completion after the recent UI/UX fixes.

## Direction

Give each task enough room and an explicit next step: **write a request → run → inspect → revise**, **author a prompt → use it → return to its source**, and **edit evaluation cases → review inputs → execute → investigate failures**.

We’re prioritizing desktop window sizing. Start with full-width prompt authoring and clear edit/use/return flows, then Runs browsing and inspection, desktop evaluation layout, and keyboard efficiency. Mobile layout is deferred.

This plan builds on the [earlier workflow review](reviews/UI_UX_WORKFLOW_REVIEW_2026-09-21.md), but its screenshots and browser observations are from the current baseline. Prior findings are not assumed to remain open.

## What the recent fixes establish

The current browser scenarios confirm direct saved-prompt insertion, exact resolved input reaching the fixture provider, pre-connection prompt drafts, guarded project replacement, clearer folder/JSON save language, authoritative project connection selection, and current-response/history entry points in Runs. Preserve those gains.

In particular:

- Do not propose an insertion picker as new work; it already exists in Messages.
- Do not describe Runs as empty after an ordinary request; it now offers **View current response**. The remaining opportunity is to inspect there without a detour.
- **Run current conversation** is now explicit about what it sends. The remaining issue is its placement while authoring a different object.
- Keep immutable revisions, deliberate pin updates, project-owned prompts, device-local mappings and credentials, and explicit tool execution grants.

## Evidence and opportunities

Observed means reproduced or visually inspected during this review. Proposed means an expert recommendation, not a measured user preference. Scale concerns below remain hypotheses until tested with larger fixtures.

| ID | Current evidence | Improvement | Priority |
| --- | --- | --- | --- |
| L1 | Prompts remains a tab inside the request half of Compose; the other half can be idle output. At 390px the 140px prompt rail remains beside the editor, and revision controls overlap the rail. | Give prompt authoring its own full-width workspace and narrow list/detail navigation. | First |
| L2 | At 880px and 390px the evaluation provider preview occupies most of the captured workspace, leaving little or no visible case editor. Desktop case editing already has useful hierarchy. | Make preview optional at constrained widths and give the case editor the main scroll region. | After prompt and Runs workflows; mobile deferred |
| L3 | Runs now finds the ordinary response, but sends the user to Compose to read it. Saved history opens as a drawer over a destination screen. | Put the history list and selected evidence in Runs, sharing the existing response renderer. | Next |
| L4 | The small-screen header reduces connection/project/run-data controls to compact symbols; three navigation levels precede prompt content. | Keep project/target context readable and reduce navigation levels for authoring. | Desktop context alongside layout work; mobile deferred |
| L5 | Authoring shows revision metadata, evaluation, archive, and n8n actions above or beside content; the request-level Repeat action remains visible. | Establish a clear action hierarchy for the object being edited. | Alongside L1 |
| L6 | Current characterization reproduces menus staying open on Escape and tool-library focus remaining outside the dialog. Tool copy also attaches the copy. | Establish predictable overlay/return behavior and explicit tool attachment steps. | Separate supporting slice |

Current screenshots: [desktop prompts](reviews/layout-flow-2026-09-21-evidence/prompts-desktop.png), [390px prompts](reviews/layout-flow-2026-09-21-evidence/prompts-narrow.png), [880px evaluations](reviews/layout-flow-2026-09-21-evidence/evaluations-medium.png), [390px evaluations](reviews/layout-flow-2026-09-21-evidence/evaluations-narrow.png), [desktop evaluations](reviews/layout-flow-2026-09-21-evidence/evaluations-desktop.png), [Runs with history](reviews/layout-flow-2026-09-21-evidence/runs-history.png).

## 1. Give prompt authoring a workspace

### Proposed layout

Desktop: a bounded, searchable prompt list beside a flexible editor. The editor starts with prompt name, revision/draft state, and contextual actions; content follows immediately. Variables/defaults follow content. Recommended target, revision comparison, provenance, archive, and specialized import actions move into secondary sections or menus.

**Deferred mobile layout:** show either the list or the selected editor. **Back to prompts** restores search, selection, and scroll position. Do not squeeze a persistent rail beside the content. Preserve the draft when switching widths or destinations.

Promote **Use in request…** and **Create revision** near the editor title. A dirty draft retains the existing atomic create-revision-and-add behavior with an honest action label. Historical revisions remain clearly labeled and insert the exact revision selected. Keep **Evaluate in a suite…** available as a secondary action. Avoid placing ordinary request execution and Repeat beside prompt authoring.

### Proposed flow

1. From Messages, use the existing **Insert saved prompt…** picker for routine reuse.
2. From a pinned prompt use, offer **Edit source** that opens the source prompt with an explicit return target.
3. On return, preserve request order, variable overrides, and the original pin. Creating a new source revision does not silently update existing uses.
4. Offer deliberate **Review latest / Update this use** when a newer revision exists.
5. From authoring, **Use in request…** discloses insertion position and the selected revision. Preserve existing empty-draft replacement behavior; a nonempty request is never silently replaced.

**Decision before implementation:** a new top-level **Prompts** destination versus a full-width subview reached inside Compose. A top-level destination makes the library easy to find and gives actions a clear owner, but adds a mode. A Compose subview is a smaller navigation change but needs a strong back path and tab-specific action behavior. **Recommendation: a top-level Prompts destination**, keeping insertion in Messages. Confirm this before changing `AppMode` or navigation contracts. A separate “Try prompt” scratch request is out of scope until its retention and replacement rules are designed.

**Acceptance:** at desktop window widths of 880/1280/1440px, the editor remains usable and authoring does not reserve half the screen for unrelated output. The 390px list/detail criteria are deferred. A keyboard user can edit source and return to the invoking use. Draft text, revision selection, run values, and pins survive every transition. Tests assert the exact revision and input sent, not just that navigation occurred.

## 2. Turn Runs into a browse-and-inspect workspace

The recent discovery fix is a useful bridge. Evolve its destination cards into a persistent list with type filters and a selected-detail area. Reuse the existing history model and response/trace components rather than building a second implementation of evidence rendering.

Desktop: list on the left; ordinary response, batch summary, or comparison in the main area. Opening a batch member provides a breadcrumb such as **Runs / Triage checks / Simple response** and a clear return to the batch. Deferred mobile layout: list/detail navigation, rather than vertically dividing the viewport into two small scroll regions.

Rows should emphasize recognition: request excerpt or suite name, target/model, time, outcome, and **Current session / Saved to folder**. Trace filenames and identifiers belong in details. Derive excerpts from existing evidence where practical; persistent user-defined run names would need a separate format decision.

Browsing historical evidence should be read-only. **Branch from this run** is an explicit handoff to Compose and uses the existing provenance/parent-trace rules. Merely selecting a result must not replace the current request draft or create a provider call.

**Decisions before implementation:**

- **History retention:** all session runs requires a bounded memory policy and lifecycle rules. **Recommendation:** first expose the latest in-memory ordinary result plus existing folder history; do not imply older unsaved results can be recovered. Broader session history is a later decision.
- **Viewing versus adopting:** inspect in Runs with a distinct selected evidence identity, versus continue adopting the selected trace into Compose. **Recommendation:** independent inspection selection, with explicit branching. Define its interaction with live execution and project switching before coding.
- **Selection precedence:** current `RunsMode` prioritizes evaluation, then repeated execution, then comparison. **Recommendation:** explicit user selection should choose what is shown; a new execution can select its own result, but a background completion should not unexpectedly replace an item the user is inspecting.

**Acceptance:** ordinary, repeated, evaluation, and comparison evidence can be found and read in Runs; list filters/scroll survive detail/back; selecting historical evidence leaves draft content unchanged. Current and saved representations of the same run appear once, identified by stable run identity. Missing trace files have a recoverable state. Live progress and Stop remain available while inspecting older evidence.

## 3. Let evaluation editing own the available space

Keep the successful desktop structure: suite list → setup/cases → optional provider input. Preserve the shared execution settings UI, configuration inheritance, pinned input revision, and saved evidence section.

Prioritize adjustable desktop pane widths and optional provider preview. In constrained desktop windows, use a suite chooser and an **Edit / Provider input** switch inside the selected suite. Edit is the default on first entry; preview opens deliberately and returns to the same case and field. At intermediate widths, first remove the preview column, then collapse the suite rail if the case editor still lacks usable width. Do not just stack three independently scrolling columns inside a fixed-height workspace.

Within Edit, use one primary vertical scroll region when the desktop window cannot support independent panes. Setup is an expandable summary above cases. Case values and checks stay together; configuration details and past executions remain secondary. On desktop, bounded list/editor scroll regions can remain where they help large collections.

Keep the preflight flow. Show the selected cases × configurations × repetitions, resolved targets, persistence destination, and blockers together before execution. After completion, land in results with an explicit **Back to editing [suite]** path. Opening an individual trace must preserve the result filters and selected case on return.

**Decision:** preview may default closed below a content-driven breakpoint, or remember a per-device preference. **Recommendation:** responsive default with an explicit user override for the current workspace session; do not write layout preferences into the portable suite. Exact breakpoints should follow measured usable editor width, not only device names.

**Acceptance:** at an 880px desktop window width, cases and their editable controls are reachable without first scrolling through provider evidence. Mobile-specific 320/390px work is deferred. Opening preview does not reset the case, setup state, or edits. At 1280/1440px, hiding preview gives the editor the released width. Include a 720px-tall viewport and 200% zoom; a 900px-tall screenshot alone is insufficient.

## 4. Make context and next actions predictable

### Compose and the global header

Keep the useful request/response split while composing. Put model, connection scope, and run settings in a compact summary near the request; retain the authoritative project mapping behavior. Keep a readable project/storage identity in constrained desktop windows, with details available on demand. Do not compress all meaning into dots and ellipsis buttons.

The global shell owns project identity, destination navigation, and active-work status/Stop. Each workspace owns the action that starts its task. If execution moves into Compose, keep its keyboard command aligned with the active workspace; prompt-authoring shortcuts must not run a hidden conversation. Do not automatically change split widths when a response arrives, which would move the editor under the user.

### Tools and overlays

Separate the concepts **available definition**, **attached to this request**, and **response behavior** in the tool surface. Summarize attachment, manual/mock/command response source, and approval behavior before execution. Decide whether library copying should merely copy or explicitly copy-and-attach; the current label conceals that consequence. Recommendation: separate copy and attachment, with a direct explicit attach action when requested.

Use a shared overlay interaction contract: one header menu at a time, Escape/outside dismissal, deliberate initial focus, appropriate modal focus containment, and restoration to the invoking control. Specify whether Connections/history are modal or nonmodal drawers before sharing a primitive. Add keyboard resizing or equivalent layout presets for request/response and trace dividers.

These are supporting improvements, not a reason to hold the primary layout work until every control has been rewritten.

## Ownership and contracts

The names below describe proposed responsibilities, not committed new APIs. Resolve consequential choices with the user before implementation. `page.tsx` should compose owners and explicit cross-feature adapters.

| Owner | Responsibility and contract | Boundary |
| --- | --- | --- |
| Prompt workspace; existing `useProjectTemplates` | Own library navigation and authoring presentation; expose explicit insert/evaluate handoffs with template/revision IDs and a return target. | Keep durable draft/revision mutations with the existing template owner. Session prompts remain distinct from project prompts. |
| Request composer | Own insertion position, focus after insertion, request editing, and return to a specific template use. | Do not duplicate prompt drafts or apply source revisions implicitly. |
| Evaluation workspace | Own suite/case navigation, setup disclosure, preview state, and editor return position. | State must survive mode unmounts through a stable owner, not be lost in a remounted view. |
| Runs navigation owner | Own selected evidence and list/detail return state across ordinary runs, experiments, comparisons, and live work. | Use a typed selection union keyed by existing IDs; selection is not the running execution. Agree missing/deleted-selection behavior. |
| Existing history and execution owners | Load evidence, manage live executions, persist traces, expose status. | Presentation does not create a new evidence store or mutate historical traces. |
| Shell/overlay primitives | Compose destinations, readable context, active-work controls, focus/dismissal behavior. | Provider-specific payloads remain in request/trace inspectors; navigation stays provider-neutral. |

Initial layout work should require no project, trace, or experiment schema change. Device layout state is not portable project content. If broader retention, persistent labels, new prompt ownership, or URL-addressable navigation is introduced, design serialization/migration and compatibility separately. Return targets should use stable IDs with a fallback if the source disappears, rather than storing component instances or stale object snapshots.

## Delivery sequence

Each slice should be independently reviewable. These are proposed priorities, not time estimates.

| Slice | Deliverable | Dependencies / gate |
| --- | --- | --- |
| A | Dedicated full-width prompt workspace, authoring action hierarchy, and edit/use/return flows. | Agree top-level destination versus Compose subview and return-target contract. Preserve insertion regressions. |
| B | Read-only Runs list/detail with current result plus folder history, explicit branch handoff. | Agree retention scope, inspection identity, and live/background selection behavior. |
| C | Desktop evaluation layout: adjustable pane widths, optional preview, and usable case/check editing space. | Agree preview behavior; validate laptop, short, and side-by-side desktop windows. |
| D | Keyboard efficiency, header/action placement, overlay behavior, tool attachment clarity, and keyboard resizing. | Apply shared focus rules during A–C; agree tool mutation contract before changing behavior. |
| E | Larger-collection and task validation, then targeted polish. | Test dozens of prompts, many suites/cases, and mixed history; use observed bottlenecks to decide search/filter refinements. |
| Deferred | Mobile prompt/suite/history list/detail navigation and 320/390px layout polish. | Revisit after desktop workflow priorities. |

For regression fixes, write the desired-behavior test before the fix and run it red for the actual incorrect geometry/value/transition. Existing characterization tests that intentionally assert friction must be updated when that behavior changes. Do not manufacture a red run through a selector failure.

## Verification plan for implementation

Use the committed runner and shared drivers. Run affected specs while iterating, then the full browser suite once before handing back a user-visible change, as required by `AGENTS.md`.

| Task | Browser evidence required | Existing starting points |
| --- | --- | --- |
| Author and reuse prompt | Fresh session, dirty draft, historical revision, filled variables, source/back, explicit pin update; assert exact sent input. | `first-use-prompt-authoring`, `prompt-draft-retention`, `prompt-insertion-handoff`, `saved-prompt-revision-diff`, `template-update-latest` |
| Edit and run evaluation | Edit case, switch preview and back, resize, execute preflight, inspect result/trace, return to same suite/case. | `evaluation-preview-pane`, `evaluation-setup-disclosure`, `evaluation-suite-authoring`, `evaluation-results-dismissal` |
| Browse evidence while editing | Ordinary/current and saved traces, repeated runs, evaluation and comparison; preserve draft and list selection; no request on browse. | `runs-result-discovery`, `experiment-history`, `evaluation-suite-history`, `evaluation-baseline-comparison` |
| Navigate and recover | Keyboard-only overlays, focus return, disabled reasons, failed save, project replacement, active run/Stop. | `modal-command-scope`, `mode-navigation`, `mode-primary-action`, `project-replacement-guard`, `project-storage-clarity` |

Spec names above are filenames under `tests/e2e/` with `.spec.ts`; they are starting points, not claims that they already cover the proposed acceptance criteria.

Prioritize desktop window sizing at 880/1280/1440px widths, a short desktop height, side-by-side windows, zoom, both themes, long titles and errors, empty/loading/failed states, and larger collections. Defer mobile-specific 320/390px acceptance checks. Assert usable element bounds, overlap, focus, scroll reachability, and preserved values alongside screenshots. “No horizontal page overflow” does not prove that an editor is usable.

Proposed usability check after each slice: ask a person unfamiliar with the changes to reuse a prompt, edit its source, run it, find an older result, and return to unfinished work. Record wrong turns and whether help was needed. No click-count or timing improvement is claimed until measured.

## Review performed and limits

This planning pass read current shell, composer, prompt, evaluation, Runs, history, and layout code, and ran:

```sh
npm run test:e2e -- tests/e2e/ui-ux-audit.spec.ts tests/e2e/ui-ux-workflow-review.spec.ts --workers=2
```

**11 passed.** The existing scenarios drove Chromium against the runner-managed local fixtures. The layout scenario captured 320/390/880/1280/1440px at 900px height; visual inspection for this plan focused on desktop prompts/Compose/evaluations/results/history, 390px prompts/evaluations, and 880px evaluations. The six retained screenshots above were copied from this fresh run, not the earlier report. Request evidence assertions exercised a real loopback provider. Folder behavior used the committed in-memory directory stub.

Passing characterization scenarios reproduce behavior; they do not declare the layout good. The run emitted duplicate React-key warnings for `evaluation-suite_audit`; investigate separately before inferring any resulting UI defect.

No product code or tests changed. The full browser suite, build, unit, and Rust checks were not run for this documentation-only change. No new red-to-green regression cycle was performed. Native Tauri, real filesystem permissions/restart, screen readers, other browsers, large collections, 200% zoom, short-height layouts, and hosted providers were not checked in this pass. Dark-mode captures were produced by the existing scenario but not used to establish new visual findings here.

Most useful user review now: choose whether Prompts should become a top-level destination, confirm whether Runs should inspect without changing Compose, and try the proposed edit/source/back sequence against a familiar project. Those decisions materially shape the next implementation; this document leaves them open.
