# UX simplification and discoverability plan

**Status:** partially implemented (slice A); remaining proposals require their recorded design gates.\
**Baseline:** `main` at `309f180`, October 26, 2026; refreshed against `52e789e` (0.6.0), October 28, 2026.\
**Scope:** composer efficiency, contextual actions, discoverability, clearer persistence language, and less day-to-day clutter.

## Direction and evidence

Make the next useful action obvious while keeping configuration compact. Use
saved assets where they are needed; open their management surfaces only when
editing or organizing them. Collapse editing machinery while preserving active
state, consequences, and problems.

This is a follow-on to the [layout and flow plan](UI_LAYOUT_AND_FLOW_PLAN.md),
not a restart of that work. Preserve the existing Compose / Prompts /
Evaluations / Runs destinations, collapsed run settings, composer focus mode,
readiness routing, and read-only historical inspection. Coordinate with the
saved-prompt insertion combobox/popover, now merged in PR #216
(`fce5077`); that picker is an implemented dependency and interaction reference.
Recheck the remaining recommendations against it before starting a slice; see
[`saved-prompt-picker.spec.ts`](../tests/e2e/saved-prompt-picker.spec.ts).

The preceding review inspected source and manually opened the local app's
initial composer, Tools view, and Evaluations empty state. It observed duplicate
**Add tool** / **Add project tool** actions and a project-required evaluation
empty state without a next-action button. Prompt-card recommendations came
from source inspection. Populated prompt cards, populated run inspection,
large collections, native Tauri, and assistive technologies were not visually
verified. These recommendations are design hypotheses, not measured usability
results. Recheck against the implementation baseline before each slice.

### October 28 refresh

Since the original baseline, these merged changes addressed parts of this plan
or the [saved-prompt and experiment review](reviews/saved-prompts-experiments-2026-10-26.md):

| PR | Effect on this plan |
| --- | --- |
| #224 | One **Attach tool** menu on the attached list replaced the duplicate add-tool controls, the library modal route, and the always-open MCP panel. Slice A's tool half and much of section 2 are delivered; see that section. |
| #219 | Review finding 1: evaluating an edited Chat draft now requires a revision and names the pinned revision. |
| #216, #212, #225 | Saved-prompt picker, Compose revision switching, and wide prompt dialogs. Section 3 builds on them. |
| #226, #227, #230 | Retry runs the edited request; **Edit from here** opens Compose and works from the keyboard. |
| #229 | **Copy Markdown** on live output and assistant messages. |
| #220, #222, #231 | Live elapsed time, tool editor styling, and pane/table containment. |

A browser tour of the 0.6.0 build (fixture provider, 1280×800 and 880×720,
light theme, no project folder, no saved prompts or tools) added the
observations behind sections 8–12. It used a throwaway Playwright script that
was not committed, ran on fallback Chromium 1243, and covered no populated
project, dark theme, zoom, or native Tauri.

- About 385px of a 800px-tall window precede the first message editor: the
  Request kind row, a **Request / Composer** heading, Messages/Tools tabs, the
  run-settings summary, the tool status line, and the toolbar.
- Every transcript message carries a bordered **Edit from here** button; at
  880px it wraps to two or three lines and crowds the message preview.
- The pending-branch notice names its parent run and message by raw IDs.
- The **Run trace not saved** notice repeats on every unsaved run in both
  Compose and Runs.
- Without a project folder, Runs holds one ordinary run, labelled
  “Not saved · replaced by the next run”.
- **Import prompt from n8n…** appears in both the Project menu and the Prompts
  sidebar, which stacks three full-width create/import buttons.
- The Evaluations empty state still has no next-action button.

Open issues touch the same surfaces: #208 (dialogs differ in Escape, focus
and scroll lock; **Promote to case** cannot be dismissed with Escape) and #204
(Decision Inspect cannot scroll on the narrow layout).

## Design rules

- Keep model identity, attachment counts, overrides, missing values, and run
  blockers readable while their editing controls are collapsed.
