# Project format and workspace storage

Inference Lens projects use a visible `<name>.inference-lens/` directory bundle
containing one canonical, portable JSON document named `project.json`. New
saves use schema version 17. The parser also opens versions 10, 11, 12, 13, 14,
15 and 16 and upgrades them on load. From v10, the protocol it kept on each connection
requirement (always chat completions) moves onto every execution target that
names that requirement — the project default and each suite's
`execution.target` — and the requirement loses the field. See
[Connection protocols](#connection-protocols). v12 adds check vocabulary 4
(JSON Schema checks and JSON input policies; see
[Deterministic checks](DETERMINISTIC_CHECKS.md)); a v10 or v11 document was
written with vocabulary 3, so one that contains a v4 construct is rejected
rather than upgraded. v13 adds project-owned [decision requests](#decision-requests);
a v12 document opens with none, and one that already holds any is rejected. v14
adds [decision suites](#decision-suites) and check vocabulary 5 (the decision
checks); a v13 document was written with chat suites and vocabulary 4, so one
holding either is rejected rather than upgraded. v15 adds typed chat/decision
templates and inline/template-use decision request revisions. Legacy templates
gain `kind: "chat"`; legacy decision revisions gain `kind: "inline"`, with
IDs, drafts, defaults, provenance and suite pins preserved. v16 adds
[prompt environments](#prompt-environments); a v15 document opens with none, and
one that already holds or selects any is rejected. v17 adds
[whole-file prompt imports](#file-prompt-imports); a v16 document opens
unchanged, and one that already holds a file receipt is rejected. Earlier project
formats, including v5–v9, and the proof-of-concept request export are rejected
with a version error rather than upgraded on load.
Every schema is strict, so a reader rejects a document it does not understand
rather than guessing.

## Git sharing policy

When creating a bundle (including the first folder save of an imported project),
choose one of three presets:

| Preset | Bundle-local `.gitignore` |
| --- | --- |
| Keep this project out of Git (default) | `*` excludes the entire bundle from ordinary staging |
| Share definitions; keep run history local | Allows only `.gitignore` and `project.json` |
| Manage Git rules myself | No generated ignore file |

The definitions preset writes exactly:

```gitignore
*
!/.gitignore
!/project.json
```

This allowlist excludes traces, experiment plans/results/reassessments,
baseline pins, case-source annotations, and future artifact directories by
default. Opening a clone with just the manifest and policy needs no run history;
running creates local evidence without registering trace paths in the manifest.

**Everything in `project.json` is shared**, including persisted prompt drafts,
saved input/default values, tools, mock fixtures, imports, and historical or
archived revisions. Evidence copied into a saved asset also becomes authored
content in the manifest. This preset does not yet separate personal drafts and
experimental settings from reusable definitions. See the
[shared-assets plan](SHARED_ASSETS_PERSONAL_WORKBENCH_PLAN.md) for that later work.

The browser and native adapters write the selected policy before project
content. The policy is creation-only workspace metadata, outside the project document;
opening and saving never regenerate it or overwrite customized rules. The app
does not initialize a Git repository, stage files, commit, or push.

### Existing projects and already tracked files

Existing policies remain untouched. To opt an existing bundle into definitions
sharing, intentionally replace its bundle-local `.gitignore` with the exact
three-line policy above. Inside that bundle, inspect what Git already tracks
and what the new policy excludes:

```sh
git ls-files -- .
git ls-files -- traces/ experiments/ evaluation-baselines.json evaluation-case-sources.json
git status --short --ignored -- .
```

Gitignore controls ordinary staging; it is not access control. It does not
untrack existing files, remove content from earlier commits, or prevent
`git add --force`. Review tracked evidence before sharing. If you choose to
stop tracking a file while keeping its local copy, use
`git rm --cached -- <reviewed-file>` and review the staged change. Previously
committed content remains in history. Inference Lens never removes files from
the Git index or rewrites history for you. Parent-repository rules can also
exclude the bundle, so inspect `git status` before committing.

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
also applies to existing Project v10 content: opening a project with a previously
invalid spaced token recognizes it as a native variable, but does not rewrite
the project JSON or add a syntax-version field.

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

The UI calls this a **Recommended model**, with its connection shown separately.
The library and insertion picker show the recommendation before reuse. Each
inserted prompt shows a model mismatch beside its content, with **Choose model**
and **Dismiss** actions. Choosing opens the model field; insertion never changes
the selected model automatically. Matching model IDs on different connections
are not reported as model mismatches.

Dismissals belong to the local feature session, per inserted use and its current
comparison. They survive mode navigation and expire when the selected model or
recommendation changes, the use is removed, or the app reloads. They are not
serialized into the project or shared with collaborators. Chat run readiness
retains an aggregate advisory when inserted prompts recommend different models;
individual mismatch advice lives on the prompt cards. Neither blocks a run.

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
- decision requests and their revisions

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

### File prompt imports

From v17, a `.md` or `.txt` file can be imported as one saved chat prompt with
a receipt whose `source.adapter` is `"file"`. The receipt's
`source.resource.id` and `name` are the bare filename, its invocation is
`{ type: "file", id: "content" }` with the filename stem as its name, and
`invocation.version` records `expression-v1` or `plain-text-v1`. The authored
text is the strictly decoded UTF-8 file without an initial BOM, with its line
endings preserved. n8n expressions become variables with no recorded value.
In the projected template every literal `{{` gains one backslash (`\{{`), so
native rendering reproduces the file's text; receipt validation reproduces
that projection. Other adapters keep their unescaped projection. A v16
reader applies no escaping, which is why file receipts need v17 and a v16
document holding one is rejected. Updating a prompt from its file appends a
revision anchored to one more file receipt for the same template, so a
template may hold several, in `externalImports` order; this needs no new
version. See the
[external prompt sources plan](SHARED_ASSETS_PERSONAL_WORKBENCH_PLAN.md#external-prompt-sources).

## Template authoring session

The live project document is the canonical owner of template definitions and
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

## Prompt environments

From v16, `environments` holds named sets of values that fill native template
variables by name, so switching the environment changes what every template
use renders. The design is in the
[prompt environments plan](PROMPT_ENVIRONMENTS_PLAN.md).

```json
{
  "id": "environment_staging",
  "name": "Staging",
  "entries": [
    { "name": "customer", "value": "Acme" },
    { "name": "greeting", "value": "Hello {{customer}}" }
  ]
}
```

- Names are unique within the project ignoring case and surrounding
  whitespace. Entry names follow the native variable grammar, are unique within
  the environment, and cannot be secret-like. Values can't be checked for
  secrets; environments travel with the project.
- An entry may reference other entries of the same environment with ordinary
  `{{name}}` tokens. References are resolved once, in dependency order, and the
  result is literal. A cycle makes the project invalid. A missing reference
  renders as its token with a diagnostic.
- Limits, in UTF-16 code units: 50 environments per project, 200 entries per
  environment and 65,536 per authored value. Resolution also stops when one
  entry would exceed 150,000 or the whole environment 1,000,000.
- `defaults.environmentId` is the project's launch default, and a chat suite's
  `execution.environmentId` the one its cases render against. Each must name an
  existing environment. An environment that anything selects cannot be
  deleted; the refusal lists what uses it.

Precedence, lowest first: template default, environment, use value, run
override, evaluation case value. An environment fills only the variables a
pinned template revision references.

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

Ordered `evaluationSuites` are authored, portable content. A
suite owns stable input-binding and case IDs. Each case owns an ordered list of
provider-neutral deterministic checks and may carry a reference answer for
human review; reference answers do not receive an automatic score.

An input binding has a human-readable name and targets one stable template-use
ID plus one template variable name. Cases store their values by input-binding
ID rather than display name, so renaming an input does not rewrite the dataset.
Every chat case supplies exactly one string value for every binding; an empty
string is an intentional value. A decision case may leave a binding unfilled
(see [decision suites](#decision-suites)). A suite may have no cases while it is being authored,
but execution preflight will not treat that as a runnable dataset.

### Suite-owned input and execution

Every suite owns its own `input` and `execution`, including its exposed tools
and turn ceiling:

```json
"input": { "kind": "conversation-revision", "conversationRevisionId": "revision_example" },
"execution": {
  "target": {
    "connectionRequirementId": "connection_default",
    "model": "example-model",
    "protocol": "openai-compatible-chat-completions"
  },
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

`execution.responseMode` defaults to `buffered` for new suites. A
batch is read after it finishes, so incremental delivery buys an evaluation
nothing while narrowing which providers the suite can run against. Streaming
remains selectable, and preflight reports a setup issue when the suite pins a
mode the mapped connection cannot serve.

The boundary is unchanged: `execution.target` names a *connection requirement*,
a model, and the protocol to speak to it. The local profile, endpoint, and
capabilities that
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

### Configurations

Each suite also carries `variants` — at least one, named uniquely within the
suite ignoring case and surrounding whitespace. A variant is stored as sparse
`overrides` on the suite's base `execution`: an optional `target`
(any of `connectionRequirementId`, `model`, `protocol`), `responseMode`, and `options`
(`temperature`, `maxOutputTokens`, `seed`, `stop`, `providerOptions`). An absent
field inherits from the base, and `null` in `options` clears the value to the
provider default. A variant's connection requirement must exist in the project.
A variant may also set `environmentId`: absent inherits the suite's
`execution.environmentId`, and `null` runs the variant with no environment.
Repetitions, `toolIds`, and `turnCeiling` are shared by every variant. See
[the evaluation suite authoring guide](EVALUATION_SUITE_AUTHORING.md) for how
configurations are authored and compared.

### Decision suites

A suite whose `input.kind` is `decision-request-revision` runs a pinned
[decision request](#decision-requests) revision instead of a conversation. Its
`execution` holds only a target and repetitions; there is no response mode,
inference options, tools, or turn ceiling:

```json
"input": { "kind": "decision-request-revision", "decisionRequestRevisionId": "decision-revision_example" },
"execution": {
  "target": {
    "connectionRequirementId": "connection_default",
    "model": "local-decision",
    "protocol": "systemone"
  },
  "repetitions": 3
}
```

The connection requirement carries nothing about System One: whether a profile
speaks it stays a device-local declaration. A configuration may override the
target only.

An input binding targets `{ "kind": "decision-variable", "variableName": … }`.
A case value overrides the pinned revision's effective value for that variable;
a variable with no binding keeps the revision's value. For a template-backed
request, precedence is template defaults, request overrides, then case values.
An explicitly supplied empty string is a value; an absent assignment remains
unresolved. From v15 a decision case may omit a binding's value: that case is
unfilled, and preflight blocks it with `empty-case-value` rather than falling
back to the revision's value. New cases and inputs start unfilled, and clearing
a case field in the editor removes its value. The parser rejects a
secret-like variable name. Whether the pinned revision uses each bound
variable, whether every variable resolves for each case, and whether each
decision check names a question of the right type and a real option are
preflight diagnostics, since the suite stays valid while its author repoints it.

Each suite kind holds only its own checks: a decision suite refuses checks that
read chat output or tool calls, and a chat suite refuses decision checks.
`max-duration-ms` and `max-total-tokens` fit both. A hand-edited document that
mixes them is rejected.

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
project's schema version is unchanged — the shortcut writes nothing the current
parser did not already accept. Because the new use has a new stable ID, existing suite
bindings are never retargeted onto it: an identical template ID says nothing
about whether a binding still resolves, so a suite that already has case inputs
is warned before the revision is created rather than silently rewritten.

Human revision descriptions are projected on demand from this data and are not
stored. A mutable `revisionName` on portable content would let a label drift
from the immutable revision an execution actually snapshotted.

## Decision requests

System One decision requests (see [the protocol plan](SYSTEM_ONE_PROTOCOL_PLAN.md),
D31 and D38–D43) are authored, portable content beside conversations.
`decisionRequests` holds `{ id, name }`; `decisionRequestRevisions` holds each
revision:

```json
{
  "id": "decision-revision_example",
  "kind": "inline",
  "decisionRequestId": "decision-request_example",
  "decision": {
    "state": { "ticket": "{{ticket}}" },
    "questions": {
      "intent": {
        "type": "choice",
        "instructions": "What is the customer asking about?",
        "criteria": { "billing": "Charges or refunds.", "other": null }
      }
    }
  },
  "values": { "ticket": "I was charged twice." },
  "createdAt": "2026-10-24T12:00:00.000Z"
}
```

`decision` is sent as written, so it keeps its authored key order in every
serialization: question order and option order are meaning. An optional
`parentRevisionId` names the revision of the same request it was branched
from, and the optional `defaults.decisionRequestRevisionId` names the revision
Decision Compose opens. No decision target is stored; the connection and model
are chosen per session.

Native template variables (the grammar above, `\{{` escaping) may appear in
string values anywhere in `state` and in question `instructions`, never in
object keys or criteria. `values` gives one string per variable, may name only
variables the revision uses, and never a secret-like name. A variable with no
value is valid authored state; a run is refused until every variable resolves,
and the run trace records the resolved request that was sent.

Decision Compose edits the active revision in place until it has run in the
session or was loaded from disk; the next edit then appends a child and moves
the default. Only a draft that validates is written: while the editor shows
problems, the project keeps the last valid revision. An untouched starting
draft never creates a request.

Writing that last valid revision does not mark an incomplete editor draft as
saved. The project retains its unsaved marker and unload/replacement protection.
Manual save, export, and "Save and switch" refuse the incomplete draft; fixing
it allows saving, while "Discard and switch" explicitly abandons it. Incomplete
editor state is never added to the portable project format.

## Tool definition source

A `ToolDefinition` attached from an MCP server carries an optional
`source: { kind: "mcp", remoteToolName, discoveryFingerprint }` receipt. The
fingerprint is the SHA-256 of the discovered descriptor. The receipt names no
server profile, endpoint, credential, or session, so a project stays readable
and runnable as data on a device without that server; editing the definition
removes the receipt. Which server serves the tool is device-local. See
[MCP discovery](MCP_DISCOVERY.md).

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
are deliberately outside the Project v10 manifest contract, so adding or
removing a trace does not dirty authored project state. See
[the run trace format](RUN_TRACE_FORMAT.md).

`attachments/` remains reserved for a later format and is not part of the
version 3 manifest contract.

## Connection protocols

The wire protocol a run speaks is part of its execution target, beside the
model — in `defaults.target` for the composer, and in each suite's
`execution.target` and variant `overrides.target`:

```json
"target": {
  "connectionRequirementId": "connection_default",
  "model": "gpt-4.1-mini",
  "protocol": "openai-responses"
}
```

`protocol` is one of `openai-compatible-chat-completions`, `openai-responses`,
or `anthropic-messages`. Version 11 added the last two, and the
`anthropicMessages` key to `capabilityOverrides`; a project using either cannot
be opened by a build that only reads version 10, which is why the version
changed.

It lives on the target rather than on the connection requirement because it is
a choice about a run, not a fact about the provider. Changing the composer's
protocol in Run settings edits only `defaults.target`; a suite keeps the
protocol it states, and one configuration can compare Responses against chat
completions on the same connection by overriding it. A connection requirement
states only which protocols it can serve, through `capabilityOverrides`.

The local profile mapped to the target's requirement must have the protocol
enabled. A composer run is blocked with a notice that offers enabling it in
Connections or choosing another in Run settings — or, when the server manages
the profile's protocols through `INFERENCE_LENS_API_PROTOCOLS`, choosing another
protocol or connection. An evaluation refuses to start, naming the
configuration whose protocol its profile does not serve.

### Saved decision templates (core support)

Project v15 stores both template kinds in `promptTemplates`. Each entry has
`kind: "chat" | "decision"`; the kind is fixed for its lifetime. Chat revisions
and drafts contain `messages`; decision revisions and drafts contain authored
`decision` input. Both share `variableDefaults`, revision metadata, archive
state and optional advisory target recommendations. Only chat revisions may
anchor n8n import receipts. Drafts use the same `sourceRevisionId` and
`revisionName` envelope for both kinds.

A decision request revision may pin a decision template instead of storing an
inline copy:

```json
{
  "id": "decision-revision_use",
  "decisionRequestId": "decision-request_example",
  "kind": "template-use",
  "templateId": "template_triage",
  "templateRevisionId": "template-revision_triage-1",
  "overrides": { "ticket": "" },
  "createdAt": "2026-10-25T12:00:00.000Z"
}
```

The reference is the sole content source. Resolution clones authored input and
merges pinned defaults with supplied overrides; absent keys are never filled
with empty strings. Variables render only at the run boundary. Unfilled or
malformed tokens may be saved but block execution. The parser rejects mixed
content, cross-kind references, missing pins, and decision assignments naming
unused or secret-like variables. Legacy chat default validation is unchanged.

Core operations create templates, persist valid drafts, append immutable
revisions, create uses, edit overrides, update pins and detach. Source saves
never move existing pins. Update appends a child request revision, retaining
overrides only for surviving variables. Detach appends an inline child with
authored tokens and available effective assignments, including unresolved gaps.
Archive keeps historical pins resolvable, and usage discovery includes request
revisions and their suites, protecting referenced source revisions from removal.
Question and criteria ordering survive serialization, equality and revision
diffs. Experiment and trace formats continue storing resolved input.

The browser library and chat pickers currently show chat templates only. Decision
template authoring and pinned-use Compose controls follow in the next slice of
[the Saved Prompts plan](archive/SYSTEM_ONE_SAVED_PROMPTS_PLAN.md); existing decision
suites and the CLI can already execute valid template-backed project inputs.
