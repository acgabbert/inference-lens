# System One requests in Saved Prompts

Status: recommendations accepted by the user on 2026-10-25; implementation has
not started.

## Outcome

The existing Prompts library can author, save, revise, find, and reuse both chat
prompts and System One decision requests. A user can save a decision request
from Compose, reopen it from the library, fill its variables, run it, and create
an evaluation suite against an exact saved revision.

This is a project-owned library, matching current Saved Prompts persistence.
Creating a device-wide library or synchronizing prompts across projects is a
separate feature.

## Accepted decisions

| Decision | Options and tradeoffs | Recommendation |
| --- | --- | --- |
| Reusable unit | A whole request includes state and questions and has unambiguous execution semantics. Question fragments allow composition but require merge rules for question IDs, ordering, variables, and state. | Whole requests first. Use `state: "{{state}}"` or variables inside structured state when questions stay fixed across inputs. |
| Use semantics | Copy-on-use is smaller and leaves Compose freely editable, but loses the library's pinned-source, update, and usage workflows. A pinned revision adds resolution and editing contracts but matches existing chat template behavior. | Pin a saved revision; support explicit update and detach. |
| Library model | Separate decision-template storage limits changes to chat code but duplicates lifecycle and navigation. A typed union in `promptTemplates` shares those concepts while requiring existing consumers to handle kind explicitly. | One collection with `kind: "chat" \| "decision"`, with separate content editors and resolvers. |

The user explicitly accepted all three recommendations on 2026-10-25: whole
requests as the reusable unit, pinned revisions with explicit update and detach,
and one typed library with separate content editors and resolvers. These choices
are settled and do not require reconfirmation before implementation. The
contracts below describe the planned implementation; any new material contract
decision still follows `AGENTS.md`.

## Existing boundaries

- `packages/core/src/project.ts` owns project schema 14, chat template drafts,
  immutable template revisions, conversation template uses, and decision request
  revisions. Templates currently require `messages`.
- `packages/core/src/decision-request.ts` owns decision draft revision updates
  and run preparation. `decision-variables.ts` already resolves variables in
  string values within state and question instructions.
- `app/templates/use-project-templates.client.ts` owns template mutations and
  session templates. `project-templates-pane.client.tsx` combines the library
  with a chat editor and chat-specific actions.
- `app/decisions/use-decision-compose.client.tsx` owns the decision draft,
  target, session, and project integration. The route composes this owner.
- Decision suites already pin a `decisionRequestRevisionId`; experiment plans
  snapshot resolved input. Library support should feed those boundaries.

## Proposed data and behavior contracts

### Saved templates

Make `PromptTemplate` a discriminated union of chat and decision templates.
Keep shared metadata: ID, name, current revision ID, archive state, and optional
target recommendation. Each arm has its own draft and revision content type:

- Chat: the existing message set and variable defaults.
- Decision: a `DecisionInput` under `decision`, plus variable defaults.

A template's kind is fixed for its lifetime; drafts and revisions cannot mix
kinds. Use typed arms rather than a structure with optional `messages` and
`decision` fields. Existing template and revision ID namespaces can remain
shared, with reference validation enforcing kind.

Decision content uses the existing authored `DecisionInput` representation,
without provider credentials, endpoint URLs, wire envelopes, or runtime model
metadata. Its vocabulary is the application's existing decision contract;
serialization to a particular provider remains the adapter's responsibility.

Keep target recommendations advisory. Resolve a recommendation through a
portable connection requirement and the local System One capability check;
never change the active connection or model merely by opening a template.
Authoring and saving must work without a configured decision provider.

### Decision request uses

Extend decision request revisions with explicit inline and template-use arms:

- Inline: existing authored `decision` and request `values`.
- Template use: a `templateId` and `templateRevisionId`, with request `values`
  acting as overrides of that revision's defaults.

Keep request identity, parent revision, timestamp, and the active project
pointer in their current roles. A template-backed revision has one source of
content: its pinned template revision. Do not persist both a reference and a
second authoritative copy of the decision input.