- Give every feature a labeled, stable home. Search and keyboard shortcuts are
  additional routes; hover-only controls and unnamed overflow icons are not
  sufficient discovery paths.
- Prefer contextual actions over duplicate global controls. Keep Stop visible
  whenever work is running, including after changing workspace modes.
- Preserve actual scope and lifetime. Hiding a control must not change what is
  saved, sent to a provider, attached, or permitted to execute.
- Avoid a global Basic/Advanced switch. Let individual sections disclose detail
  without making capabilities or active configuration disappear.
- Reuse feature owners and existing guards. The route composes owners and
  cross-feature adapters rather than accumulating picker or menu state.

The discovery principle is recognition over recall: users should be able to
recognize available actions without memorizing commands. See
[Nielsen Norman Group's explanation](https://www.nngroup.com/articles/recognition-and-recall/).

## 1. Direct model selection with compact run settings

**Recommendation:** keep the model combobox directly visible in the composer,
beside a labeled **Settings** control. Keep temperature, response mode, and
protocol controls in the disclosure. Its closed summary retains meaningful
configuration differences and problems without competing with the model name.
Reuse the existing model picker, favorites, discovery, and custom model entry.

**Options and decision gate:** opening all settings is the smallest change but
retains friction for model changes. A direct model picker adds one persistent
control but gives this frequent action a clear home. Recommend the latter.
Agree which settings always appear in the summary versus only when overridden;
protocol must remain identifiable, and unsupported values must remain visible
as problems rather than silently changing. Confirm treatment of Decision
Compose before extending a Chat-specific layout to it.

**Owner and contract:** `RequestComposer` owns presentation and focus;
`RequestSettings` and the existing settings owner supply the same effective
values, scope, inheritance, and mutation callbacks. Keep one authoritative
model input and preserve readiness routing to it. Adapt the shared inference
panel without duplicating model editing or changing evaluation settings.

**Acceptance:** change model without opening settings; keyboard selection and
custom entry work; opening settings preserves draft and focus context. Project
settings and profile defaults retain their existing mutation boundaries. A
fixture receives the selected model and unchanged protocol, temperature, and
response-mode values. Long model IDs and blocker text remain usable in a
constrained desktop window.

## 2. Attach tools through a searchable picker

**Status, October 28:** #224 delivered one attachment home (the **Next
request** list and its **Attach tool** menu), a single project/tab destination
choice, and the duplicate-control consolidation. Still open: search and
selected-first ordering for larger tool sets, and replacing the routine
composer tool line (see section 8). Re-scope this slice against the menu before
starting; a separate picker may no longer be warranted.

**Recommendation:** show a compact **Tools · 3** entry point in the composer,
with selected tools first in a searchable picker. Provide explicit **Create
tool**, **Browse library**, and **MCP servers** routes. Definition editing and
execution configuration remain in the tool management surface. Replace the
routine “No tools attached” sentence with this entry point; retain prominent
warnings when attached tools cannot reach the model.

Consolidate the duplicate add-tool controls as an independent small fix.

**Options and decision gate:** a picker can attach existing definitions only,
or combine attachment, authoring, discovery, and execution grants. Recommend
attachment first, with links into existing owners for the other tasks. Decide
whether the existing Tools tab stays as the management destination or becomes
a labeled **Manage tools** route before removing either navigation path.

The composer's Tools tab already lists project tools with attach toggles, and
the tool status line links to it. A picker that coexists with those toggles
gives attachment two homes. Weigh the cheaper alternative — improving the
existing tab's search and selected-first ordering — before committing to a
separate picker; the answer determines the size of slice C.

**Owner and contract:** a tool attachment feature owns search, selected-row
presentation, and focus. Existing draft, library, command-tool, and MCP owners
retain mutations and grants. Identify entries by stable tool/source identity,
not display name; distinguish project definitions from temporary tab snapshots.
Define whether selection applies immediately or on confirmation before coding;
immediate attachment with an explicit reversible detach is recommended for
existing definitions. It must not grant execution permission, silently copy a
library item into the project, or reorder already attached tools.

