# Project format and workspace storage

Inference Lens projects use a visible `<name>.inference-lens/` directory bundle
containing one canonical, portable JSON document named `project.json`. New
saves use schema version 9. Version 5, 6, 7, and 8 projects are upgraded on load; earlier
project formats and the proof-of-concept request export remain unsupported.
Every schema is strict, so a reader rejects a document it does not understand
rather than guessing.

New bundles contain an internal `.gitignore` with `*` by default. This makes the
entire working project—including authored prompts, fixtures, and run
traces—private from ordinary Git staging even when it lives inside a code
repository. The creation dialog can omit the ignore file for projects intended
for version control. The ignore file is workspace metadata and is not part of
the portable project document.

## Authored conversations

The format separates authored conversation items from the ordinary messages
resolved for provider execution. A conversation revision owns one ordered
`items` array. Literal messages and pinned template uses occupy the same array,
so their relative order is explicit:

```json
{
  "id": "revision_example",
  "conversationId": "conversation_example",
  "items": [
    {
      "kind": "message",
      "message": {
        "id": "message_system",
        "role": "system",
        "content": [{ "type": "text", "text": "Be concise." }]
      }
    },
    {
      "kind": "template-use",
      "use": {
        "id": "template-use_question",
        "templateId": "template_question",
        "templateRevisionId": "template-revision_question-1",
        "values": { "topic": "migration safety" },
        "outputMessageIds": ["message_question"]
      }
    }
  ],
  "createdAt": "2026-07-26T12:00:00.000Z"
}
```

A template use always pins both a project-owned template and one of that
template's immutable revisions. `values` are owned by the use. Key presence is
significant: `""` is an intentional empty value, while an absent key has no
value at that level. Use values may name only variables that occur in their
pinned revision. Newly saved revisions drop obsolete defaults instead of
retaining hidden assignments.

A variable with no value at any level is a normal authoring state, not an
invalid document. Validation accepts it, and resolution renders the variable as
its own `{{name}}` token and reports a `missing-template-variable` diagnostic
naming the item and the use. This keeps the gap visible in the composer and in
the resolved preview, distinct from the empty string an intentionally blank
value produces, and it is what lets a variable be left blank in the file and
supplied per run. Opening and saving a project never depend on every variable
being filled. The UI presents those diagnostics for correction, while the
provider-neutral `prepareProjectRevisionRun` boundary refuses to produce
executable messages and provenance until every diagnostic is resolved.

Every template revision owns a non-empty ordered `messages` array. Each message
contains its `system`, `user`, or `assistant` role and text, so uses never
override roles. A use has one stable `outputMessageIds` entry per template
message. A newly created prompt begins as one user message; system instructions
and additional messages expand that same structure. Inline
prefix/template/suffix composition is not part of this format.

### Native template variables

Native template variables are substitution-only and use an ASCII identifier:
`[A-Za-z_][A-Za-z0-9_]*`. ASCII spaces, tabs, carriage returns, and line feeds
may surround that identifier inside a token, so `{{topic}}`, `{{ topic }}`, and
`{{\n  topic\n}}` all refer to the same canonical variable, `topic`. The
authored token bytes and source spans are retained; only rendering replaces the
complete token. Whitespace outside a token remains literal prompt content.

Other Unicode whitespace, empty bodies, internal whitespace, dotted names, and
arbitrary expression bodies are invalid native tokens. This grammar expansion
also applies to existing Project v9 content: opening a project with a previously
invalid spaced token recognizes it as a native variable, but does not rewrite
the project JSON or add a syntax-version field.

Version 5 represented single-message prompts as role-less fragments and stored
the role on each use. During migration a fragment becomes a one-message prompt.
If one legacy template was used under several roles, the migration keeps the
primary role on the original template and creates a role-labelled copy for each
additional role, then rewrites uses to the matching copy. This preserves output
roles without retaining a role override in the v6 contract. A v5 revision that
carries no messages at all has no faithful v6 form, so the migration refuses the
document rather than inventing one.

