# Reusable prompt sections and a focused authoring workspace

**Status:** Proposed implementation plan, October 28, 2026. Documentation only.
The user confirmed the product priorities below and requested this plan for a
draft PR. Data-model recommendations are proposals, not approved implementation
contracts. Resolve the review decisions before starting the dependent slices.

## Product priorities

The primary reuse unit is a **section within a message**: writing guidelines,
domain context, task instructions, output requirements, or examples embedded in
a larger system or user message. Whole-message reuse remains useful, but does
not satisfy this need on its own.

The immediate usability problem is handling prompts with many variables. The
current workflow takes too much scrolling and separates the values being edited
from the resolved prompt. The intended experience keeps those two things next
to each other, with straightforward ways to turn selected text into a variable
and turn a useful request into an evaluation case.

n8n remains a supported source of prompts and expression mappings. Native
authoring, section reuse, preview, and evaluation should be understandable and
useful without knowing n8n.

## Intended workflow

1. Author or open a prompt containing system and user messages.
2. Select a passage and choose **Make variable**. Name the input and keep the
   selected passage as the current preview value, preserving the resolved text.
3. Select reusable instructions and choose **Save as section**. Review the
   section's inputs and replace the selection with a pinned section reference.
4. Edit values in the left pane while reading the resolved messages on the
   right. Selecting an input highlights its occurrences; selecting an occurrence
   focuses the corresponding input.
5. Try another set of values or run the request. Changing trial values does not
   silently change the prompt's reusable defaults.
6. Choose **Save as evaluation case**. Review the exact input revision, values,
   and destination suite, then author checks in the resulting case.

Example: a system message contains literal task instructions, a referenced
**Writing guidelines** section with a `tone` input, and literal output rules.
The user message contains `customer_message` and `product_context`. The user
edits all three exposed inputs in one workspace and sees the complete resolved
messages, including the guidelines in their actual position.

## Current foundation and boundaries

- [Prompt types and uses](../packages/core/src/project.ts) already provide
  immutable revisions, defaults, pinned uses, and ordered message sets. The
  [project format](PROJECT_FORMAT.md) explicitly excludes composition inside a
  message today; sections require a versioned extension.
- The [native template engine](../packages/core/src/template-engine.ts) performs
  string substitution with `{{name}}`, escaping, and missing-value diagnostics.
  It does not execute expressions.
- The [chat prompt editor](../app/templates/chat-prompt-template-editor.client.tsx)
  already discovers variables and owns authoring and template-use UI. Compose,
  prompt authoring, and evaluations have related but distinct value ownership.
- [n8n paste conversion](../app/templates/n8n-template-paste.ts) maps expressions
  to native variables. The [external import contract](../packages/core/src/external-prompt-import.ts)
  separates authored content, bindings, and execution evidence; its
  [project projection](../packages/core/src/external-prompt-project.ts) still
  directly depends on n8n naming helpers.
- [Trace-to-case promotion](../packages/core/src/evaluation-case-promotion.ts)
  exists for compatible chat inputs. Current-request promotion should reuse its
  compatibility rules where applicable without fabricating a trace.
- The [saved-prompt experiment review](reviews/saved-prompts-experiments-2026-10-26.md)
  documents related friction in case authoring, revision identity, and value
  ownership. Its historical findings need checking against the implementation
  at the time each slice starts.

## Workspace design

Use a shared **Inputs / Resolved prompt** workspace in Compose and prompt
authoring. Authoring additionally offers **Source** editing. Source editing and
trial-value editing are distinct tasks, but share the same resolver and revision
identity. Do not force source, values, preview, and library into four columns.

On a wide desktop, inputs and resolved messages remain visible side by side.
Give each pane usable width and bounded scrolling; keep the workspace identity,
revision, blockers, and primary actions visible. Collapse secondary library and
history controls before compressing the editing area. The preview starts with
the actual message roles and text, not an additional stack of variable cards.

The input pane offers search, missing-input filtering, and grouping by message
or section. An input intentionally shared across sections appears once, with
its occurrences listed. Distinct inputs with the same section-local name remain
distinct. Long values have an expandable editor without requiring every input
to occupy a large card. Show the effective value and its source; avoid repeating
the entire persistence explanation on every row.

Editing a value updates the preview without losing focus or moving either pane
unexpectedly. Highlight affected ranges and provide an explicit **Show in
preview** action instead of continually forcing scroll synchronization. Empty
strings and missing values remain visibly different. Missing values stay
identifiable in preview and block execution according to existing preflight.