**Acceptance:** the count and selected rows describe exactly what the next
request includes; project versus tab lifetime remains visible. Search handles
duplicate names and no results. Removing an attachment does not delete its
definition. Existing manual, mock, command, and MCP behavior and approval rules
remain unchanged. Assert exact transmitted tool names and order, including
blocked-profile and temporary-tool cases.

## 3. Quieter inserted-prompt cards

**Recommendation:** emphasize prompt name, pinned revision, missing variables,
and effective values. Put **Edit source**, **Convert to editable messages**,
and **Remove** in a labeled **Prompt actions** menu. The longer conversion
label explains the existing Detach action. Keep variable issues and override
counts visible; retain access to prompt/resolved preview and revision review.

**Options and decision gate:** moving all three actions saves space but adds a
step to source editing. Keeping Edit source visible favors frequent authoring.
Start with the labeled menu and review a populated project before settling the
placement. Keep the existing conversion preflight: a copy change must not
suggest that unresolved prompts can always be converted successfully.

This section covers Chat prompt uses (`TemplateUseCard`). Decision Compose
also pins and detaches templates; decide whether it adopts the same action menu
and conversion wording or stays out of scope for this slice.

**Owner and contract:** `TemplateUseCard` owns local menu/preview presentation;
the template owner keeps revision selection, effective-value resolution,
source/return navigation, conversion, and removal. Opening a menu does not
mutate a use. A source edit or new revision never updates a pinned use
implicitly. Converting preserves the existing resolution and provenance rules.

**Acceptance:** missing inputs are discoverable without opening actions;
readiness focuses the exact variable. Source editing returns to the invoking
use with values, order, and revision pin intact. Revision changes remain
reviewable. Escape and action completion restore focus appropriately; removal
moves focus to a surviving neighbor or insertion control. Use the separately
implemented insertion popover's keyboard conventions where applicable.

## 4. Put run actions with the run they affect

**Recommendation:** make Runs the home for history and trace import, expose
export beside the selected evidence, and give diagnostics a labeled
troubleshooting home. Remove the separate global **Run data** menu only after
all its actions have a discoverable destination.

Consider moving **Repeat…** into an execution-options menu beside Run. It
currently appears in two places: the Messages toolbar and the composer header
on the other request tabs. Run remains a direct primary action; Stop
must never move into that menu. Continue and Retry remain beside the pause or
failure they resolve.

**Options and decision gate:** retaining Run data is a smaller change and keeps
cross-workspace access. Consolidating into Runs reduces header competition but
adds navigation for imports and diagnostics. Recommend consolidation only after
an action inventory identifies every destination and disabled-state explanation.
For Repeat, compare a visible secondary button with an adjacent labeled menu;
confirm discoverability before removing its current entry point.

The menu's **Run history** item opens the same destination as the Runs mode
button, so it can go first, independently of the rest of the inventory.

**Owner and contract:** Runs navigation owns selected evidence; trace/history
owners handle import/export. Explicitly distinguish exporting selected history
from exporting the current live run. Compose owns Repeat's target and readiness;
changing modes must not turn it into an action on a hidden or historical draft.
The shell owns global active-work status and Stop. Define diagnostics' home and
capture identity before moving the control.

**Acceptance:** every former menu action remains reachable with equivalent
guards. Export serializes the selected supported artifact, not a stale live
run. Unsupported artifact kinds explain their limitation. Browsing or importing
history preserves the current draft and causes no provider request. Repeat
still opens the existing review/configuration flow. Stop remains reachable
while composing, authoring prompts, evaluating, or inspecting history.

This proposal revisits the older plan's deliberate placement of Repeat in the
composer and Run data in the header. It is an explicit open design choice, not
an assumption that those earlier decisions were implementation mistakes.

## 5. Actionable empty states and small introductions

**Status, October 28:** slice A implemented. The Evaluations empty state now
explains evaluations and offers **Save project to folder…**, or **Download
project JSON…** when folder access is unavailable. Both reuse the Project
menu's save routing and preserve the current draft. Success leaves the user
in Evaluations with no suite created automatically. Cancellation or failure
keeps the draft and empty state.