Introduce one core resolver for project decision revisions. It returns authored
decision content, effective values, source metadata, and diagnostics. Compose,
suite authoring, suite preflight, and experiment execution use it instead of
reading `revision.decision` directly. Rendering variables stays at the existing
execution boundary.

Value precedence is pinned template defaults, then request overrides, then
evaluation case values. Empty strings count as supplied values. Preserve the
existing variable locations, literal-brace escaping, and secret-name rules.
Unfilled variables may be saved; unresolved or malformed variables block runs.

### Lifecycle

- **Save from Compose:** create a decision template from valid authored content,
  retaining variable tokens. Show current values in the defaults editor so the
  user chooses what belongs in the reusable prompt. Saving a template alone
  does not change the current request into a template use.
- **Use revision:** create a new project decision request pinned to the selected
  revision, make it active, and open Decision Compose. Preserve previous saved
  requests. A valid current draft is folded into the project first; an invalid
  unsaved draft requires an explicit discard choice before navigation.
- **Edit a use:** values remain editable in Compose. Content is read-only while
  pinned, with `Edit source` and `Detach` actions. Editing the library source
  creates a new template revision and leaves existing uses pinned.
- **Update:** explicitly choose the latest revision, review the content/default
  diff, retain overrides for surviving variables, discard obsolete overrides,
  and expose any newly required values. Create a child request revision so
  existing suites and runs retain their input.
- **Detach:** copy the authored input and effective values into a new inline
  request revision. Preserve tokens and ordering; do not substitute variables
  into permanent content during detachment.
- **Archive/restore:** hide archived entries from new-use pickers; existing pins
  continue resolving. Usage reporting includes decision request revisions and
  suites. No deletion of referenced revisions is introduced.

### Library and editor ownership

Keep one Prompts workspace, with Chat/Decision badges and an All/Chat/Decision
filter. Creation offers both kinds. Decision entries show question and variable
counts, revision history, defaults, archive/restore, `Use revision`, and
`Evaluate revision` actions.

Split the library shell from the content editors before adding decision editing:

- The library owner handles selection, lifecycle, persistence, and shared
  revision navigation.
- The chat editor retains message-set authoring and insertion.
- A decision template editor reuses an extracted decision input editor for the
  existing form/JSON views and validation. It does not include Compose's run,
  connection, or session state.
- `useDecisionCompose` exposes commands to capture a valid authored request and
  adopt a template use. It owns draft preservation and session invalidation.
- Prompt navigation gains a decision-request return target alongside the
  existing conversation template-use target.
- `app/page.tsx` only connects owner commands and switches modes. Template
  mutation, resolution, and draft workflows remain outside the route.

Retain in-progress edits when switching template kind, revision, or app mode.
Define and display the difference between session-only edits, persisted valid
drafts, and invalid JSON that has not been saved. Never label the last valid
snapshot as if it included an invalid edit. Match existing unsaved-project
template behavior when a decision template is created before a project exists.

Decision revision diffs must show state, questions, instruction changes,
criteria, ordering changes, and variable defaults. Reordering score criteria
changes meaning and must never appear as an identical revision.

### Evaluation integration

`Evaluate revision` creates a template-backed decision request revision and a
decision suite pinned to it, without replacing Compose's active draft. Reuse
existing decision target setup, variable bindings, checks, and execution.

List compatible suites by the decision template their input references. Moving
an existing suite to a different template revision creates a new request
revision and explicitly retargets the suite. Report removed variables, changed
question IDs/types, and incompatible checks; do not silently discard checks or
case data. Existing experiment snapshots and results retain their original
input. Filter chat-only saved-prompt pickers by template kind.

## Persistence and compatibility

Use the next project schema version (15 if 14 is still current at implementation).
Migrate legacy templates to `kind: "chat"` and existing decision request
revisions to the inline arm. Preserve IDs, revision relationships, defaults,
archive state, external import receipts, and evaluation references.

Refactor the migration chain deliberately: the current v13 migration assigns
the current schema version, so simply incrementing the version constant would
skip an explicit v14-to-v15 transformation. Test every supported starting version
through the full chain. Older applications should reject the new schema with
their existing newer-version diagnostic.

