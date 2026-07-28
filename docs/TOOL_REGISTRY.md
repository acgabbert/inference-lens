# Tool registry

Inference Lens keeps reusable tool definitions in a versioned, local registry.
Registry data is separate from portable Project v2 files and never contains
credentials or executor configuration.

Each registry tool owns a stable `registry-tool_*` identity. Attaching one
creates a detached `ToolDefinition` snapshot with a fresh `tool_*` identity:

- **Attach to project** copies the snapshot into the current project draft's
  existing `tools` collection and enables it by default. The draft can be new
  and unsaved or loaded from an existing Project v2 file.
- **Attach to next request** holds a one-shot snapshot in the composer. It is
  captured in `ResolvedRunInput` when the run starts and then cleared.

Later registry edits do not change project copies, pending run snapshots, or
historical traces. This preserves Project v2 portability and deterministic run
inspection without introducing registry links into the project format.

The schema builder and Advanced JSON mode edit the same JSON Schema object.
Structured edits preserve keywords they do not display. Advanced JSON accepts
any object-shaped schema and prevents save or attachment while the text is
invalid.

The desktop frontend remains local-only. The web frontend keeps a versioned
browser cache under `inference-lens:tool-registry:v1`; it is the primary store
when `/data` is unavailable, including source development and a bare
`docker run`.

Compose bind-mounts a host directory at `/data`. When it exists, the web
server makes `/data/tool-registry.json` authoritative for every browser using
that deployment. The file is strictly validated, atomically replaced, and
guarded by a revision CAS token. Existing browser-local data is retained as a
recovery copy but is not automatically imported into an empty shared registry.

Concurrent edits to different tools merge automatically once. Changes to the
same tool (including delete-versus-edit) do not overwrite either side: the UI
keeps the pending local copy and offers explicit choices to use the server
version or overwrite it. Network, permissions, corrupt-file, and server errors
also preserve the cached pending copy and are shown as degraded storage rather
than silently falling back to a healthy-looking local library.