`EvaluationsMode` owns the copy and action presentation; the route supplies the
capability-specific label and existing save callback. The project owner keeps
all persistence behavior. No replacement, serialization, or provider contract
changes are needed. `evaluation-project-prerequisite.spec.ts` covers folder
and JSON success, dialog/picker cancellation, write failure, preserved messages,
no inference calls, and short desktop layouts in both themes. Its initial red
run reported the actual missing action list (`[]`).

**Recommendation:** pair a project-required empty state with the appropriate
existing create/save action. After that prerequisite succeeds, return to the
intended workspace. Cancellation preserves the current draft. Use existing
folder/JSON capability checks and replacement guards; saving, creating, and
opening a project are not interchangeable operations.

Explain evaluations with a small example, such as running one prompt against
several inputs and checking the answers. Explain when to choose Decision over
Chat at its entry point, reusing the existing Decision guide. Keep instructional
copy local to the task rather than permanently surrounding populated editors.

**Options and decision gate:** an explanation plus CTA is small and uses existing
flows. A starter suite or example request teaches more but creates content and
needs ownership, replacement, and retention rules. Deliver the CTA first;
agree an explicit opt-in example contract before adding generated assets.

**Acceptance:** the Evaluations empty state offers a working next step for the
host's actual project capabilities. Success returns to Evaluations; cancel or
failure loses no draft. Merely opening an empty state creates no content and
starts no provider call. Introductions supplement existing guidance rather
than duplicating it.

## 6. Consistent scope and lifetime language

**Recommendation:** inventory existing labels and converge on a small vocabulary
such as **Profile default**, **Saved in project**, **This session**, and **On
this device**. Use action labels that describe their real effect: for example,
**Save value to project**. Keep overrides and unsaved/error states visible,
with fuller explanations available on demand.

**Decision gate:** resolve terminology against the
[shared-assets personal workbench plan](SHARED_ASSETS_PERSONAL_WORKBENCH_PLAN.md)
and [Level 2 design](SHARED_ASSETS_LEVEL_TWO_DESIGN.md). Do not label something
“Use for this run” if it actually remains effective across runs in the session.
Likewise, “On this device” must not imply that browser-session state is durable.
The migration foundations are not evidence that the active UI already has the
future persistence semantics.

**Owner and contract:** existing settings, project, template, tool, and permission
owners expose authoritative scope; presentation derives labels from those
states. Centralize vocabulary where meaning is truly shared, without inventing
one persistence type that erases feature-specific distinctions. Copy changes
must not activate a migration or alter serializers.

**Acceptance:** a user can tell what survives another run, project switch,
reload, or export. Test those lifetimes against actual current behavior. Scope
labels, save actions, and persistence failures agree; credentials and execution
grants remain outside portable definitions.

## 7. Search actions as an additional discovery route

**Recommendation:** add a visible **Search actions…** entry and a platform-aware
keyboard shortcut, initially Command/Ctrl+K if it does not conflict with existing
command scopes. Search labels and ordinary synonyms for actions such as insert
prompt, attach tool, repeat request, open history, and compare attempts. Show
context and disabled reasons rather than promising unavailable operations.

**Options and decision gate:** a navigation/action index is bounded; searching
all prompts, tools, and run contents adds indexing, retention, and privacy
contracts. Start with actions and links into existing pickers. The app binds no
Command/Ctrl+K today, but Chrome and Firefox on Windows and Linux use Ctrl+K to
focus browser search; decide whether the web build overrides it. Confirm shortcut
precedence, result ordering, and whether unavailable actions remain visible
before implementation. Do not introduce recent-action persistence by default.

**Owner and contract:** a command-search feature owns query, result selection,
and overlay focus. Define typed descriptors with stable IDs, labels, synonyms,
context, availability reasons, and handlers supplied by feature owners. Reuse
existing guards and modal keyboard scope. Search opens the existing flow; it
does not bypass preflight, mutate hidden drafts, or send a provider request on
navigation alone. No raw project contents or credentials enter the index.

