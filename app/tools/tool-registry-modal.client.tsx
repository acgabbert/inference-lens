"use client";

import { useState } from "react";

import {
  createRegistryTool,
} from "../../packages/core/src/tool-registry";
import type {
  RegistryTool,
  RegistryToolId,
  ToolRegistryV1,
} from "../../packages/core/src/tool-registry";
import type { ConfirmationDialogRequest } from "../confirmation-dialog.client";
import { ModalDialog } from "../modal-dialog.client";
import { ToolDefinitionEditor } from "../tool-definition-editor.client";
import { randomUUID } from "../../packages/core/src/random-id";
import type { ToolDefinition } from "../../packages/core/src/run-kernel";
import type { ToolAttachmentDestination } from "../request/use-request-draft.client";
import { AttachDestinationControl } from "./attach-destination-control.client";

interface ToolRegistryModalProps {
  open: boolean;
  registry: ToolRegistryV1;
  onChange(registry: ToolRegistryV1): void;
  /** Chosen in the menu that opened the library; changeable here. */
  destination: ToolAttachmentDestination;
  onDestinationChange(destination: ToolAttachmentDestination): void;
  onAttach(tool: RegistryTool, destination: ToolAttachmentDestination): ToolDefinition | string;
  requestConfirmation(request: ConfirmationDialogRequest): void;
  onClose(): void;
}

export function ToolRegistryModal({
  open,
  registry,
  onChange,
  destination,
  onDestinationChange,
  onAttach,
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

  function attach(): void {
    const saved = saveDraft();
    if (!saved) return;
    const attached = onAttach(saved, destination);
    if (typeof attached === "string") {
      setError(attached);
      setNotice(undefined);
      return;
    }
    setError(undefined);
    setNotice(
      destination === "project"
        ? "Attached to the project. A copy is saved with the project."
        : "Attached in this tab only.",
    );
  }

  return (
    <ModalDialog
      backdropClassName="registry-backdrop"
      className="registry-modal"
      labelledBy="tool-registry-title"
      onClose={onClose}
    >
      <header className="registry-header">
        <div>
          <span className="eyebrow">Local library</span>
          <h2 id="tool-registry-title">Local tool library</h2>
          <p>
            Available in this app and reusable across projects. It accompanies
            a request only after you attach a copy.
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
                    className="button primary"
                    disabled={!schemaValid}
                    title="Saves this definition, then attaches a copy of it."
                    type="button"
                    onClick={attach}
                  >
                    Attach
                  </button>
                </div>
              </div>
              <AttachDestinationControl value={destination} onChange={onDestinationChange} />
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
    </ModalDialog>
  );
}
