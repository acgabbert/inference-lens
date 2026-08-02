"use client";

import { useEffect, useState } from "react";

import {
  createRegistryTool,
} from "../packages/core/src/tool-registry";
import type {
  RegistryTool,
  RegistryToolId,
  ToolRegistryV1,
} from "../packages/core/src/tool-registry";
import type { ConfirmationDialogRequest } from "./confirmation-dialog.client";
import { ToolDefinitionEditor } from "./tool-definition-editor.client";
import { randomUUID } from "../packages/core/src/random-id";

interface ToolRegistryModalProps {
  open: boolean;
  registry: ToolRegistryV1;
  onChange(registry: ToolRegistryV1): void;
  onAttachToProject(tool: RegistryTool): string | undefined;
  onAttachToRequest(tool: RegistryTool): string | undefined;
  requestConfirmation(request: ConfirmationDialogRequest): void;
  onClose(): void;
}

export function ToolRegistryModal({
  open,
  registry,
  onChange,
  onAttachToProject,
  onAttachToRequest,
  requestConfirmation,
  onClose,
}: ToolRegistryModalProps) {
  const initialTool = registry.tools[0];
  const [selectedId, setSelectedId] = useState<RegistryToolId | undefined>(
    initialTool?.id,
  );
  const [draft, setDraft] = useState<RegistryTool | undefined>(() =>
    initialTool ? structuredClone(initialTool) : undefined,
  );
  const [schemaValid, setSchemaValid] = useState(true);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const selected = registry.tools.find(({ id }) => id === selectedId);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose, open]);

  if (!open) return null;

  function selectTool(tool: RegistryTool): void {
    setSelectedId(tool.id);
    setDraft(structuredClone(tool));
    setSchemaValid(true);
    setError(undefined);
    setNotice(undefined);
  }

  function addTool(): void {
    const now = new Date().toISOString();
    const tool = createRegistryTool(
      `registry-tool_${randomUUID()}`,
      now,
      registry.tools.length,
    );
    onChange({ ...registry, tools: [...registry.tools, tool] });
    setSelectedId(tool.id);
    setDraft(structuredClone(tool));
    setNotice(undefined);
  }

  function saveDraft(): RegistryTool | undefined {
    if (!draft) return;
    if (!draft.name.trim()) {
      setError("Function name is required.");
      return;
    }
    if (!schemaValid) {
      setError("Fix the JSON Schema before saving.");
      return;
    }
    const saved = {
      ...draft,
      name: draft.name.trim(),
      updatedAt: new Date().toISOString(),
    };
    onChange({
      ...registry,
      tools: registry.tools.map((tool) =>
        tool.id === saved.id ? saved : tool,
      ),
    });
    setDraft(structuredClone(saved));
    setError(undefined);
    return saved;
  }

  function removeSelected(): void {
    if (!selected) return;
    const toRemove = selected;
    requestConfirmation({
      title: `Delete "${toRemove.name}"?`,
      description:
        "Removes this definition from the local tool library. This can't be undone, but any project or request that already attached a copy keeps its own snapshot and is not affected.",
      confirmLabel: "Delete tool",
      destructive: true,
      ...(toRemove.description
        ? { details: [{ label: "Description", value: toRemove.description }] }
        : {}),
      onConfirm() {
        const tools = registry.tools.filter(({ id }) => id !== toRemove.id);
        onChange({ ...registry, tools });
        const next = tools[0];
        setSelectedId(next?.id);
        setDraft(next ? structuredClone(next) : undefined);
      },
    });
  }

  function attach(kind: "project" | "request"): void {
    const saved = saveDraft();
    if (!saved) return;
    const attachmentError =
      kind === "project"
        ? onAttachToProject(saved)
        : onAttachToRequest(saved);
    if (attachmentError) {
      setError(attachmentError);
      setNotice(undefined);
      return;
    }
    setError(undefined);
    setNotice(
      kind === "project"
        ? "Snapshot attached to the current project draft."
        : "Snapshot attached to the next request.",
    );
  }

  return (
    <div className="registry-backdrop" role="presentation">
      <section
        aria-labelledby="tool-registry-title"
        aria-modal="true"
        className="registry-modal"
        role="dialog"
      >
        <header className="registry-header">
          <div>
            <span className="eyebrow">Local library</span>
            <h2 id="tool-registry-title">Local tool library</h2>
            <p>
              Saved in this app and reusable across projects. Sent only after
              you copy or attach it.
            </p>
          </div>
          <button className="button secondary" type="button" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="registry-workspace">
          <aside className="registry-sidebar">
            <button className="button primary" type="button" onClick={addTool}>
              + New library tool
            </button>
            <div className="registry-list">
              {registry.tools.length === 0 ? (
                <p className="tool-empty">
                  Create a reusable tool definition to get started.
                </p>
              ) : (
                registry.tools.map((tool) => (
                  <button
                    aria-current={tool.id === selectedId}
                    className={
                      tool.id === selectedId
                        ? "registry-list-item selected"
                        : "registry-list-item"
                    }
                    key={tool.id}
                    type="button"
                    onClick={() => selectTool(tool)}
                  >
                    <strong>{tool.name}</strong>
                    <span>{tool.description || "No description"}</span>
                  </button>
                ))
              )}
            </div>
          </aside>
          <div className="registry-editor">
            {draft ? (
              <>
                <div className="registry-editor-toolbar">
                  <div>
                    <span className="eyebrow">Definition</span>
                    <strong>{selected?.name ?? draft.name}</strong>
                  </div>
                  <div className="registry-editor-actions">
                    <button
                      className="remove-button"
                      type="button"
                      onClick={removeSelected}
                    >
                      Delete
                    </button>
                    <button
                      className="button secondary"
                      disabled={!schemaValid}
                      type="button"
                      onClick={() => saveDraft()}
                    >
                      Save
                    </button>
                    <button
                      className="button secondary"
                      disabled={!schemaValid}
                      title="Copy a snapshot into the current project draft."
                      type="button"
                      onClick={() => attach("project")}
                    >
                      Copy to project
                    </button>
                    <button
                      className="button primary"
                      disabled={!schemaValid}
                      type="button"
                      onClick={() => attach("request")}
                    >
                      Use on next request
                    </button>
                  </div>
                </div>
                {error && <div className="registry-error">{error}</div>}
                {notice && <div className="registry-notice">{notice}</div>}
                <ToolDefinitionEditor
                  key={draft.id}
                  value={draft}
                  onChange={(value) => {
                    setDraft({ ...draft, ...value });
                    setError(undefined);
                    setNotice(undefined);
                  }}
                  onSchemaValidityChange={setSchemaValid}
                />
              </>
            ) : (
              <div className="registry-empty">
                <span className="empty-glyph" aria-hidden="true">⌘</span>
                <h3>Your local tool library is empty</h3>
                <p>
                  Create a definition, then add it to a project or request.
                </p>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
