"use client";

import { useMemo, useState } from "react";

import type {
  ProjectTemplateDiagnostic,
  PromptTemplate,
  PromptTemplateContent,
  PromptTemplateUse,
} from "../packages/core/src/project";
import { isSensitiveTemplateVariableName } from "../packages/core/src/project";
import type {
  PromptTemplateId,
  PromptTemplateRevisionId,
} from "../packages/core/src/run-kernel";
import {
  discoverTemplateVariables,
  resolveTemplateValues,
} from "../packages/core/src/template-engine";

type TemplateRole = "system" | "user" | "assistant";

interface ProjectTemplatesPaneProps {
  templates: PromptTemplate[];
  usageCounts: ReadonlyMap<PromptTemplateId, number>;
  itemCount: number;
  onCreate(name: string, content: PromptTemplateContent): PromptTemplateId;
  onSave(
    templateId: PromptTemplateId,
    name: string,
    content: PromptTemplateContent,
    defaults: Record<string, string>,
  ): PromptTemplateRevisionId;
  onInsert(
    templateId: PromptTemplateId,
    role: TemplateRole,
    itemIndex: number,
  ): void;
}

function newFragment(): PromptTemplateContent {
  return { kind: "fragment", text: "Write about {{topic}}." };
}

function currentRevision(template: PromptTemplate) {
  return template.revisions.find(({ id }) => id === template.currentRevisionId)!;
}

