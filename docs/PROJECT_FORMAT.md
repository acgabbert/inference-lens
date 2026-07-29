# Project format and workspace storage

Inference Lens projects use one canonical, portable JSON document named
`inference-lens.project.json`. New saves use schema version 3. Version 2 projects
remain importable and are migrated in memory; the earlier proof-of-concept
request export is intentionally unsupported.

## Version 3 authored conversations

Version 3 separates authored conversation items from the ordinary messages
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
        "outputMessageIds": ["message_question"],
        "fragmentRole": "user"
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
retaining hidden assignments; Version 2 migration still preserves existing
template definitions byte-for-byte at the data-model level.

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

A message-set use has one stable `outputMessageIds` entry per template message.
A fragment use has exactly one output message ID and a required
`fragmentRole`. In version 3 a fragment supplies the complete text of one
generated system, user, or assistant message. Inline prefix/template/suffix
composition is not part of this format and may later be introduced as a new
authored-item or content-part variant.

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
A message-set use is atomic: branching after its final emitted message
preserves it, while branching inside the emitted set requires detaching the use
first. Literal and provider-produced messages remain literal items in the child.

Version 2 migration wraps each existing revision message as
`{"kind":"message","message":...}` in the same order. It retains template
definitions but invents no template uses.

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

The live Project v3 document is the canonical owner of template definitions and
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

Both writable adapters compare the on-disk contents with the last contents
they read before saving. If an editor or Git operation changed the manifest,
Inference Lens refuses to overwrite it and asks the user to reopen the project.

Completed, cancelled, and explicitly stopped runs are written as immutable
`traces/<runId>.json` diagnostic artifacts. A repeated byte-identical write is
allowed; different contents can never replace an existing run ID. These files
are deliberately outside the Project v3 manifest contract, so adding or
removing a trace does not dirty authored project state. See
[the run trace format](RUN_TRACE_FORMAT.md).

`attachments/` remains reserved for a later format and is not part of the
version 3 manifest contract.
