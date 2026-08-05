"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  analyzeN8nTemplatePaste,
  materializeN8nTemplatePaste,
  type N8nPasteAnalysis,
  type N8nPasteMappingDraft,
} from "./n8n-template-paste.ts";

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
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const [suggestions, setSuggestions] = useState(suggestionsEnabled);
  const analyzed = useMemo(() => analyzeN8nTemplatePaste(source), [source]);
  const analysis = "message" in analyzed ? undefined : analyzed;
  const [mappings, setMappings] = useState<N8nPasteMappingDraft[]>(analysis?.mappings ?? []);
  const analysisKey = analysis?.source;
  useEffect(() => setMappings(analysis?.mappings ?? []), [analysisKey]);
  useEffect(() => { sourceRef.current?.focus(); }, []);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); return; }
      if (event.key !== "Tab") return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled])');
      if (!focusable?.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", close, true);
    return () => window.removeEventListener("keydown", close, true);
  }, [onClose]);
  const result = analysis ? materializeN8nTemplatePaste(analysis, mappings) : undefined;
  const error = "message" in analyzed ? `${analyzed.message} (at character ${analyzed.offset + 1}).` : result && !result.ok ? result.errors[0]?.message : undefined;
  const setName = (id: string, variableName: string) => setMappings((current) => current.map((mapping) => mapping.id === id ? { ...mapping, variableName } : mapping));
  const complete = () => {
    if (!result || !result.ok) return;
    onSuggestionsEnabledChange(suggestions);
    onInsert(result.content);
  };
  const unchanged = () => { onSuggestionsEnabledChange(suggestions); onPasteUnchanged?.(); };
  return (
    <div className="n8n-template-paste-backdrop" role="presentation">
      <section aria-labelledby="n8n-template-paste-title" aria-modal="true" className="n8n-template-paste-dialog" ref={dialogRef} role="dialog">
        <span className="eyebrow">Template authoring</span>
        <h2 id="n8n-template-paste-title">{automatic ? "Convert pasted n8n expressions?" : "Paste from n8n"}</h2>
        <p>Names are suggestions. Expressions are not run, and conversion does not preserve their computation.</p>
        <label>Copied n8n content<textarea ref={sourceRef} rows={5} value={source} onChange={(event) => setSource(event.target.value)} /></label>
        {error && <div className="n8n-template-paste-error" role="alert">{error}</div>}
        {analysis && source.trim().length > 0 && <>
          <div className="n8n-template-paste-preview" aria-label="Converted text preview">{result && result.ok ? result.content : source}</div>
          {mappings.map((mapping) => <div className="n8n-template-paste-mapping" key={mapping.id}>
            <code>{mapping.expressions.join(" · ")}</code>
            <label>Variable name<input aria-label={`Variable name for ${mapping.id}`} value={mapping.variableName} onChange={(event) => setName(mapping.id, event.target.value)} /></label>
            <small>{mapping.occurrences} occurrence{mapping.occurrences === 1 ? "" : "s"} · {explanation[mapping.nameSource]}</small>
            {mapping.nameSource === "fallback" && <span className="n8n-template-paste-review">Needs review</span>}
          </div>)}
        </>}
        <label className="n8n-template-paste-preference"><input checked={suggestions} type="checkbox" onChange={(event) => setSuggestions(event.target.checked)} /> Suggest this when n8n expressions are pasted</label>
        <footer>
          <button className="button secondary" type="button" onClick={onClose}>Cancel</button>
          {automatic && <button className="button secondary" type="button" onClick={unchanged}>Paste unchanged</button>}
          <button className="button primary" disabled={!result?.ok} type="button" onClick={complete}>{automatic ? "Convert n8n expressions" : "Insert converted text"}</button>
        </footer>
      </section>
    </div>
  );
}