Template revisions are immutable. Saving changed content or defaults appends a
revision and advances `currentRevisionId`; saving an unchanged revision is a
no-op. Uses remain pinned until explicitly updated. Core helpers create
templates, append revisions, change the current pointer, enumerate usages, and
refuse to remove a revision that is current, last, or referenced. Separate
authored-use helpers insert a pinned use, replace its complete value map, update
it to the current revision while dropping obsolete assignments, detach it into
literal messages, or remove it.

Branching also respects authored-item boundaries. A complete template use is
copied into the child revision rather than flattened into generated messages.
A multi-message template use is atomic: branching after its final emitted message
preserves it, while branching inside the emitted set requires detaching the use
first. Literal and provider-produced messages remain literal items in the child.

## Recommended targets

A template may carry one optional `recommendedTarget`, pairing a project-owned
connection requirement with a provider model ID. It records the target the
template was authored or verified against, and never overrides the explicit
project/run target.

It belongs to the template, not to a revision. Revisions are immutable and uses
pin them, so recording it per revision would make "I verified this against
another model" append a content-identical revision and unpin every existing
use. Changing a recommendation is metadata: `currentRevisionId` and every
revision are left untouched.

Because a recommendation is advisory, the app surfaces disagreement rather than
resolving it. A recommendation differing from the run target is reported before
the run, and so is a request whose templates recommend different targets —
several templates may contribute to one request while that request can name
only one model. Neither case blocks the run.

External imports do not record a recommendation unless the caller opts in. The
source model comes from the external execution's own provider while the
connection requirement is one this project already owns, so the pairing is an
assertion the importer cannot verify; the n8n import surfaces it as a checkbox
that states the exact pair being written.

## Ownership boundaries

Project documents contain authored, shareable definitions:

- connection requirements without local profile or credential references
- conversations and their revisions
- tool definitions and project-scoped mock response fixtures
- project-scoped prompt templates and immutable template revisions
- the default conversation revision, model target, inference options, and
  enabled tools

External prompt imports retain a secret-free receipt containing source
identity, authored fields, expression evidence, warnings, and the deterministic
projection that was applied. Resolved-snapshot receipts are anchored by the
literal messages they created. Reusable-template receipts are anchored by the
immutable imported template revision through `externalImportId`; their
expression-to-variable mapping records how external syntax became native IL
variables. Removing an initial template use does not remove this provenance.
An edited template creates a new revision without direct-import provenance, and
the receipt is pruned only when its imported revision is removed.

They do not contain API keys, cookies, authorization headers, local profile
IDs, active editor selections, raw run traces, or browser/native filesystem
handles.

Run traces are separate diagnostic artifacts. Local profile metadata and
workbench preferences are application state. Credentials remain in the OS
credential store, an environment variable, or session memory.

## Template authoring session

The live Project v9 document is the canonical owner of template definitions and
authored conversation items. Opening the Templates workspace from an ad-hoc
request materializes an untitled in-memory project; it does not create a
machine-local template registry.

Per-run template overrides are session state keyed by template-use ID. They
survive reruns in the same project, are visibly distinct from saved use values,
and are cleared when another project is opened or imported. Detaching a use
requires confirmation and snapshots its effective resolved text, including any
active run-only overrides, into ordinary literal messages.

Before its first run, an in-memory active authored revision is an editable
draft. After that revision has produced a run, the next authored-item change
creates a child revision before applying the edit. A clean revision loaded from
or saved to a project is conservatively protected the same way because its
external trace history may not be loaded. Further edits remain on the new draft
until it is run or saved. Template definition revisions do not branch the
conversation because existing uses remain pinned; explicitly updating a use to
the new revision does.

## Validation and serialization

