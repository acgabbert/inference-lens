"use client";

import { useMemo, useRef, useState } from "react";

import type {
  ConnectionRequirement,
  ExternalImportReceipt,
  ProjectTemplateDiagnostic,
  PromptTemplate,
  PromptTemplateContent,
  PromptTemplateRecommendedTarget,
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
import { FocusModeToggle, useFocusMode } from "./focus-mode.client";

type TemplateRole = "system" | "user" | "assistant";

interface ProjectTemplatesPaneProps {
  templates: PromptTemplate[];
  connectionRequirements: ConnectionRequirement[];
  defaultConnectionRequirementId?: ConnectionRequirement["id"];
  usageCounts: ReadonlyMap<PromptTemplateId, number>;
  itemCount: number;
  n8nImportDisabledReason?: string;
  onOpenN8nImport(): void;
  onCreate(name: string, content: PromptTemplateContent): PromptTemplateId;
  onSave(
    templateId: PromptTemplateId,
    name: string,
    content: PromptTemplateContent,
    defaults: Record<string, string>,
    recommendedTarget?: PromptTemplateRecommendedTarget,
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
  connectionRequirements = [],
  defaultConnectionRequirementId,
  usageCounts,
  itemCount,
  n8nImportDisabledReason,
  onOpenN8nImport,
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
  const [recommendedModel, setRecommendedModel] = useState(
    selected?.recommendedTarget?.model ?? "",
  );
  const [
    recommendedConnectionRequirementId,
    setRecommendedConnectionRequirementId,
  ] = useState<ConnectionRequirement["id"] | undefined>(
    selected?.recommendedTarget?.connectionRequirementId ??
      defaultConnectionRequirementId,
  );
  const [fragmentRole, setFragmentRole] = useState<TemplateRole>("user");
  const [insertionIndex, setInsertionIndex] = useState(itemCount);
  const [focusMode, setFocusMode] = useState(false);
  const editorRef = useRef<HTMLElement>(null);
  const focusToggleRef = useRef<HTMLButtonElement>(null);

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
  // A secret-like name can never receive a value at any level, so a template
  // that references one is unrunnable however it is saved. Flag it on discovery
  // rather than only when a default is assigned, or the author only finds out
  // at the point the run is refused.
  const sensitiveVariables = discovery.variables.filter(({ name }) =>
    isSensitiveTemplateVariableName(name),
  );

  const { close: closeFocusMode } = useFocusMode({
    open: focusMode,
    setOpen: setFocusMode,
    containerRef: editorRef,
    triggerRef: focusToggleRef,
    initialFocusSelector: ".template-content-editor textarea:not([disabled])",
  });

  function selectTemplate(template: PromptTemplate): void {
    const revision = currentRevision(template);
    setSelectedId(template.id);
    setViewedRevisionId(revision.id);
    setName(template.name);
    setContent(structuredClone(revision.content));
    setDefaults({ ...revision.variableDefaults });
    setRecommendedModel(template.recommendedTarget?.model ?? "");
    setRecommendedConnectionRequirementId(
      template.recommendedTarget?.connectionRequirementId ??
        defaultConnectionRequirementId,
    );
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
    setRecommendedModel("");
    setRecommendedConnectionRequirementId(defaultConnectionRequirementId);
  }

  return (
    <div className="templates-workspace" data-readiness-target="prompt-library" tabIndex={-1}>
      <aside className="template-sidebar">
        <div className="template-create-actions">
          <button className="button secondary" type="button" onClick={() => addTemplate("fragment")}>
            + Prompt
          </button>
          <button className="button secondary" type="button" onClick={() => addTemplate("messages")}>
            + Message set
          </button>
          <button
            className="button secondary template-import-action"
            disabled={Boolean(n8nImportDisabledReason)}
            title={n8nImportDisabledReason}
            type="button"
            onClick={onOpenN8nImport}
          >
            Import from n8n…
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

      <section
        aria-label={focusMode ? "Prompt editor focus mode" : undefined}
        aria-modal={focusMode ? "true" : undefined}
        className={focusMode ? "template-editor focus-mode-surface template-editor-focus-mode" : "template-editor"}
        ref={editorRef}
        role={focusMode ? "dialog" : undefined}
      >
        {!selected || !viewedRevision ? (
          <div className="template-empty-state">
            <h3>No project templates yet</h3>
            <p>Create a prompt fragment or an ordered message set to begin.</p>
          </div>
        ) : (
          <>
            <header className="template-editor-header">
              <label className="template-name-field">
                Template name
                <input
                  disabled={readOnly}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label className="template-revision-field">
                Revision
                <select
                  value={viewedRevision.id}
                  onChange={(event) =>
                    selectRevision(event.target.value as PromptTemplateRevisionId)
                  }
                >
                  {[...selected.revisions].reverse().map((revision) => (
                    <option key={revision.id} value={revision.id}>
                      {revision.id === selected.currentRevisionId
                        ? "Current"
                        : `Revision ${selected.revisions.indexOf(revision) + 1}`}
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
                    sensitiveVariables.length > 0
                  }
                  type="button"
                  onClick={() =>
                    setViewedRevisionId(
                      onSave(
                        selected.id,
                        name,
                        content,
                        Object.fromEntries(
                          discovery.variables.flatMap(({ name }) =>
                            Object.hasOwn(defaults, name)
                              ? [[name, defaults[name]!]]
                              : [],
                          ),
                        ),
                        recommendedModel.trim() &&
                          recommendedConnectionRequirementId
                          ? {
                              connectionRequirementId:
                                recommendedConnectionRequirementId,
                              model: recommendedModel.trim(),
                            }
                          : undefined,
                      ),
                    )
                  }
                >
                  Save template
                </button>
              )}
            </header>

            {(duplicateName ||
              discovery.diagnostics.length > 0 ||
              sensitiveVariables.length > 0) && (
              <div className="template-notices">
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
                {sensitiveVariables.map(({ name }) => (
                  <div className="template-diagnostic" key={name}>
                    Secret-like variable <code>{`{{${name}}}`}</code> can never be
                    given a value: defaults, saved use values, and run-only
                    overrides all reject it, so a conversation using this template
                    could not run. Rename it — credentials reach the provider
                    through the connection profile, not through project templates.
                  </div>
                ))}
              </div>
            )}

            <div className="template-editor-body">
              <TemplateContentEditor
                content={content}
                disabled={readOnly}
                focusMode={focusMode}
                focusToggleRef={focusToggleRef}
                onFocusModeChange={(open) => {
                  if (open) setFocusMode(true);
                  else closeFocusMode();
                }}
                onChange={setContent}
              />

              <aside className="template-variable-rail">
                <div className="template-rail-heading">
                  <span className="eyebrow">Model</span>
                  <h3>Recommended target</h3>
                </div>
                <p className="template-empty">
                  Optional. It does not create a revision or change a run. Shown
                  when it differs from the selected run target.
                </p>
                <label>
                  Connection
                  <select
                    disabled={readOnly || connectionRequirements.length === 0}
                    value={recommendedConnectionRequirementId ?? ""}
                    onChange={(event) =>
                      setRecommendedConnectionRequirementId(
                        event.target.value as ConnectionRequirement["id"],
                      )
                    }
                  >
                    {connectionRequirements.map((requirement) => (
                      <option key={requirement.id} value={requirement.id}>
                        {requirement.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Model ID
                  <input
                    aria-label="Recommended model ID"
                    disabled={readOnly}
                    placeholder="No recommendation"
                    value={recommendedModel}
                    onChange={(event) => setRecommendedModel(event.target.value)}
                  />
                </label>
                <div className="template-rail-heading">
                  <span className="eyebrow">Variables</span>
                  <h3>Revision defaults</h3>
                </div>
                {discovery.variables.length === 0 ? (
                  <p className="template-empty">
                    No variables discovered. Write <code>{"{{name}}"}</code> in the
                    content to add one.
                  </p>
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
                        <div className="template-variable-meta">
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
                      </div>
                    );
                  })
                )}
              </aside>
            </div>

            <footer className="template-insert-bar">
              <span className="template-insert-label">Pin into the conversation</span>
              {viewedRevision.content.kind === "fragment" && (
                <label>
                  Role
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
            </footer>
          </>
        )}
      </section>
    </div>
  );
}

function TemplateContentEditor({
  content,
  disabled,
  focusMode,
  focusToggleRef,
  onFocusModeChange,
  onChange,
}: {
  content: PromptTemplateContent;
  disabled: boolean;
  focusMode: boolean;
  focusToggleRef: React.RefObject<HTMLButtonElement | null>;
  onFocusModeChange(open: boolean): void;
  onChange(content: PromptTemplateContent): void;
}) {
  return (
    <section className="template-content-editor">
      <div className="template-content-heading">
        <h3>Content</h3>
        <div className="template-content-actions">
          <label className="template-kind-field">
            Kind
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
          <FocusModeToggle
            className="template-focus-toggle"
            open={focusMode}
            subject="prompt editor"
            toggleRef={focusToggleRef}
            onToggle={() => onFocusModeChange(!focusMode)}
          />
        </div>
      </div>
      {content.kind === "fragment" ? (
        <label className="template-fragment-field">
          <textarea
            aria-label="Prompt content"
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
            <article className="template-message-editor message-card" key={index}>
              <div className="message-toolbar">
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
              </div>
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
  importedFrom?: ExternalImportReceipt;
  onSaveValues(values: Record<string, string>): void;
  onSaveRunValue(
    values: Record<string, string>,
    runOverrides: Record<string, string>,
  ): void;
  onRunOverridesChange(values: Record<string, string>): void;
  onUpdateLatest(): void;
  onDetach(): void;
  onRemove(): void;
}

function effectiveValueLabel(value: string): string {
  return value.length ? value : "(empty)";
}

/**
 * A collapsed variable row has one line to say what the value currently is, so
 * the value is flattened to a single line and clipped. The full text stays
 * available in the row's editor.
 */
function glanceLabel(value: string | undefined): string {
  if (value === undefined) return "Not set";
  if (!value.length) return "(empty)";
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > 72 ? `${singleLine.slice(0, 72)}…` : singleLine;
}

function importProvenanceLabel(receipt: ExternalImportReceipt): string {
  const source = receipt.source.adapter.toLowerCase().includes("n8n")
    ? "n8n"
    : receipt.source.adapter;
  const execution = receipt.source.execution;
  if (!execution) return `Imported from ${source}`;
  if (!execution.executedAt) {
    return `Imported from ${source} · execution ${execution.id}`;
  }
  const executionDate = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(execution.executedAt));
  return `Imported from ${source} · execution ${executionDate}`;
}

function TemplateContentPreview({
  content,
  values,
  view,
}: {
  content: PromptTemplateContent;
  values: Readonly<Record<string, string>>;
  view: "template" | "resolved";
}) {
  const messages =
    content.kind === "fragment"
      ? [{ role: "user", content: content.text }]
      : content.messages;
  return (
    <div className="template-content-preview" aria-label={`${view} template preview`}>
      {messages.map((message, messageIndex) => (
        <div className="template-preview-message" key={`${message.role}-${messageIndex}`}>
          <span className="eyebrow">{message.role}</span>
          <div className="template-preview-content">
            {message.content.split(/(\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\})/g).map((part, index) => {
              const match = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/.exec(part);
              if (!match) return <span key={index}>{part}</span>;
              const name = match[1]!;
              const value = values[name];
              const missing = value === undefined;
              return (
                <span
                  className={`template-variable-chip${missing ? " missing" : ""}`}
                  key={index}
                  title={missing ? `${name} needs a value` : value}
                >
                  {view === "template" ? `{{${name}}}` : missing ? `{{${name}}}` : effectiveValueLabel(value)}
                </span>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export function TemplateUseCard(props: TemplateUseCardProps) {
  // A pinned revision defines the preview, variable set, defaults, and which
  // rows block a run. Treat it as the identity boundary for this card's local
  // summary state so a newly blocking row receives the normal open policy.
  return (
    <TemplateUseCardRevision
      key={props.use.templateRevisionId}
      {...props}
    />
  );
}

function TemplateUseCardRevision({
  use,
  template,
  diagnostics,
  runOverrides,
  importedFrom,
  onSaveValues,
  onSaveRunValue,
  onRunOverridesChange,
  onUpdateLatest,
  onDetach,
  onRemove,
}: TemplateUseCardProps) {
  const [previewView, setPreviewView] = useState<"template" | "resolved">("template");
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [variableFilter, setVariableFilter] = useState("");
  const [attentionOnly, setAttentionOnly] = useState(false);
  const revision = template.revisions.find(({ id }) => id === use.templateRevisionId)!;
  const discovery = discoverTemplateVariables(revision.content);
  const effectiveValues = resolveTemplateValues(
    revision.variableDefaults,
    use.values,
    runOverrides,
  );
  const newerRevision = template.currentRevisionId !== revision.id;
  // Resolution can report the same missing variable once per message. The
  // value is authored once, so the card should summarize it once as well.
  const uniqueDiagnostics = [
    ...new Map(
      diagnostics.map(({ diagnostic }) => [diagnostic.message, diagnostic]),
    ).values(),
  ];
  const missingDiagnosticCount = uniqueDiagnostics.filter(
    ({ code }) => code === "missing-template-variable",
  ).length;
  const reportedMissing = new Set(
    uniqueDiagnostics.flatMap((diagnostic) =>
      diagnostic.code === "missing-template-variable" ? [diagnostic.name] : [],
    ),
  );

  const rows = discovery.variables.map((variable) => {
    const sensitive = isSensitiveTemplateVariableName(variable.name);
    const saved = Object.hasOwn(use.values, variable.name);
    const overridden = Object.hasOwn(runOverrides, variable.name);
    const defaulted = Object.hasOwn(revision.variableDefaults, variable.name);
    const needsValue = !saved && !overridden && !defaulted;
    return {
      variable,
      sensitive,
      saved,
      overridden,
      defaulted,
      needsValue,
      effective: effectiveValues[variable.name],
      valueSource: overridden
        ? "Session override"
        : saved
          ? "Saved in project"
          : defaulted
            ? "Template default"
            : "Needs a value",
      // A row that blocks the run is never collapsed by default and never
      // hidden by a filter: run readiness deep-links to exactly these fields,
      // so they have to stay reachable whatever the card is filtered to.
      blocking: sensitive || needsValue || reportedMissing.has(variable.name),
    };
  });
  const [openVariables, setOpenVariables] = useState<Record<string, boolean>>(
    () =>
      Object.fromEntries(
        rows.flatMap(({ variable, blocking }) =>
          blocking ? [[variable.name, true] as const] : [],
        ),
      ),
  );
  const attentionCount = rows.filter(({ blocking }) => blocking).length;
  const overrideCount = rows.filter(({ overridden }) => overridden).length;
  const query = variableFilter.trim().toLowerCase();
  const visibleRows = rows.filter(
    (row) =>
      row.blocking ||
      (!attentionOnly &&
        (!query || row.variable.name.toLowerCase().includes(query))),
  );
  const hiddenCount = rows.length - visibleRows.length;
  // Below this a stack of expanded rows is still readable, and the controls
  // would cost more attention than they save.
  const dense = rows.length > 3;
  const allVisibleOpen =
    visibleRows.length > 0 &&
    visibleRows.every(({ variable }) => openVariables[variable.name]);

  function setAllVisible(open: boolean): void {
    setOpenVariables((current) => ({
      ...current,
      ...Object.fromEntries(
        visibleRows.map(({ variable }) => [variable.name, open]),
      ),
    }));
  }

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
    <article
      className={diagnostics.length ? "template-use-card unresolved" : "template-use-card"}
      data-template-use-id={use.id}
      tabIndex={-1}
    >
      <header>
        <div>
          <div className="template-use-kicker">
            <span className="eyebrow">Pinned template</span>
            {uniqueDiagnostics.length > 0 && (
              <span className="template-issue-count" role="status">
                {missingDiagnosticCount === uniqueDiagnostics.length
                  ? `${missingDiagnosticCount} missing`
                  : `${uniqueDiagnostics.length} ${
                      uniqueDiagnostics.length === 1 ? "issue" : "issues"
                    }`}
              </span>
            )}
          </div>
          <h3>{template.name}</h3>
          {importedFrom && (
            <small>{importProvenanceLabel(importedFrom)}</small>
          )}
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

      <section className="template-use-preview">
        <div className="template-preview-heading">
          <span>Prompt preview</span>
          <div className="template-preview-toggle" aria-label="Prompt preview mode">
            <button
              aria-pressed={previewView === "template"}
              className={previewView === "template" ? "active" : ""}
              onClick={() => setPreviewView("template")}
              type="button"
            >
              Template
            </button>
            <button
              aria-pressed={previewView === "resolved"}
              className={previewView === "resolved" ? "active" : ""}
              onClick={() => setPreviewView("resolved")}
              type="button"
            >
              Resolved
            </button>
          </div>
          <button
            aria-expanded={previewExpanded}
            className="text-button"
            type="button"
            onClick={() => setPreviewExpanded((expanded) => !expanded)}
          >
            {previewExpanded ? "Collapse" : "Expand"}
          </button>
        </div>
        <div
          className={
            previewExpanded
              ? "template-preview-body"
              : "template-preview-body clamped"
          }
        >
          <TemplateContentPreview
            content={revision.content}
            values={effectiveValues}
            view={previewView}
          />
        </div>
      </section>

      <div className="template-use-values">
        {rows.length > 0 && (
          <div className="template-values-heading">
            <div className="template-values-summary">
              <strong>
                {rows.length} variable{rows.length === 1 ? "" : "s"}
              </strong>
              {attentionCount > 0 && (
                <span className="template-values-attention">
                  {attentionCount} need{attentionCount === 1 ? "s" : ""} attention
                </span>
              )}
              {overrideCount > 0 && (
                <span>
                  {overrideCount} session override
                  {overrideCount === 1 ? "" : "s"}
                </span>
              )}
            </div>
            {dense && (
              <div className="template-values-controls">
                <input
                  aria-label={`Filter ${template.name} variables`}
                  placeholder="Filter variables"
                  type="search"
                  value={variableFilter}
                  onChange={(event) => setVariableFilter(event.target.value)}
                />
                <label className="template-values-attention-toggle">
                  <input
                    checked={attentionOnly}
                    type="checkbox"
                    onChange={(event) => setAttentionOnly(event.target.checked)}
                  />
                  Needs attention only
                </label>
                <button
                  className="text-button"
                  type="button"
                  onClick={() => setAllVisible(!allVisibleOpen)}
                >
                  {allVisibleOpen ? "Collapse all" : "Expand all"}
                </button>
              </div>
            )}
          </div>
        )}
        {visibleRows.map(({
          variable,
          sensitive,
          saved,
          overridden,
          effective,
          valueSource,
          blocking,
        }) => {
          return (
            <details
              className={
                blocking
                  ? "template-use-variable attention"
                  : "template-use-variable"
              }
              key={variable.name}
              open={openVariables[variable.name] ?? false}
              onToggle={(event) => {
                // The updater runs after the event is done with, so the new
                // state has to be read while the target is still attached.
                const open = event.currentTarget.open;
                setOpenVariables((current) => ({
                  ...current,
                  [variable.name]: open,
                }));
              }}
            >
              <summary className="template-use-variable-heading">
                <code>{`{{${variable.name}}}`}</code>
                <span className="template-variable-glance">
                  {sensitive ? "Cannot be given a value" : glanceLabel(effective)}
                </span>
                <small
                  className={
                    blocking
                      ? "template-variable-source attention"
                      : "template-variable-source"
                  }
                >
                  {sensitive ? "Secret-like name" : valueSource}
                </small>
              </summary>
              {sensitive ? (
                <div className="template-diagnostic">
                  Secret-like variables cannot receive portable or run-only
                  values, so this use cannot run. Rename{" "}
                  <code>{`{{${variable.name}}}`}</code> in the template, or
                  detach this use and edit the message directly. Credentials
                  reach the provider through the connection profile.
                </div>
              ) : (
                <div className="template-run-value-editor">
                  <label>
                    Value for run
                    <textarea
                      data-template-variable={variable.name}
                      className={overridden ? "run-override-input" : ""}
                      placeholder="Enter a value"
                      rows={4}
                      value={effective ?? ""}
                      onChange={(event) =>
                        onRunOverridesChange(
                          updateRecord(
                            runOverrides,
                            variable.name,
                            event.target.value,
                          ),
                        )
                      }
                    />
                  </label>
                  <div className="template-run-value-footer">
                    <small>
                      {valueSource} · {variable.occurrences.length} location
                      {variable.occurrences.length === 1 ? "" : "s"}
                    </small>
                    <div className="template-run-value-actions">
                      {overridden && (
                        <>
                          <button
                            className="text-button"
                            type="button"
                            onClick={() =>
                              onSaveRunValue(
                                updateRecord(
                                  use.values,
                                  variable.name,
                                  effective!,
                                ),
                                removeRecordKey(runOverrides, variable.name),
                              )
                            }
                          >
                            Save to project
                          </button>
                          <button
                            className="text-button"
                            type="button"
                            onClick={() =>
                              onRunOverridesChange(
                                removeRecordKey(runOverrides, variable.name),
                              )
                            }
                          >
                            Reset
                          </button>
                        </>
                      )}
                      {saved && !overridden && (
                        <button
                          className="text-button"
                          type="button"
                          onClick={() =>
                            onSaveValues(
                              removeRecordKey(use.values, variable.name),
                            )
                          }
                        >
                          Use default
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </details>
          );
        })}
        {hiddenCount > 0 && (
          <p className="template-values-hidden" role="status">
            {hiddenCount} variable{hiddenCount === 1 ? "" : "s"} hidden by the
            current filter.
          </p>
        )}
      </div>
    </article>
  );
}