At constrained widths, use an **Inputs / Preview** switch that retains selection,
cursor, and scroll positions. Offer the same actions through keyboard controls;
highlighting must not be the only way to identify a variable or component.
Layout preferences belong to personal UI state, not portable prompt content.

The preview is labeled with the exact saved revision or unsaved draft being
resolved. Run and case-promotion actions consume the same frozen resolution
they describe. A draft must never appear to be tested while a different saved
revision is actually used. Preview shows the native resolved messages; existing
provider-input inspection remains available for protocol-specific transformations.

## Discoverable authoring

**Insert variable** offers an existing input or a new name. **Make variable**
replaces only the selected literal text and assigns that text as a personal
preview value. Making it a reusable default is a separate explicit choice.
Reject invalid or prohibited names with an actionable explanation. If a name
already exists, offer deliberate reuse with an impact preview; do not overwrite
an existing value silently. Preserve whitespace, undo, and the selection.

**Save as section** extracts literal text and existing variable tokens from one
message into a reusable section draft. Review its name, exposed inputs, and
whether to replace the selection with a reference. Publishing the section and
updating the parent draft must be one recoverable operation; failure leaves the
original content available. Initially disallow a selection crossing messages or
part of an existing section reference.

**Insert section** selects a saved revision, shows its text and inputs, and maps
those inputs into the containing prompt. Referenced content is edited through
**Edit source** or converted to inline authored content through **Detach**.
Detaching preserves variable tokens and mappings rather than baking in trial
values. Updating a section pin requires a diff and input-mapping review.

## Proposed contracts and decisions for review

These recommendations make the implementation concrete enough to review. They
must be settled before implementing sections, persistence, or promotion changes.

| Decision | Recommendation | Alternative and tradeoff |
| --- | --- | --- |
| Section identity | A project-owned, versioned text-section asset, distinct from a message-set prompt. Sections have no message role. | Reuse chat-template objects: fewer types, but introduces ambiguous roles and message-set insertion semantics. |
| Message structure | Ordered text parts and section-reference parts. The containing message owns its role and exact order. | Textual include syntax: easy to type, but mixes reference identity, escaping, and user text in one grammar. |
| Initial nesting | Sections contain text and variables; only messages reference sections in the first release. | Nested sections allow deeper reuse but require dependency-cycle, depth, and transitive-update policies. |
| Input scope | Each section instance maps local inputs explicitly to prompt inputs or literal string bindings. Suggest mappings, but require deliberate sharing. | Automatically merge by name: less setup, but unrelated `context` or `tone` inputs can affect each other. |
| Input identity | Give section instances stable IDs; keep existing native variable names and use IDs where possible. Review rename/remapping behavior explicitly. | Introduce permanent IDs for every variable immediately: stronger rename tracking, but expands migration across existing cases and traces. |
| Revision behavior | Pin section revisions in saved parent revisions. New section revisions never change existing prompts, requests, cases, or evidence automatically. | Follow latest: convenient propagation, but makes previously saved requests change underneath users. |
| Value types | Keep text inputs and substitution-only rendering initially; optional descriptions improve discoverability. | Typed JSON, expressions, loops, and conditionals increase power but need separate serialization and execution contracts. |
| Saved examples | Trial values remain personal; explicitly saved reusable examples and evaluation cases are shared assets. Start with case promotion; design named example sets separately. | Make every trial a saved example: simpler discovery, but causes accidental asset churn and conflates experiments with reusable definitions. |
| Scope across prompt kinds | Deliver section composition for chat messages first; reuse neutral input/preview primitives where decision prompts fit. | Extend decision-state strings and instructions immediately: broader reach, substantially larger structural and validation scope. |

### Resolution and value ownership

Core owns section types, reference validation, input discovery, deterministic
resolution, diagnostics, and occurrence/source mappings. The proposed pipeline
is: pinned message composition plus effective prompt inputs -> section-local
bindings -> resolved message text plus diagnostics and provenance. Neither the
UI nor provider adapters independently concatenate or substitute section text.

Preserve literal whitespace exactly. Do not insert separators, newlines, roles,
or recursive substitutions implicitly. A value containing `{{text}}` stays a
value; it is not another template program. Output range mappings identify the
message, section instance, and input so the preview can navigate accurately.