`packages/core/src/project.ts` owns the provider-neutral project types, strict
runtime schemas, reference-integrity checks, parser, and deterministic
serializer. Import rejects unknown fields, duplicate identifiers, dangling
references, secret-bearing provider options, and credential-bearing endpoint
URLs. Serialization uses stable key ordering, two-space indentation, and a
trailing newline.

All entities use stable, kind-prefixed IDs and ordered arrays. References use
IDs rather than array positions. Provider-native configuration is allowed only
inside explicit `providerOptions` objects.

## Evaluation suites

Project v7 added ordered `evaluationSuites` as authored, portable content. A
suite owns stable input-binding and case IDs. Each case owns an ordered list of
provider-neutral deterministic checks and may carry a reference answer for
human review; reference answers do not receive an automatic score.

An input binding has a human-readable name and targets one stable template-use
ID plus one template variable name. Cases store their values by input-binding
ID rather than display name, so renaming an input does not rewrite the dataset.
Every case supplies exactly one string value for every binding; an empty string
is an intentional value. A suite may have no cases while it is being authored,
but execution preflight will not treat that as a runnable dataset.

### Suite-owned input and execution

Project v8 gives every suite its own `input` and `execution`; v9 adds its
exposed tools and turn ceiling:

```json
"input": { "kind": "conversation-revision", "conversationRevisionId": "revision_example" },
"execution": {
  "target": { "connectionRequirementId": "connection_default", "model": "example-model" },
  "responseMode": "buffered",
  "options": { "temperature": 0.4 },
  "repetitions": 1,
  "toolIds": ["tool_weather"],
  "turnCeiling": 5
}
```

A suite therefore pins what it runs and how it runs it, and both travel with the
project. Editing Messages, the composer's model, or the composer's temperature
no longer changes what an evaluation sends: an author who wants the new prompt
points the suite at the new revision deliberately. Repetitions are portable
authored content rather than session state, so a shared suite reproduces the
same batch size elsewhere.

`execution.responseMode` defaults to `buffered` for new and migrated suites. A
batch is read after it finishes, so incremental delivery buys an evaluation
nothing while narrowing which providers the suite can run against. Streaming
remains selectable, and preflight reports a setup issue when the suite pins a
mode the mapped connection cannot serve.

The boundary is unchanged: `execution.target` names a *connection requirement*
and a model. The local profile, endpoint, protocol, and capabilities that
satisfy that requirement stay device-local and are supplied to an execution plan
as a separate `runtimeTarget`. Credentials and local profile identity never
enter a suite.

Selecting a revision still checks whether that revision contains each targeted
template use and variable. A revision-specific mismatch is a preflight
diagnostic rather than a parse error, because the suite may remain valid for
another historical branch. The portable project parser still rejects a use ID
that exists nowhere, a variable absent from every occurrence of that use,
incomplete or extra case values, repeated identities, invalid checks, and
secret-like target variable names. This prevents evaluation cases from becoming
a portable secret store.

`execution.toolIds` names project tools by ID, so exposure is portable and the
descriptors stay single-source: the plan snapshots them at start, exactly as an
ordinary run does. What *serves* each tool is device-local and joins at plan
time as a binding, never entering the project. A suite may not name a tool the
project does not have — the reference is validated like
`defaults.enabledToolIds`, and deleting a tool withdraws it from every suite in
the same mutation — and it may not name one twice.

`execution.turnCeiling` bounds the provider turns one repetition may spend
before it is failed, between 2 and 20. It is optional: an absent ceiling reads
as the shared default of 5. It is authored on the suite rather than at
confirmation because a repetition that reaches it fails, which makes the ceiling
part of what produced a result.

