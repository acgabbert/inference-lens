"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  analyzeN8nTemplatePaste,
  materializeN8nTemplatePaste,
  n8nPastePreviewSegments,
  type N8nPasteAnalysis,
  type N8nPasteMappingDraft,
} from "./n8n-template-paste.ts";
import { ModalDialog } from "../modal-dialog.client";

const explanation: Record<N8nPasteMappingDraft["nameSource"], string> = {
  "direct-reference": "Named from a direct n8n data reference.",
  "single-dependency": "Suggested from the expression's only data reference.",
  "surrounding-label": "Suggested from the label before this expression.",
  fallback: "No clear name was found. Rename this placeholder if you can.",
};

export function N8nTemplatePasteDialog({
  initialSource,
  automatic,
  suggestionsEnabled,
  onSuggestionsEnabledChange,
  onInsert,
  onPasteUnchanged,
  onClose,
}: {
  initialSource: string;
  automatic: boolean;
  suggestionsEnabled: boolean;
  onSuggestionsEnabledChange(enabled: boolean): void;
  onInsert(content: string): void;
  onPasteUnchanged?: () => void;
  onClose(): void;
}) {
  const [source, setSource] = useState(initialSource);
  // Content that already converts opens on its result; the source it came
  // from stays one click away. Anything else opens on the source to edit.
  const [startCollapsed] = useState(() => initialSource.trim().length > 0 && !("message" in analyzeN8nTemplatePaste(initialSource)));
  const [sourceOpen, setSourceOpen] = useState(!startCollapsed);
  const [variableFocusPending, setVariableFocusPending] = useState(startCollapsed);
  const [suggestions, setSuggestions] = useState(suggestionsEnabled);
  const analyzed = useMemo(() => analyzeN8nTemplatePaste(source), [source]);
  const analysis = "message" in analyzed ? undefined : analyzed;
  const error = "message" in analyzed ? `${analyzed.message} (at character ${analyzed.offset + 1}).` : undefined;
  const hasContent = source.trim().length > 0;
  const showSource = sourceOpen || Boolean(error) || !hasContent;
  const sourceField = <div className="n8n-template-paste-source">
    {hasContent && <button aria-controls="n8n-template-paste-source" aria-expanded={showSource} className="text-button n8n-template-paste-source-toggle" disabled={Boolean(error)} type="button" onClick={() => setSourceOpen(!showSource)}>Source</button>}
    {showSource && <label id="n8n-template-paste-source">Copied n8n content<textarea rows={hasContent ? 10 : 5} value={source} onChange={(event) => setSource(event.target.value)} /></label>}
    {error && <div className="n8n-template-paste-error" role="alert">{error}</div>}
  </div>;
  return (
    <ModalDialog
      backdropClassName="n8n-template-paste-backdrop"
      className={`n8n-template-paste-dialog${hasContent ? " wide-dialog" : ""}`}
      // A collapsed source opens on its first variable instead; the conversion focuses it.
      initialFocus={startCollapsed ? undefined : "textarea"}
      labelledBy="n8n-template-paste-title"
      onClose={onClose}
    >
      <header className="wide-dialog-header">
        <span className="eyebrow">Template authoring</span>
        <h2 id="n8n-template-paste-title">{automatic ? "Convert pasted n8n expressions?" : "Paste from n8n"}</h2>
        <p>Names are suggestions. Expressions are not run, and conversion does not preserve their computation.</p>
      </header>
      <N8nTemplatePasteConversion
        // Every edit to the source is a new analysis, so its drafts start over.
        key={analysis?.source ?? "invalid"}
        analysis={analysis}
        automatic={automatic}
        focusFirstVariable={variableFocusPending}
        hasContent={hasContent}
        onFirstVariableFocused={() => setVariableFocusPending(false)}
        onClose={onClose}
        onInsert={onInsert}
        onPasteUnchanged={onPasteUnchanged}
        onSuggestionsEnabledChange={onSuggestionsEnabledChange}
        sourceField={sourceField}
        suggestions={suggestions}
        onSuggestionsChange={setSuggestions}
      />
    </ModalDialog>
  );
}

