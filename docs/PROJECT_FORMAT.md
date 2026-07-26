# Project format and workspace storage

Trace Lens projects use one canonical, portable JSON document named
`trace-lens.project.json`. New saves use schema version 3. Version 2 projects
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
value at that level.

A message-set use has one stable `outputMessageIds` entry per template message.
A fragment use has exactly one output message ID and a required
`fragmentRole`. In version 3 a fragment supplies the complete text of one
generated system, user, or assistant message. Inline prefix/template/suffix
composition is not part of this format and may later be introduced as a new
authored-item or content-part variant.

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

They do not contain API keys, cookies, authorization headers, local profile
IDs, active editor selections, raw run traces, or browser/native filesystem
handles.

Run traces are separate diagnostic artifacts. Local profile metadata and
workbench preferences are application state. Credentials remain in the OS
credential store, an environment variable, or session memory.

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
Trace Lens refuses to overwrite it and asks the user to reopen the project.

Completed, cancelled, and explicitly stopped runs are written as immutable
`traces/<runId>.json` diagnostic artifacts. A repeated byte-identical write is
allowed; different contents can never replace an existing run ID. These files
are deliberately outside the Project v2 manifest contract, so adding or
removing a trace does not dirty authored project state. See
[the run trace format](RUN_TRACE_FORMAT.md).

`attachments/` remains reserved for a later format and is not part of the
version 2 manifest contract.