Extend reference validation to reject missing revisions, cross-kind uses, mixed
revision kinds, and invalid default/override names. Keep `decision` subtrees
order-preserving through parsing, migration, serialization, hashing, and diffs.
The existing stable JSON helper treats that key as order-sensitive; verify new
paths preserve the same guarantee.

Audit project-backed CLI and workspace consumers along with browser callers.
Experiment plans and traces should continue receiving resolved decision input;
avoid changing their formats unless an actual new persisted field requires it.
n8n imports continue creating chat templates and retain their provenance.

## Implementation sequence

1. **Finalize contracts from the accepted decisions.** The three recommendations
   above are accepted. Specify final type shapes and owner interfaces consistent
   with them; involve the user only if a new material contract decision arises.
2. **Schema and resolution.** Add discriminated templates and request inputs,
   explicit migrations, validation, and the shared decision revision resolver.
   Update all direct decision revision consumers and narrow chat consumers.
3. **Core lifecycle.** Implement create/save/use/update/detach/archive behavior,
   value precedence, usage discovery, and decision revision diffs. Keep these
   operations pure and cover immutability and ordering.
4. **Library and Compose.** Separate the library shell and content editors;
   add decision authoring, capture/use actions, pinned-use presentation, and
   source/return navigation. Cover draft retention and project reopen.
5. **Evaluations and compatibility.** Add decision revision evaluation and suite
   retargeting, complete CLI/workspace integration, and verify existing chat
   templates and imported prompts still behave correctly.
6. **Verification and documentation.** Run scoped browser specs while iterating,
   the full browser suite once at completion, and appropriate build/core checks.
   Document the user workflow and any limits found during verification.

Before each behavior change, write and run its regression test. A failure must
assert the actual missing or incorrect result. A selector timeout for a button
that has not been built, or a TypeScript import failure for a new function, does
not establish behavioral regression evidence. Where a preimplementation red
test cannot exercise the behavior, record that limit explicitly.

## Acceptance and test coverage

Core coverage:

- Supported project versions migrate and round-trip without changed chat data,
  decision order, or broken references; new-schema invalid references fail.
- Defaults/overrides/case values resolve with the specified precedence, including
  empty, missing, escaped, and forbidden variable names.
- Saving a new source revision cannot alter an existing use, suite input, or
  experiment snapshot. Update/detach create the expected child revisions.
- Archive preserves historical resolution, kind checks reject invalid uses, and
  diffs detect question/criteria ordering changes.

Add committed Playwright coverage, proposed as
`tests/e2e/system-one-saved-prompts.spec.ts`:

- Create in the library and capture from Compose; save, reopen the project, and
  verify content, defaults, kind, revision, and ordering.
- Use a historical revision, fill values, and run against the committed System
  One capture replay. Assert rendered answers and actual request evidence.
  Use captured questions: the fixture refuses unrelated question definitions.
- Save a newer library revision, confirm the use stays pinned, then update and
  detach. Verify the content and values actually displayed and persisted.
- Preserve valid and invalid drafts through navigation; verify explicit discard
  behavior and the no-project workflow.
- Evaluate a saved decision revision, retarget deliberately, and show diagnostics
  for incompatible bindings/checks while preserving prior results.
- Verify mixed-library search/filter, archive/restore, keyboard navigation,
  narrow layouts, and the existing chat insertion workflow.

Iterate with `npm run test:e2e -- tests/e2e/system-one-saved-prompts.spec.ts`.
Also scope runs to affected decision request/suite, prompt authoring/retention,
revision diff, and insertion specs. Follow `tests/e2e/README.md` and
`docs/PROVIDER_FIXTURES.md`; let Playwright start its own servers.

At completion run `npm run typecheck`, `npm run test:core`, relevant component
tests and builds, then `npm run test:e2e` once. Verify the CLI decision suite path
against a template-backed project using the existing fixture infrastructure.
Report exact commands, gaps, and fixture limits. Hosted-provider and native
desktop checks are separate from what browser replay proves.

## Planning verification

This proposal was checked against the current source and repository testing
guidelines. No application code changed and no tests or browser suites were run
for this documentation-only task.