**Acceptance:** actions remain reachable through their ordinary visible homes.
Search, arrows, Enter, Escape, focus restoration, and shortcut suppression in
other dialogs work. Results reflect current context after project/mode changes;
disabled commands cannot execute through stale results. A no-results state
points to relevant visible destinations.

## 8. A shorter path to the first message

**Recommendation:** remove chrome above the message list that repeats what the
layout already says. Drop the **Request / Composer** and **Response / Live
output** headings; the pane positions and tabs identify them. Put the Chat /
Decision switch on the same row as the Messages / Tools tabs. Hide the routine
“No tools attached to this request.” line when nothing is attached, because the
Tools tab count already shows 0. Keep that line, and its blocked variant,
whenever attached tools exist or cannot reach the model.

**Options and decision gate:** removing headings alone is the smallest change
and saves about one row. Merging the kind switch into the tab row saves another,
but puts two segmented controls side by side; check that they still read as
separate choices at 880px. Recommend both, with the tool line rule above. Agree
whether Decision Compose drops the same headings before changing shared
markup.

**Owner and contract:** `RequestComposer` owns its header and tool line;
`ComposeKindSwitch` keeps the kind choice and its existing mutation;
`ResponseOutput` owns its header. The headings' accessible names move to the
regions themselves (`aria-label` or visually hidden headings) so landmarks and
specs that locate panes by name keep working. No state or data changes.

**Acceptance:** at 1280×800 the first message editor starts at least 100px
higher than the 0.6.0 baseline (about y=385). The blocked-tools warning remains
visible while settings are collapsed. Pane names remain available to assistive
technology. Check 880, 1280 and 1440px, both themes, and 200% zoom.

## 9. Message actions that do not crowd the transcript

**Recommendation:** stop giving every transcript row a bordered **Edit from
here** button. Show the transcript's per-message actions (**Edit from here**,
**Copy Markdown**) as text buttons beside the role on the expanded or focused
message, the way **Copy Markdown** already looks, and keep them reachable by
keyboard on every row. Make expand/collapse its own button so the row is no
longer a `role="button"` containing other buttons, the ARIA problem #230 left
in place.

**Options and decision gate:** a labeled **Message actions** menu per row is the
most compact but adds a step to a frequent action. Text buttons shown on every
row are simplest but keep the clutter at narrow widths. Recommend text buttons
visible on the expanded message, plus on hover and focus for collapsed rows. The
plan's design rules forbid hover-only discovery, so collapsed rows must still
expose the actions in tab order. Decide before building whether read-only
history views use the same rule.

**Owner and contract:** `ResponseOutput`'s transcript owns presentation, focus
and the disclosure button; the pending-branch owner (`usePendingBranch`) keeps
the branch action and its navigation. Copying keeps `CopySourceButton`'s
behavior. No trace or branch contract changes.

**Acceptance:** at 880px no action label wraps and message previews keep
their width. **Edit from here** works by mouse, Enter and Space from Compose
and Runs (`pending-branch.spec.ts`); copying never toggles a row
(`response-copy.spec.ts`). The row's disclosure is a real button with
`aria-expanded`, and no interactive element nests inside another.

## 10. Readable pending-branch notice

**Recommendation:** name the branch point the way the transcript does: the
parent run's title (its first user message, as Runs lists it) and “Message 2 ·
user”. Keep the raw run and message IDs in a details disclosure or `title` for
debugging.

**Owner and contract:** `usePendingBranch` reads the live run and transcript
in `editFromHere`, and the saved trace in `branchFromTrace`. It captures the
display label at branch time, so later runs cannot change it, and exposes it
on `PendingBranch`. The composer only renders it. The persisted `branchFrom`
lineage in traces is unchanged.

**Acceptance:** the notice shows no raw IDs by default and stays within three
lines at 880px. A branch from a historical trace and from the current run are
both labelled. `pending-branch.spec.ts` asserts the label.

## 11. Session run history and a quieter unsaved-trace notice