Project v8 migrates to v9 by exposing no tools and leaving the ceiling absent,
so an upgraded suite runs exactly as it did — with no tools, no repetition can
reach a second turn. Project v7 migrates to v8 by making each suite's borrowed
context explicit: the
project's default conversation revision becomes the suite input, and the
project's default target and inference options are copied into the suite, with
buffered delivery and one repetition. Copies are independent, so later changes
to the project defaults do not reach migrated suites. Project v6 migrates by
adding an empty suite collection first, and v5 uses the existing prompt-template
migration before that. Loading performs these migrations in memory; the
workspace is not rewritten until its ordinary explicit-save or auto-save path
runs.

### Starting an evaluation from a saved prompt

**Start from saved prompt…** is an authoring shortcut, not a second kind of
evaluation input. It appends an ordinary `ProjectConversationRevision`: a
prompt-only child of the revision the evaluation currently selects, in the same
conversation, carrying that revision as `parentRevisionId` and exactly one
`template-use` item pinned to the template's current immutable revision. The
use gets fresh stable use and output-message IDs and an empty authored `values`
map, so ordinary template defaults still apply and case bindings can still
supply the final override.

The shortcut does **not** advance `project.defaults.conversationRevisionId`: it
points the selected suite's `input` at the new revision and leaves the Messages
editor exactly where the author left it. `createRevisionFromSavedPrompt` itself
changes no suite; the evaluation authoring hook performs that update explicitly
after the revision exists, which keeps the core helper reusable and the
mutation visible. Historical revisions remain reachable through a secondary
picker, so the suite's own input stays the headline.

The child deliberately does not inherit its parent's items. That gives the
action predictable replacement semantics and makes it impossible to silently
duplicate a system message or an earlier prompt; a template's own multi-message
structure still arrives whole and ordered, because one use emits every message
of its pinned revision. Authors add surrounding messages afterwards in Messages.

Bindings, cases, and tools are untouched, other suites are untouched, and the
project stays at schema version 9 — the shortcut writes nothing a v9 parser did
not already accept. Because the new use has a new stable ID, existing suite
bindings are never retargeted onto it: an identical template ID says nothing
about whether a binding still resolves, so a suite that already has case inputs
is warned before the revision is created rather than silently rewritten.

Human revision descriptions are projected on demand from this data and are not
stored. A mutable `revisionName` on portable content would let a label drift
from the immutable revision an execution actually snapshotted.

## Tool mock semantics

A tool definition controls what may be sent to a model. A `ToolMock` supplies a
project-owned replacement value after the model calls that tool. It does not
control whether the tool is exposed or whether execution pauses.

Version 2 supports only `{"kind":"always"}` matching. Argument-based matching
can extend that discriminated union in a later schema version.

## Workspace adapters

The schema and serializer do not know about paths or platform handles.

- A supported browser asks the user for a directory and reads or writes the
  manifest directly through the File System Access API.
- Other browsers use explicit JSON import and export.
- Tauri opens a native directory picker and keeps authorized paths in Rust.
  The webview receives an opaque workspace ID, never a writable path.

The browser adapter remembers the granted directory handle for the most
recently opened project in IndexedDB (`inference-lens` /
`workspace-handles` / `last-project`). The record contains the handle, folder
name, and a display copy of the project name, never an absolute path or
manifest contents. On load the adapter re-verifies permission before touching
the folder and always re-reads `project.json`, so a remembered project follows
the same external-change rule as an explicitly opened one. Denied permission
or a missing project discards that remembered handle.

Both writable adapters compare the on-disk contents with the last contents
they read before saving. If an editor or Git operation changed the manifest,
Inference Lens refuses to overwrite it and asks the user to reopen the project.

Completed, cancelled, and explicitly stopped runs are written as immutable
`traces/<runId>.json` diagnostic artifacts. A repeated byte-identical write is
allowed; different contents can never replace an existing run ID. These files
are deliberately outside the Project v9 manifest contract, so adding or
removing a trace does not dirty authored project state. See
[the run trace format](RUN_TRACE_FORMAT.md).

`attachments/` remains reserved for a later format and is not part of the
version 3 manifest contract.
