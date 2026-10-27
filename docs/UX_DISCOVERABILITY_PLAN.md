# UX simplification and discoverability plan

**Status:** proposed; this document authorizes no product implementation.\
**Baseline:** `main` at `309f180`, October 26, 2026.\
**Scope:** composer efficiency, contextual actions, discoverability, and clearer persistence language.

## Direction and evidence

Make the next useful action obvious while keeping configuration compact. Use
saved assets where they are needed; open their management surfaces only when
editing or organizing them. Collapse editing machinery while preserving active
state, consequences, and problems.

This is a follow-on to the [layout and flow plan](UI_LAYOUT_AND_FLOW_PLAN.md),
not a restart of that work. Preserve the existing Compose / Prompts /
Evaluations / Runs destinations, collapsed run settings, composer focus mode,
readiness routing, and read-only historical inspection. Coordinate with the
saved-prompt insertion combobox/popover being implemented separately; that
picker is a dependency and interaction reference, not work to duplicate here.

The preceding review inspected source and manually opened the local app's
initial composer, Tools view, and Evaluations empty state. It observed duplicate
**Add tool** / **Add project tool** actions and a project-required evaluation
empty state without a next-action button. Prompt-card recommendations came
from source inspection. Populated prompt cards, populated run inspection,
large collections, native Tauri, and assistive technologies were not visually
verified. These recommendations are design hypotheses, not measured usability
results. Recheck against the implementation baseline before each slice.

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

## Delivery order and boundaries

| Slice | Deliverable | Gate |
| --- | --- | --- |
| A | Consolidate duplicate tool creation; add project-prerequisite CTA. | Confirm labels and existing create/save routing; no new data model. |
| B | Direct model picker and compact settings. | Agree summary content, shared-panel adaptation, and Chat/Decision scope. |
| C | Tool attachment picker and explicit management routes. | Agree attachment/source identity, mutation timing, and Tools navigation. |
| D | Quieter prompt-use cards and clearer conversion wording. | Coordinate insertion-popover work; agree action placement and focus contract. |
| E | Scope/lifetime vocabulary pass. | Reconcile with the active shared-assets implementation; apply the vocabulary during B–D as well. |
| F | Runs/header action consolidation and Repeat placement. | Complete action inventory, selected-evidence contract, and discoverability review. |
| G | Command search. | Stabilize visible action homes and agree descriptor/keyboard contracts. |

Each slice should be a separate reviewable change. B–D are the main composer
improvements; F–G should not delay them. Before implementation, record the
selected options with the user wherever they constrain ownership or behavior.
This document proposes those decisions rather than silently settling them.

### Decisions needed

Slice A needs no new contract and can ship ahead of the others.

| Slice | Decision | Recommendation |
| --- | --- | --- |
| B | Which settings always appear in the closed summary versus only when overridden | Protocol and problems always; temperature and response mode when overridden |
| B | Whether Decision Compose gets the same direct model picker | Confirm before extending the Chat layout |
| C | Separate picker versus improving the existing Tools tab | Decide first; it sets the slice's size |
| C | Whether the Tools tab stays or becomes a **Manage tools** route | Keep both paths until the replacement is agreed |
| C | Immediate attachment versus attaching on confirmation | Immediate, with explicit reversible detach |
| D | Whether **Edit source** stays visible or moves into **Prompt actions** | Start in the menu; revisit with a populated project |
| D | Whether Decision template uses are in scope | Confirm before implementation |
| E | Shared scope and lifetime vocabulary | Reconcile with the shared-assets plans |
| F | Whether to keep **Run data** or move its actions into Runs | Consolidate only after the action inventory |
| F | Where **Repeat…** lives | Compare a visible secondary button with a labeled menu |
| F | Where diagnostics lives | Define its home and capture identity first |
| G | Shortcut, including the browser's Ctrl+K | Command/Ctrl+K if the override is acceptable |
| G | Whether unavailable actions appear in results | Show them with their disabled reasons |
| G | Ordering of results and recent actions | No persisted recent actions initially |

No project, trace, experiment, or provider-wire format change is proposed.
UI search/disclosure state should remain transient initially. If durable UI
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
| Tools | `tool-definition-authoring.spec.ts`, `tool-registry-ownership.spec.ts`, `mcp-discovery.spec.ts`, `tool-parameter-order.spec.ts` |
| Prompt cards | `prompt-insertion-handoff.spec.ts`, `template-revision-switch.spec.ts`, `template-detach-preflight.spec.ts`, `saved-prompt-revision-diff.spec.ts` |
| Run navigation/actions | `runs-result-discovery.spec.ts`, `header-menu-interaction.spec.ts`, `mode-primary-action.spec.ts`, `batch-live-progress.spec.ts` |
| Empty states/scope | `project-storage-clarity.spec.ts`, `project-replacement-guard.spec.ts`, `system-one-decision-guide.spec.ts` |
| Search/keyboard | `modal-command-scope.spec.ts`, `mode-navigation.spec.ts`; add dedicated command-search coverage |

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

**This planning PR:** documentation only. Review links, diff, and whitespace;
no new tests or browser run are required. The earlier manual inspection is
limited evidence, not a committed Playwright verification pass. Product
implementation must supply its own regression and full-suite results. Native
pickers, screen readers, real provider behavior, and representative populated
workflows remain outside this review's verified coverage.