Keep existing precedence for current workflows: prompt defaults, saved use
values, then run overrides or evaluation case values in their respective
contexts. Recommended section-binding behavior: an explicit mapping resolves
from its parent input; only an unbound local input may fall back to a section
default. A missing mapped parent value must not silently fall back. An explicit
empty string is supplied. Review this rule and expose the resulting value
source before implementation.

Saved evaluation bindings should target the containing prompt use and its
exposed input, not generated text offsets. Renaming, removing, remapping, or
updating inputs requires a compatibility review that preserves existing case
values for explicit repair. Two uses of the same section remain separate
instances even when they pin the same revision.

### Persistence and compatibility

Coordinate this extension with the
[shared-assets plan](SHARED_ASSETS_PERSONAL_WORKBENCH_PLAN.md) and
[Level 2 ownership design](SHARED_ASSETS_LEVEL_TWO_DESIGN.md). Do not assume their
isolated codecs and recovery foundations mean application migration is active.
Confirm the format actually used by app and CLI before assigning a new version;
do not independently claim an already reserved version number.

Reusable sections, saved prompt compositions, and intentionally saved cases
belong to shared definitions. Incomplete authoring, preview values, selected
inputs, and pane layout belong to the personal workbench. An early UI slice may
use existing session state, but must describe its actual recovery limits and
must not silently save trial values as defaults.

Define a versioned migration from existing message strings to literal parts,
retaining message/use/revision identities and identical resolved output. Old
readers must reject unsupported new composition data rather than flattening or
dropping references. Validate missing references, archive behavior, revision
pins, and input bindings at import/load boundaries. Referenced historical
section revisions remain available even after archival.

Exports must include referenced section revisions and their dependencies.
Decide whether editing section drafts creates any new recovery-record variants.
Browser, native, and CLI must use the same resolver and compatible readers before
new-format writing is enabled. Historical traces stay readable. Define how new
runs retain exact section pins, effective values, and resolved messages without
requiring mutable asset lookups to explain old evidence; extend trace schemas
only through their own compatibility review.

### Feature ownership

A prompt-workspace feature owner manages input selection, pane navigation,
draft edits, and preview state. It receives an authored/pinned input plus value
sources and exposes explicit edits, run preparation, and promotion intents.
Compose and Prompts supply adapters for their different lifecycles. The section
library/editor owns section publication and revision selection; the evaluation
feature owns suite compatibility, case creation, and checks. The project
workspace owns persistence and recovery. Route components compose these owners
and handle genuine cross-feature handoffs, without absorbing their state.

## Preserve n8n support

Keep both n8n paste conversion and execution-backed import. The native template
contract remains independent of n8n expression syntax. Move adapter-specific
naming and expression-identity decisions out of the general importer as the
adapter contract is reviewed; retain deterministic mappings and existing receipts.

Preserve original expressions and import evidence where they already exist.
Define any additional durable paste provenance separately rather than assuming
the current paste flow stores it. Section extraction and editing must not claim
that changed content is still an exact imported execution snapshot.

n8n expressions map to native inputs whose values come from users or attributable
execution evidence. They are not evaluated as JavaScript in Inference Lens.
Keep unresolved and ambiguous imports explicit. Arbitrary expression execution,
workflow-context emulation, and round-trip export back to n8n are outside this
plan's initial delivery.

## From a useful request to an evaluation case

Offer **Save as evaluation case** from the inputs/preview workspace, without
requiring a provider call first. A completed run can continue to use existing
trace promotion. The preview identifies the entire composed request and exact
pins, not merely the section currently selected in the editor.

Capture a snapshot of the effective values the user is looking at, including
session overrides and explicit empty strings. Missing assignments must be
resolved or clearly retained as an incomplete case, never converted silently
to empty values. Review compatibility with the chosen suite's bindings.
Show which values become case inputs and which remain fixed in the saved
request. If a session override has no case binding, offer an explicit binding
or checkpoint action; never discard it and claim the case reproduces the preview.

For a compatible suite, show the proposed case name, mapped inputs, and values.
For an incompatible suite, explain the mismatch and offer a separate suite or
an explicit retarget review; never replace a suite input as a side effect of
adding a case. Unsaved authored changes require an explicit save/checkpoint
handoff, or a separately designed snapshot contract, before creating a durable
case reference. Recommend reusing saved request revisions for the first slice.

Creation saves the reviewed values and opens the case's checks editor. Reuse the
existing ability to author cases before checks are complete; execution still
requires the current checks and preflight rules. A captured model response may
be reference material, never an automatically correct expected answer. Show
when personal trial values are being copied into a shared case. Cancellation
preserves the source draft, values, selection, and existing suite.