**Recommendation:** keep a bounded, in-memory list of this session's recent
ordinary runs and show them in Runs, instead of holding only the latest one.
This matters most without a project folder, but also covers folder sessions
where a trace write failed, runs started before a folder was opened, and
comparing a few quick attempts before deciding what to keep. Once that history
exists, shrink the **Run trace not saved** notice: show the full explanation on
the first unsaved run of a session, then a compact status chip with the same
**Save trace…** action.

The user confirmed on October 28 that they usually work in a project folder and
still want more runs kept in memory.

**Options and decision gate:**

- **Size:** a fixed count (recommend 20 ordinary runs) is easy to explain; a
  byte budget protects against long streamed or tool-heavy traces. Recommend a
  count with a byte ceiling, evicting the oldest unsaved run and saying so.
- **Lifetime:** cleared on reload, matching today's in-memory current run.
  Decide whether opening or replacing a project also clears it. Recommend
  clearing, so one project's Runs never lists another's unsaved runs. The
  replacement guard should mention unsaved session runs when there are any.
- **Batches:** repeated experiments and evaluations stay as today (current
  batch only) in the first slice.
- **Overlap with folder history:** an entry written to the folder appears once,
  as the saved entry, matched by run ID.

**Owner and contract:** a session run history owner beside
`useProjectRunHistory` holds completed run traces and their storage status. Runs
navigation merges it with folder history for display. `RunCoordinator` still
owns only the active run. The entries are `RunTrace` values already produced for
saving, so no new trace format is needed. Entries are never written anywhere
implicitly: saving stays an explicit action, and this list is not a persistence
layer. Labels follow section 6's vocabulary (for example **This session · not
saved**), and the existing `currentRunStorageLabel` copy changes to match.

**Acceptance:** after three runs without a folder, Runs lists three entries,
each opens read-only, **Edit from here** works from each, and each can be saved
or exported. After a reload the list is empty and says so. With a folder, a
successfully saved run appears once. Eviction past the cap is announced. No
provider request occurs from browsing. Extend `runs-result-discovery.spec.ts`
and `project-storage-clarity.spec.ts`.

## 12. A quieter Prompts sidebar

**Recommendation:** replace the stacked **New prompt**, **New decision prompt**
and **Import prompt from n8n…** buttons with one **New prompt** control offering
Chat, Decision and n8n import. Keep n8n import in the Project menu or the
Prompts sidebar, not both; recommend the Prompts sidebar, where prompts live,
since import produces a prompt rather than changing the project as a whole.

**Owner and contract:** `ProjectTemplatesPane` owns the control; the existing
create and n8n import flows are reused unchanged, including the n8n disabled
reason.

**Acceptance:** each former action remains reachable by keyboard with its
disabled reason. `prompt-authoring-workspace.spec.ts`,
`first-use-prompt-authoring.spec.ts` and `n8n-template-paste.spec.ts` reach
creation and import through the single control.

## 13. Related work tracked elsewhere