function N8nTemplatePasteConversion({
  analysis,
  automatic,
  focusFirstVariable,
  hasContent,
  onFirstVariableFocused,
  onClose,
  onInsert,
  onPasteUnchanged,
  onSuggestionsEnabledChange,
  sourceField,
  suggestions,
  onSuggestionsChange,
}: {
  analysis?: N8nPasteAnalysis;
  automatic: boolean;
  /** Open on the first variable to name, once, without moving either column. */
  focusFirstVariable: boolean;
  hasContent: boolean;
  onFirstVariableFocused(): void;
  onClose(): void;
  onInsert(content: string): void;
  onPasteUnchanged?: () => void;
  onSuggestionsEnabledChange(enabled: boolean): void;
  sourceField: ReactNode;
  suggestions: boolean;
  onSuggestionsChange(enabled: boolean): void;
}) {
  const [mappings, setMappings] = useState<N8nPasteMappingDraft[]>(analysis?.mappings ?? []);
  const [focusedId, setFocusedId] = useState<string>();
  const [hoveredId, setHoveredId] = useState<string>();
  const activeId = hoveredId ?? focusedId;
  const previewRef = useRef<HTMLDivElement>(null);
  const variablesRef = useRef<HTMLElement>(null);
  const footerRef = useRef<HTMLElement>(null);
  // Set while focus moves to a variable without the author choosing it there:
  // from a clicked placeholder, so the preview does not jump away from that
  // occurrence, or on opening, so the preview starts at its beginning.
  const keepPreviewScroll = useRef(false);
  const result = analysis ? materializeN8nTemplatePaste(analysis, mappings) : undefined;
  const error = result && !result.ok ? result.errors[0]?.message : undefined;
  const segments = analysis ? n8nPastePreviewSegments(analysis, mappings) : [];
  const needsReview = mappings.filter(({ nameSource }) => nameSource === "fallback").length;
  const setName = (id: string, variableName: string) => setMappings((current) => current.map((mapping) => mapping.id === id ? { ...mapping, variableName } : mapping));
  const focusVariable = (id: string) => {
    variablesRef.current?.querySelector<HTMLInputElement>(`input[data-mapping-id="${id}"]`)?.focus();
  };
  const variableFocused = (id: string) => {
    setFocusedId(id);
    if (keepPreviewScroll.current) { keepPreviewScroll.current = false; return; }
    previewRef.current?.querySelector(`[data-mapping-id="${id}"]`)?.scrollIntoView({ block: "nearest" });
  };
  useEffect(() => {
    if (!focusFirstVariable) return;
    onFirstVariableFocused();
    const first = variablesRef.current?.querySelector<HTMLInputElement>("input[data-mapping-id]");
    if (first) keepPreviewScroll.current = true;
    (first ?? footerRef.current?.querySelector<HTMLElement>(".button.primary"))?.focus({ preventScroll: true });
  }, [focusFirstVariable, onFirstVariableFocused]);
  const complete = () => {
    if (!result?.ok) return;
    onSuggestionsEnabledChange(suggestions);
    onInsert(result.content);
  };
  const unchanged = () => { onSuggestionsEnabledChange(suggestions); onPasteUnchanged?.(); };

  return <>
    <div className="wide-dialog-columns">
      <div className="wide-dialog-pane">
        {sourceField}
        {analysis && hasContent && <div className="n8n-template-paste-preview" aria-label="Converted text preview" ref={previewRef}>
          {segments.map((segment, index) => segment.mappingId
            ? <button
                className={`n8n-template-paste-token${segment.mappingId === activeId ? " active" : ""}`}
                data-mapping-id={segment.mappingId}
                key={index}
                tabIndex={-1}
                type="button"
                onClick={() => { keepPreviewScroll.current = true; focusVariable(segment.mappingId!); }}
                onMouseEnter={() => setHoveredId(segment.mappingId)}
                onMouseLeave={() => setHoveredId(undefined)}
              >{segment.text}</button>
            : segment.text)}
        </div>}
      </div>
      {hasContent && <section aria-label="Variables" className="wide-dialog-pane n8n-template-paste-variables" ref={variablesRef}>
        <div className="n8n-template-paste-variables-heading">
          <span className="eyebrow">Variables</span>
          {analysis && <span>{mappings.length} to convert{needsReview > 0 && <> · <strong>{needsReview} {needsReview === 1 ? "needs" : "need"} review</strong></>}</span>}
        </div>
        {error && <div className="n8n-template-paste-error" role="alert">{error}</div>}
        {!analysis
          ? <p className="n8n-template-paste-empty">Fix the source to review its variables.</p>
          : mappings.length === 0
            ? <p className="n8n-template-paste-empty">No n8n expressions found. The text is inserted as it is.</p>
            : mappings.map((mapping) => <div
                className={`n8n-template-paste-mapping${mapping.id === activeId ? " active" : ""}`}
                key={mapping.id}
                onMouseEnter={() => setHoveredId(mapping.id)}
                onMouseLeave={() => setHoveredId(undefined)}
              >
                <code>{mapping.expressions.join(" · ")}</code>
                <label>Variable name<input
                  aria-label={`Variable name for ${mapping.id}`}
                  data-mapping-id={mapping.id}
                  value={mapping.variableName}
                  onBlur={() => setFocusedId((current) => current === mapping.id ? undefined : current)}
                  onChange={(event) => setName(mapping.id, event.target.value)}
                  onFocus={() => variableFocused(mapping.id)}
                /></label>
                <small>{mapping.occurrences} occurrence{mapping.occurrences === 1 ? "" : "s"} · {explanation[mapping.nameSource]}</small>
                {mapping.nameSource === "fallback" && <span className="n8n-template-paste-review">Needs review</span>}
              </div>)}
      </section>}
    </div>
    <footer className="wide-dialog-footer" ref={footerRef}>
      <label className="n8n-template-paste-preference"><input checked={suggestions} type="checkbox" onChange={(event) => onSuggestionsChange(event.target.checked)} /> Suggest this when n8n expressions are pasted</label>
      <div className="wide-dialog-actions">
        <button className="button secondary" type="button" onClick={onClose}>Cancel</button>
        {automatic && <button className="button secondary" type="button" onClick={unchanged}>Paste unchanged</button>}
        <button className="button primary" disabled={!result?.ok} type="button" onClick={complete}>{automatic ? "Convert n8n expressions" : "Insert converted text"}</button>
      </div>
    </footer>
  </>;
}