## Delivery sequence

1. **Review contracts and baseline the friction.** Settle the decision table,
   current format/version coordination, and promotion checkpoint policy. Capture
   the existing many-variable workflow in the committed browser suite, using
   realistic long values and messages. Agree on a desktop interaction sketch.
2. **Deliver side-by-side inputs and resolved preview.** Use the existing message
   model first. Share the workspace between Compose and chat prompt authoring;
   preserve value ownership and exact revision identity. Add filtering,
   occurrence navigation, and a constrained-width mode. This slice should reduce
   daily friction without waiting for the section schema.
3. **Add discoverable variable authoring.** Implement insert/reuse and selection
   extraction with exact-text preservation, undo, and explicit default saving.
   Descriptions require the agreed persistence extension if included here.
4. **Add section contracts and persistence.** Implement types, migration,
   resolution/source mapping, pinning, compatibility, and app/native/CLI readers.
   Include evaluation binding and evidence contracts; do not enable a UI writer
   while any execution path can silently ignore sections.
5. **Expose reusable sections in authoring.** Add extraction, insertion, input
   mapping, source editing, detach, and reviewed revision updates. Integrate them
   into the same workspace rather than adding another vertical stack of forms.
6. **Add current-request case promotion.** Build the snapshot and compatibility
   handoff, explicit revision checkpoint, value review, and checks destination.
   This can begin after slice 2 for existing prompts; section support depends on
   slices 4–5 and must use the same handoff contract.
7. **Polish integration and evaluate follow-ups.** Verify n8n imports through the
   full workflow. Consider named input examples, bulk case editing, and revision
   comparisons separately after the core experience is usable.

Each slice should be independently reviewable. Do not treat approval of the
product direction as approval of unrelated schema changes or all future scope.

## Acceptance and verification

For each behavior change, write the regression test first and run it red for
the actual incorrect value or behavior. Record when a pre-fix failure cannot be
demonstrated; do not manufacture one by reverting a completed implementation.

- With at least 20 inputs, several multiline values, and multiple messages,
  edit a late input while its resolved occurrence remains visible in the other
  pane. Verify focus, scroll retention, exact value, missing-value navigation,
  and no horizontal overflow at wide and constrained desktop widths.
- Turning selected text into a variable preserves the resolved message exactly,
  including whitespace. Reuse, cancellation, undo, invalid names, existing-token
  boundaries, and literal braces behave deliberately.
- A message with literal prefix, two section instances, and suffix resolves in
  the authored order without extra separators. Same-named local inputs remain
  independent unless mapped together. Empty and missing values remain distinct.
- New section revisions leave saved parents unchanged. Reviewed pin updates show
  input impacts; detach retains authored tokens and effective value behavior.
  Archival, export/import, and reopening preserve referenced revisions.
- Preview and the actual fixture-captured provider request agree on the resolved
  native message content. Test real transport, not only a mocked resolver result.
- Case promotion preserves reviewed effective values, exact composition pins,
  and existing case identities. Cancellation and incompatible-suite handling
  leave source state intact. New cases need checks before execution.
- Old projects and traces remain readable; migrated outputs are identical;
  browser, native, and CLI resolve new compositions consistently. Personal
  preview edits do not mutate shared defaults or saved cases.
- n8n native-variable paste, expression conversion, missing/ambiguous bindings,
  and imported provenance continue to work after extraction into sections.

Use the [browser-suite mechanics](../tests/e2e/README.md) and
[provider fixture guide](PROVIDER_FIXTURES.md). Start with affected specs such as
`prompt-authoring-workspace`, `n8n-template-paste`, `template-revision-switch`,
`saved-prompt-experiment-review`, and `evaluation-saved-prompt-preflight`; add
focused section, selection-extraction, and case-promotion specs. Run neighboring
composition/fixture specs when shared support changes. Add core resolver,
migration, and compatibility tests, plus native/CLI checks where those boundaries
change. Report exact commands, coverage limits, and any Chromium fallback.

Human review should focus on a real long prompt: whether inputs and output are
comfortable to compare, whether section boundaries remain understandable in the
resolved message, and whether saving a case makes value ownership clear. This
complements the committed browser coverage.

For this documentation-only PR, no app behavior changes and no browser run is
required. Verify links and whitespace. Application tests and the full CI browser
suite have not been run as part of writing this plan.
