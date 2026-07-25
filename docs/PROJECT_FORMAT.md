# Project format and workspace storage

Trace Lens projects use one canonical, portable JSON document named
`trace-lens.project.json`. The current format begins at schema version 2; the
earlier proof-of-concept request export is intentionally unsupported.

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

Project folders may later contain `traces/` and `attachments/`, but those
directories are not part of the version 2 manifest contract.
