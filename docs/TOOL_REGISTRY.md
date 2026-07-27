# Local tool registry

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

The web and desktop frontends currently persist independent registry snapshots
under the versioned local-storage key `inference-lens:tool-registry:v1`. Moving the
registry workspace from its modal shell to a future route does not require a
storage or editor contract change.