- **Dialog consistency (#208).** Escape, focus trap, initial focus and scroll
  lock differ across 13 dialogs; **Promote to case** cannot be dismissed with
  Escape. The issue proposes native `<dialog>`. It ranks high here because
  every flow in this plan opens one of these dialogs.
- **Decision Inspect scrolling on narrow layouts (#204).**
- **Evaluation authoring** (review findings 2–5): explicit **Add prompt** /
  **Change pinned revision** / **Replace evaluation input** actions, a
  **Duplicate case** action followed by a paste-in case table, unscored batches,
  and a guided **Compare another revision**. Duplicate case is small and
  self-contained; the rest change the evaluation contract and need their own
  design document.

## Delivery order and boundaries

| Slice | Deliverable | Gate |
| --- | --- | --- |
| A | Complete: tool creation consolidated in #224; project-prerequisite CTA added to Evaluations. | Existing folder/JSON save routing; no new data model. |
| B | Direct model picker and compact settings. | Agree summary content, shared-panel adaptation, and Chat/Decision scope. |
| C | Tool search and selected-first ordering in the **Attach tool** menu. | Re-scope against #224 first; it may be small or unnecessary. |
| D | Quieter prompt-use cards and clearer conversion wording. | Agree action placement and focus contract. |
| E | Scope/lifetime vocabulary pass. | Reconcile with the active shared-assets implementation; apply the vocabulary during the other slices as well. |
| F | Runs/header action consolidation and Repeat placement. | Complete action inventory, selected-evidence contract, and discoverability review. |
| G | Command search. | Stabilize visible action homes and agree descriptor/keyboard contracts. |
| H | Complete: headings removed (Chat and Decision), panes kept as named regions, the kind switch moved onto the tab row through `panes.request(kindSwitch)`, and the empty tool line hidden. | Decision Compose adopts the same layout; region names `Request composer`, `Response output`, `Decision response`. |
| I | Transcript message actions and disclosure button (section 9). | Agree visibility rule for collapsed rows and history views. |
| J | Readable pending-branch notice (section 10). | None beyond the label source. |
| K | Session run history and compact unsaved notice (section 11). | Agree cap, eviction, and whether project replacement clears it. |
| L | One **New prompt** control and a single n8n import home (section 12). | Agree where n8n import lives. |

Each slice should be a separate reviewable change. Before implementation,
record the selected options with the user wherever they constrain ownership or
behavior. This document proposes those decisions rather than silently settling
them.

### Recommended order

Ranked by daily friction removed per unit of risk, as of October 28:

1. **H and J** (A is complete). These remove the most visible clutter from
   Compose. Confirm H's Decision scope and region naming before implementation.
2. **I.** Transcript actions; also fixes the nested-button ARIA issue.
3. **#208, starting with Promote to case.** Every later slice adds or moves
   dialog entry points, so a consistent modal contract first avoids rework.
4. **B.** The most frequent configuration change becomes one step.
5. **K.** Keeps recent attempts available for comparison.
6. **F.** Starting with the redundant **Run history** menu item, then trace
   import/export, diagnostics, and Repeat.
7. **D and L.** Quieter prompt cards and Prompts sidebar.
8. **Duplicate case** (section 13), then a separate evaluation-authoring design.
9. **C** if still warranted, and **G** last. Apply **E**'s vocabulary as each
   slice touches labels rather than as a separate pass.

### Decisions needed

Slice A is complete. Slice J and the **Run history** removal in F need no new
contract and can ship ahead of the others.

| Slice | Decision | Recommendation |
| --- | --- | --- |
| B | Which settings always appear in the closed summary versus only when overridden | Protocol and problems always; temperature and response mode when overridden |
| B | Whether Decision Compose gets the same direct model picker | Confirm before extending the Chat layout |
| C | Whether search and selected-first ordering are still needed after #224 | Decide with a populated tool set |
| D | Whether **Edit source** stays visible or moves into **Prompt actions** | Start in the menu; revisit with a populated project |
| D | Whether Decision template uses are in scope | Confirm before implementation |
| E | Shared scope and lifetime vocabulary | Reconcile with the shared-assets plans |
| F | Whether to keep **Run data** or move its actions into Runs | Remove **Run history** now; consolidate the rest after the action inventory |
| F | Where **Repeat…** lives | Compare a visible secondary button with a labeled menu |
| F | Where diagnostics lives | Define its home and capture identity first |
| G | Shortcut, including the browser's Ctrl+K | Command/Ctrl+K if the override is acceptable |
| G | Whether unavailable actions appear in results | Show them with their disabled reasons |
| G | Ordering of results and recent actions | No persisted recent actions initially |
| H | Whether Decision Compose drops the same headings | Yes, for consistency, if its pane names stay available |
| I | Action visibility on collapsed rows | Visible on the expanded message; on hover and focus otherwise, always in tab order |
| K | Cap and eviction | 20 ordinary runs with a byte ceiling; announce eviction |
| K | Whether opening or replacing a project clears session runs | Clear, and mention unsaved runs in the replacement guard |
| L | Where n8n import lives | Prompts sidebar only |

No project, trace, experiment, or provider-wire format change is proposed.
UI search/disclosure state and session run history (section 11) remain
transient, in memory only. If durable UI
preferences are later desired, define their device-local storage, reset, and
compatibility separately. Keep provider-specific representations in their
existing adapters; the new controls consume provider-neutral feature contracts
and preserve capability-specific availability.

## Verification and review

Follow [AGENTS.md](../AGENTS.md), the [browser suite mechanics](../tests/e2e/README.md),
and the [provider fixture guide](PROVIDER_FIXTURES.md). Write regression tests
before fixes and run them red for the actual incorrect value or behavior, not a
selector mistake, hydration race, or unloaded fixture. Report when a meaningful
red run could not be demonstrated.

Existing specs to extend or run as relevant starting points:

| Area | Committed specs |
| --- | --- |
| Model/settings | `request-settings.spec.ts`, `request-settings-ownership.spec.ts`, `inference-settings-panel.spec.ts`, `model-picker-empty-value.spec.ts` |
| Tools | `tool-attachment.spec.ts`, `tool-definition-authoring.spec.ts`, `tool-registry-ownership.spec.ts`, `mcp-discovery.spec.ts`, `tool-parameter-order.spec.ts` |
| Prompt cards | `prompt-insertion-handoff.spec.ts`, `template-revision-switch.spec.ts`, `template-detach-preflight.spec.ts`, `saved-prompt-revision-diff.spec.ts` |
| Run navigation/actions | `runs-result-discovery.spec.ts`, `header-menu-interaction.spec.ts`, `mode-primary-action.spec.ts`, `batch-live-progress.spec.ts` |
| Empty states/scope | `evaluation-project-prerequisite.spec.ts`, `project-storage-clarity.spec.ts`, `project-replacement-guard.spec.ts`, `system-one-decision-guide.spec.ts` |
| Search/keyboard | `modal-command-scope.spec.ts`, `mode-navigation.spec.ts`; add dedicated command-search coverage |
| Composer header (H) | `workbench-composition.spec.ts`, `request-settings.spec.ts`; add a first-message position check using `support/layout.ts` |
| Transcript and branch (I, J) | `pending-branch.spec.ts`, `response-copy.spec.ts`, `response-view.spec.ts` |
| Session runs (K) | `runs-result-discovery.spec.ts`, `runs-indicator.spec.ts`, `project-storage-clarity.spec.ts`, `project-replacement-guard.spec.ts` |
| Prompts sidebar (L) | `prompt-authoring-workspace.spec.ts`, `first-use-prompt-authoring.spec.ts`, `n8n-template-paste.spec.ts` |

These are coverage candidates, not claims that the current specs cover the new
acceptance criteria. For each product slice, iterate against affected specs
with `npm run test:e2e -- tests/e2e/<name>.spec.ts`, then run the full
`npm run test:e2e` once before handoff. Run other checks appropriate to changed
code and report exact commands and gaps.

Inspect realistic populated content at desktop widths of 880, 1280, and 1440px,
including a 720px-tall window, long names, both themes, keyboard navigation, and
200% zoom. Preserve existing narrow-screen behavior; this plan does not reopen
the older plan's deferred mobile redesign. Check affected responsive boundaries
when moving controls. Use fixture assertions for exact transmitted values and
focus assertions for routing; screenshots supplement those checks.

After B–D, review a familiar populated project with the user: can they change
model, insert a prompt, resolve a missing variable, attach a tool, run, and
inspect output without searching through management UI? Before F–G, ask them to
find history, export the selected run, repeat a request, and locate diagnostics.
Use observed hesitation to revise placement rather than assuming fewer visible
buttons automatically means a better interface.

**Original planning review:** documentation only; it required link, diff, and
whitespace checks rather than new tests or a browser run. The earlier manual inspection is
limited evidence, not a committed Playwright verification pass. Product
implementation must supply its own regression and full-suite results. Native
pickers, screen readers, real provider behavior, and representative populated
workflows remain outside this review's verified coverage.