export function ProjectTemplatesPane({
  templates,
  usageCounts,
  itemCount,
  onCreate,
  onSave,
  onInsert,
}: ProjectTemplatesPaneProps) {
  const [selectedId, setSelectedId] = useState<PromptTemplateId | undefined>(
    templates[0]?.id,
  );
  const selected =
    templates.find(({ id }) => id === selectedId) ?? templates[0];
  const initialRevision = selected ? currentRevision(selected) : undefined;
  const [viewedRevisionId, setViewedRevisionId] =
    useState<PromptTemplateRevisionId | undefined>(initialRevision?.id);
  const [name, setName] = useState(selected?.name ?? "");
  const [content, setContent] = useState<PromptTemplateContent>(
    initialRevision ? structuredClone(initialRevision.content) : newFragment(),
  );
  const [defaults, setDefaults] = useState<Record<string, string>>(
    initialRevision ? { ...initialRevision.variableDefaults } : {},
  );
  const [fragmentRole, setFragmentRole] = useState<TemplateRole>("user");
  const [insertionIndex, setInsertionIndex] = useState(itemCount);

  const viewedRevision = selected?.revisions.find(
    ({ id }) => id === viewedRevisionId,
  ) ?? initialRevision;
  const readOnly = Boolean(
    selected && viewedRevision?.id !== selected.currentRevisionId,
  );
  const discovery = useMemo(
    () => discoverTemplateVariables(content),
    [content],
  );
  const duplicateName = templates.some(
    (template) =>
      template.id !== selected?.id &&
      template.name.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase(),
  );
  const sensitiveAssignedVariables = discovery.variables.filter(
    ({ name }) =>
      isSensitiveTemplateVariableName(name) && Object.hasOwn(defaults, name),
  );

  function selectTemplate(template: PromptTemplate): void {
    const revision = currentRevision(template);
    setSelectedId(template.id);
    setViewedRevisionId(revision.id);
    setName(template.name);
    setContent(structuredClone(revision.content));
    setDefaults({ ...revision.variableDefaults });
  }

  function selectRevision(revisionId: PromptTemplateRevisionId): void {
    if (!selected) return;
    const revision = selected.revisions.find(({ id }) => id === revisionId);
    if (!revision) return;
    setViewedRevisionId(revision.id);
    setContent(structuredClone(revision.content));
    setDefaults({ ...revision.variableDefaults });
  }

  function addTemplate(kind: PromptTemplateContent["kind"]): void {
    const content =
      kind === "fragment"
        ? newFragment()
        : {
            kind: "messages" as const,
            messages: [
              { role: "system" as const, content: "You are helpful." },
              { role: "user" as const, content: "Explain {{topic}}." },
            ],
          };
    const id = onCreate(
      kind === "fragment" ? "Untitled prompt" : "Untitled message set",
      content,
    );
    setSelectedId(id);
    setViewedRevisionId(undefined);
    setName(kind === "fragment" ? "Untitled prompt" : "Untitled message set");
    setContent(structuredClone(content));
    setDefaults({});
  }

  return (
    <div className="templates-workspace">
      <aside className="template-sidebar">
        <div className="template-create-actions">
          <button className="button secondary" type="button" onClick={() => addTemplate("fragment")}>
            + Prompt
          </button>
          <button className="button secondary" type="button" onClick={() => addTemplate("messages")}>
            + Message set
          </button>
        </div>
        <div className="template-list">
          {templates.length === 0 ? (
            <p className="template-empty">Create a project-owned prompt or message set.</p>
          ) : (
            templates.map((template) => (
              <button
                aria-current={template.id === selected?.id}
                className={template.id === selected?.id ? "template-list-item selected" : "template-list-item"}
                key={template.id}
                type="button"
                onClick={() => selectTemplate(template)}
              >
                <strong>{template.name}</strong>
                <span>
                  {currentRevision(template).content.kind === "fragment" ? "Prompt" : "Message set"}
                  {" · "}
                  {usageCounts.get(template.id) ?? 0} uses
                </span>
              </button>
            ))
          )}
        </div>
      </aside>

      <section className="template-editor">
        {!selected || !viewedRevision ? (
          <div className="template-empty-state">
            <h3>No project templates yet</h3>
            <p>Create a prompt fragment or an ordered message set to begin.</p>
          </div>
        ) : (
          <>
            <div className="template-editor-toolbar">
              <label>
                Template name
                <input
                  disabled={readOnly}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label>
                Revision
                <select
                  value={viewedRevision.id}
                  onChange={(event) =>
                    selectRevision(event.target.value as PromptTemplateRevisionId)
                  }
                >
                  {[...selected.revisions].reverse().map((revision, index) => (
                    <option key={revision.id} value={revision.id}>
                      {revision.id === selected.currentRevisionId
                        ? "Current"
                        : `Previous ${index}`}
                      {" · "}
                      {new Date(revision.createdAt).toLocaleString()}
                    </option>
                  ))}
                </select>
              </label>
              {readOnly ? (
                <span className="provider-pill">Read-only revision</span>
              ) : (
                <button
                  className="button primary"
                  disabled={
                    !name.trim() ||
                    discovery.diagnostics.length > 0 ||
                    sensitiveAssignedVariables.length > 0
                  }
                  type="button"
                  onClick={() =>
                    setViewedRevisionId(
                      onSave(selected.id, name, content, defaults),
                    )
                  }
                >
                  Save revision
                </button>
              )}
            </div>

            {duplicateName && (
              <div className="template-warning" role="status">
                Another template has this name. IDs keep the two definitions distinct.
              </div>
            )}
            {discovery.diagnostics.map((diagnostic) => (
              <div className="template-diagnostic" key={`${diagnostic.start}-${diagnostic.end}`}>
                {diagnostic.message}
              </div>
            ))}
            {sensitiveAssignedVariables.map(({ name }) => (
              <div className="template-diagnostic" key={name}>
                Secret-like variable &quot;{name}&quot; cannot have a portable default.
              </div>
            ))}

            <TemplateContentEditor
              content={content}
              disabled={readOnly}
              onChange={setContent}
            />

            <section className="template-variable-editor">
              <div>
                <span className="eyebrow">Variables</span>
                <h3>Revision defaults</h3>
              </div>
              {discovery.variables.length === 0 ? (
                <p className="template-empty">No variables discovered.</p>
              ) : (
                discovery.variables.map((variable) => {
                  const assigned = Object.hasOwn(defaults, variable.name);
                  return (
                    <div className="template-variable-row" key={variable.name}>
                      <label>
                        <code>{`{{${variable.name}}}`}</code>
                        <input
                          disabled={readOnly}
                          placeholder="No default"
                          value={assigned ? defaults[variable.name] : ""}
                          onChange={(event) =>
                            setDefaults((current) => ({
                              ...current,
                              [variable.name]: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <small>{variable.occurrences.length} location{variable.occurrences.length === 1 ? "" : "s"}</small>
                      {assigned && !readOnly && (
                        <button
                          className="text-button"
                          type="button"
                          onClick={() =>
                            setDefaults((current) => {
                              const next = { ...current };
                              delete next[variable.name];
                              return next;
                            })
                          }
                        >
                          Remove default
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </section>

            <section className="template-insert">
              <div>
                <span className="eyebrow">Conversation</span>
                <h3>Add pinned use</h3>
              </div>
              {viewedRevision.content.kind === "fragment" && (
                <label>
                  Message role
                  <select
                    value={fragmentRole}
                    onChange={(event) => setFragmentRole(event.target.value as TemplateRole)}
                  >
                    <option value="system">System</option>
                    <option value="user">User</option>
                    <option value="assistant">Assistant</option>
                  </select>
                </label>
              )}
              <label>
                Position
                <select
                  value={Math.min(insertionIndex, itemCount)}
                  onChange={(event) => setInsertionIndex(Number(event.target.value))}
                >
                  {Array.from({ length: itemCount + 1 }, (_, index) => (
                    <option key={index} value={index}>
                      {index === 0 ? "At start" : index === itemCount ? "At end" : `After item ${index}`}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="button primary"
                type="button"
                onClick={() =>
                  onInsert(
                    selected.id,
                    fragmentRole,
                    Math.min(insertionIndex, itemCount),
                  )
                }
              >
                Add to conversation
              </button>
            </section>
          </>
        )}
      </section>
    </div>
  );
}

function TemplateContentEditor({
  content,
  disabled,
  onChange,
}: {
  content: PromptTemplateContent;
  disabled: boolean;
  onChange(content: PromptTemplateContent): void;
}) {
  return (
    <section className="template-content-editor">
      <label>
        Template kind
        <select
          disabled={disabled}
          value={content.kind}
          onChange={(event) =>
            onChange(
              event.target.value === "fragment"
                ? { kind: "fragment", text: "" }
                : {
                    kind: "messages",
                    messages: [{ role: "user", content: "" }],
                  },
            )
          }
        >
          <option value="fragment">Prompt</option>
          <option value="messages">Message set</option>
        </select>
      </label>
      {content.kind === "fragment" ? (
        <label>
          Prompt content
          <textarea
            disabled={disabled}
            rows={9}
            value={content.text}
            onChange={(event) =>
              onChange({ kind: "fragment", text: event.target.value })
            }
          />
        </label>
      ) : (
        <div className="template-message-set">
          {content.messages.map((message, index) => (
            <article className="template-message-editor" key={index}>
              <select
                aria-label={`Template message ${index + 1} role`}
                disabled={disabled}
                value={message.role}
                onChange={(event) =>
                  onChange({
                    kind: "messages",
                    messages: content.messages.map((candidate, candidateIndex) =>
                      candidateIndex === index
                        ? { ...candidate, role: event.target.value as TemplateRole }
                        : candidate,
                    ),
                  })
                }
              >
                <option value="system">System</option>
                <option value="user">User</option>
                <option value="assistant">Assistant</option>
              </select>
              <textarea
                aria-label={`Template message ${index + 1} content`}
                disabled={disabled}
                rows={5}
                value={message.content}
                onChange={(event) =>
                  onChange({
                    kind: "messages",
                    messages: content.messages.map((candidate, candidateIndex) =>
                      candidateIndex === index
                        ? { ...candidate, content: event.target.value }
                        : candidate,
                    ),
                  })
                }
              />
              {!disabled && content.messages.length > 1 && (
                <button
                  className="remove-button"
                  type="button"
                  onClick={() =>
                    onChange({
                      kind: "messages",
                      messages: content.messages.filter((_, candidateIndex) => candidateIndex !== index),
                    })
                  }
                >
                  Remove
                </button>
              )}
            </article>
          ))}
          {!disabled && (
            <button
              className="button secondary"
              type="button"
              onClick={() =>
                onChange({
                  kind: "messages",
                  messages: [...content.messages, { role: "user", content: "" }],
                })
              }
            >
              + Add template message
            </button>
          )}
        </div>
      )}
    </section>
  );
}

interface TemplateUseCardProps {
  use: PromptTemplateUse;
  template: PromptTemplate;
  diagnostics: ProjectTemplateDiagnostic[];
  runOverrides: Readonly<Record<string, string>>;
  onSaveValues(values: Record<string, string>): void;
  onRunOverridesChange(values: Record<string, string>): void;
  onUpdateLatest(): void;
  onDetach(): void;
  onRemove(): void;
}

export function TemplateUseCard({
  use,
  template,
  diagnostics,
  runOverrides,
  onSaveValues,
  onRunOverridesChange,
  onUpdateLatest,
  onDetach,
  onRemove,
}: TemplateUseCardProps) {
  const revision = template.revisions.find(({ id }) => id === use.templateRevisionId)!;
  const discovery = discoverTemplateVariables(revision.content);
  const effectiveValues = resolveTemplateValues(
    revision.variableDefaults,
    use.values,
    runOverrides,
  );
  const newerRevision = template.currentRevisionId !== revision.id;

  function updateRecord(
    current: Readonly<Record<string, string>>,
    name: string,
    value: string,
  ): Record<string, string> {
    return { ...current, [name]: value };
  }

  function removeRecordKey(
    current: Readonly<Record<string, string>>,
    name: string,
  ): Record<string, string> {
    const next = { ...current };
    delete next[name];
    return next;
  }

  return (
    <article className={diagnostics.length ? "template-use-card unresolved" : "template-use-card"}>
      <header>
        <div>
          <span className="eyebrow">Pinned template</span>
          <h3>{template.name}</h3>
          <small>{revision.id}</small>
        </div>
        <div className="template-use-actions">
          {newerRevision && (
            <button className="button secondary" type="button" onClick={onUpdateLatest}>
              Review latest
            </button>
          )}
          <button className="button secondary" type="button" onClick={onDetach}>
            Detach
          </button>
          <button className="remove-button" type="button" onClick={onRemove}>
            Remove
          </button>
        </div>
      </header>

      {diagnostics.map(({ diagnostic }, index) => (
        <div className="template-diagnostic" key={`${diagnostic.code}-${index}`}>
          {diagnostic.message}
        </div>
      ))}

      <div className="template-use-values">
        {discovery.variables.map((variable) => {
          const sensitive = isSensitiveTemplateVariableName(variable.name);
          const saved = Object.hasOwn(use.values, variable.name);
          const overridden = Object.hasOwn(runOverrides, variable.name);
          const defaulted = Object.hasOwn(revision.variableDefaults, variable.name);
          return (
            <div className="template-use-variable" key={variable.name}>
              <div>
                <code>{`{{${variable.name}}}`}</code>
                <small>
                  Effective: {Object.hasOwn(effectiveValues, variable.name)
                    ? JSON.stringify(effectiveValues[variable.name])
                    : "missing"}
                </small>
              </div>
              {sensitive ? (
                <div className="template-diagnostic">
                  Secret-like variables cannot receive portable or run-only values.
                </div>
              ) : (
                <>
              <label>
                Saved value
                <input
                  placeholder={defaulted ? `Default: ${revision.variableDefaults[variable.name]}` : "No saved value"}
                  value={saved ? use.values[variable.name] : ""}
                  onChange={(event) =>
                    onSaveValues(updateRecord(use.values, variable.name, event.target.value))
                  }
                />
              </label>
              {saved && (
                <button
                  className="text-button"
                  type="button"
                  onClick={() => onSaveValues(removeRecordKey(use.values, variable.name))}
                >
                  Use default
                </button>
              )}
              <label>
                Run-only override
                <input
                  className="run-override-input"
                  placeholder="No override"
                  value={overridden ? runOverrides[variable.name] : ""}
                  onChange={(event) =>
                    onRunOverridesChange(
                      updateRecord(runOverrides, variable.name, event.target.value),
                    )
                  }
                />
              </label>
              {overridden && (
                <button
                  className="text-button"
                  type="button"
                  onClick={() =>
                    onRunOverridesChange(removeRecordKey(runOverrides, variable.name))
                  }
                >
                  Clear override
                </button>
              )}
                </>
              )}
              <small>{variable.occurrences.length} location{variable.occurrences.length === 1 ? "" : "s"}</small>
            </div>
          );
        })}
      </div>
    </article>
  );
}
