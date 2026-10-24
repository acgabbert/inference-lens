"use client";

import type { DecisionQuestionType } from "../../packages/core/src/decision";
import { BlockerChip } from "../blocker-chip.client";
import { ModelCombobox } from "../model-combobox.client";
import { PaneTabs } from "../workbench-shell.client";
import type { DecisionDraftProblem, DecisionQuestionRow, DraftValue } from "./decision-draft";
import type { DecisionDraftHandle } from "./use-decision-draft.client";
import type { DecisionTargetHandle } from "./use-decision-target.client";

/** Names the element that says, in visible text, why Run is refused. */
export const DECISION_READINESS_SUMMARY_ID = "decision-readiness-summary";

const QUESTION_TYPES: { id: DecisionQuestionType; label: string }[] = [
  { id: "choice", label: "Choice" },
  { id: "score", label: "Score" },
  { id: "noul", label: "Noul (true/false)" },
];

export interface DecisionComposerProps {
  draft: DecisionDraftHandle;
  target: DecisionTargetHandle;
  /** Problems that block Run now, from the draft and the target together. */
  blockers: DecisionDraftProblem[];
  /** A run is executing, so the draft and target are read-only (D17). */
  locked: boolean;
  onOpenConnections(): void;
}

/**
 * A string-first field (U3). Any other JSON value is shown as it is and left
 * to the JSON view, so the form never stringifies it.
 */
function DraftField({
  label,
  value,
  multiline = false,
  disabled,
  onChange,
}: {
  label: string;
  value: DraftValue;
  multiline?: boolean;
  disabled: boolean;
  onChange(value: DraftValue): void;
}) {
  if (value.kind === "json") {
    return (
      <div className="decision-json-value">
        <span className="decision-field-label">{label}</span>
        <code>{JSON.stringify(value.value)}</code>
        <small>A JSON value. Edit it in the JSON view.</small>
      </div>
    );
  }
  return (
    <label className="decision-field">
      <span className="decision-field-label">{label}</span>
      {multiline ? (
        <textarea
          disabled={disabled}
          rows={2}
          value={value.text}
          onChange={(event) => onChange({ kind: "text", text: event.target.value })}
        />
      ) : (
        <input
          disabled={disabled}
          type="text"
          value={value.text}
          onChange={(event) => onChange({ kind: "text", text: event.target.value })}
        />
      )}
    </label>
  );
}

function QuestionCard({
  row,
  index,
  count,
  draft,
  disabled,
}: {
  row: DecisionQuestionRow;
  index: number;
  count: number;
  draft: DecisionDraftHandle;
  disabled: boolean;
}) {
  const name = row.id.trim() || `question ${index + 1}`;
  return (
    <article className="decision-question" aria-label={`Question ${index + 1}`} data-question-row={row.rowId}>
      <div className="decision-question-header">
        <label className="decision-field decision-question-id">
          <span className="decision-field-label">Question id</span>
          <input
            disabled={disabled}
            type="text"
            value={row.id}
            onChange={(event) => draft.updateQuestion(row.rowId, { id: event.target.value })}
          />
        </label>
        <label className="decision-field">
          <span className="decision-field-label">Type</span>
          <select
            disabled={disabled}
            value={row.type}
            onChange={(event) => draft.changeType(row.rowId, event.target.value as DecisionQuestionType)}
          >
            {QUESTION_TYPES.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>
        <div className="decision-row-actions">
          <button aria-label={`Move ${name} up`} className="text-button" disabled={disabled || index === 0} type="button" onClick={() => draft.moveQuestion(row.rowId, index - 1)}>↑</button>
          <button aria-label={`Move ${name} down`} className="text-button" disabled={disabled || index === count - 1} type="button" onClick={() => draft.moveQuestion(row.rowId, index + 1)}>↓</button>
          <button aria-label={`Remove ${name}`} className="text-button" disabled={disabled} type="button" onClick={() => draft.removeQuestion(row.rowId)}>Remove</button>
        </div>
      </div>
      <DraftField
        disabled={disabled}
        label="Instructions"
        multiline
        value={row.instructions}
        onChange={(instructions) => draft.updateQuestion(row.rowId, { instructions })}
      />
      {row.type === "noul" ? (
        <div className="decision-options">
          <label className="capability-toggle">
            <input
              checked={row.noul.enabled}
              disabled={disabled}
              type="checkbox"
              onChange={(event) => draft.updateQuestion(row.rowId, { noul: { ...row.noul, enabled: event.target.checked } })}
            />
            <span>Describe true and false</span>
          </label>
          {row.noul.enabled && (
            <>
              <DraftField disabled={disabled} label="True means" value={row.noul.true} onChange={(value) => draft.updateQuestion(row.rowId, { noul: { ...row.noul, true: value } })} />
              <DraftField disabled={disabled} label="False means" value={row.noul.false} onChange={(value) => draft.updateQuestion(row.rowId, { noul: { ...row.noul, false: value } })} />
            </>
          )}
          {row.options.length > 0 && (
            <small className="decision-kept-note">
              {row.options.length} {row.options.length === 1 ? "option is" : "options are"} kept for switching back to choice or score.
            </small>
          )}
        </div>
      ) : (
        <div className="decision-options">
          <span className="decision-field-label">{row.type === "choice" ? "Options" : "Levels, low to high"}</span>
          <ol className="decision-option-list">
            {row.options.map((option, optionIndex) => (
              <li className="decision-option" key={option.rowId}>
                <DraftField
                  disabled={disabled}
                  label={row.type === "choice" ? `Option ${optionIndex + 1} label` : `Level ${optionIndex}`}
                  value={option.label}
                  onChange={(label) => draft.updateOption(row.rowId, option.rowId, { label })}
                />
                {row.type === "choice" && (
                  <DraftField
                    disabled={disabled}
                    label={`Option ${optionIndex + 1} description`}
                    value={option.description ?? { kind: "text", text: "" }}
                    onChange={(description) =>
                      draft.updateOption(row.rowId, option.rowId, {
                        // Clearing a description returns it to "none", sent as null.
                        description: description.kind === "text" && description.text === "" ? null : description,
                      })}
                  />
                )}
                <div className="decision-row-actions">
                  <button aria-label={`Move ${row.type === "choice" ? "option" : "level"} ${optionIndex + 1} up`} className="text-button" disabled={disabled || optionIndex === 0} type="button" onClick={() => draft.moveOption(row.rowId, option.rowId, optionIndex - 1)}>↑</button>
                  <button aria-label={`Move ${row.type === "choice" ? "option" : "level"} ${optionIndex + 1} down`} className="text-button" disabled={disabled || optionIndex === row.options.length - 1} type="button" onClick={() => draft.moveOption(row.rowId, option.rowId, optionIndex + 1)}>↓</button>
                  <button aria-label={`Remove ${row.type === "choice" ? "option" : "level"} ${optionIndex + 1}`} className="text-button" disabled={disabled} type="button" onClick={() => draft.removeOption(row.rowId, option.rowId)}>Remove</button>
                </div>
              </li>
            ))}
          </ol>
          <button className="text-button" disabled={disabled} type="button" onClick={() => draft.addOption(row.rowId)}>
            + Add {row.type === "choice" ? "option" : "level"}
          </button>
        </div>
      )}
    </article>
  );
}

/** The Decision kind's request pane: target, readiness, and the D18 editor. */
export function DecisionComposer({ draft: handle, target, blockers, locked, onOpenConnections }: DecisionComposerProps) {
  const { draft } = handle;
  const discovery = target.discovery;
  return (
    <section className="composer decision-composer" aria-label="Decision request">
      <div className="panel-header request-header">
        <div>
          <span className="eyebrow">Request</span>
          <h2>Decision</h2>
        </div>
        <PaneTabs
          disabled={locked}
          label="Decision editor"
          value={draft.view}
          onChange={(value) => (value === "json" ? handle.showJson() : handle.showForm())}
          tabs={[{ id: "form", label: "Form" }, { id: "json", label: "JSON" }]}
        />
      </div>
      {blockers.length > 0 && (
        <div className="run-readiness-slot">
          <BlockerChip
            label="Run readiness"
            tone="blocked"
            assertive
            summary={`${blockers[0]!.location}: ${blockers[0]!.message}`}
            summaryId={DECISION_READINESS_SUMMARY_ID}
            issues={blockers.map(({ location, message }) => `${location}: ${message}`)}
            noun={{ one: "problem", many: "problems" }}
            {...(blockers.some(({ location }) => location === "Connection")
              ? { actions: [{ key: "connections", label: "Open Connections", primary: true as const, onSelect: onOpenConnections }] }
              : {})}
          />
        </div>
      )}
      {handle.viewProblems.length > 0 && (
        <div className="decision-view-problems" role="alert">
          <strong>{draft.view === "json" ? "Fix the JSON before switching to the form" : "The form cannot become one JSON object yet"}</strong>
          <ul>
            {handle.viewProblems.map((problem, index) => (
              <li key={index}><span>{problem.location}:</span> {problem.message}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="pane-scroll request-content decision-content">
        <fieldset className="decision-target" disabled={locked}>
          <legend>Target</legend>
          {target.profiles.length === 0 ? (
            <p className="decision-target-empty">
              No connection declares System One.{" "}
              <button className="text-button" type="button" onClick={onOpenConnections}>Open Connections</button>
            </p>
          ) : (
            <>
              <label className="decision-field">
                <span className="decision-field-label">Decision connection</span>
                <select value={target.profile?.id ?? ""} onChange={(event) => target.selectProfile(event.target.value)}>
                  {target.profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>{profile.name || "Untitled profile"} · {profile.endpoint}</option>
                  ))}
                </select>
              </label>
              <ModelCombobox
                discovery={discovery}
                favoriteModels={target.profile?.favoriteModels ?? []}
                idPrefix="decision-model"
                readinessTarget={false}
                value={target.model}
                onChange={target.setModel}
                onLoadModels={(force) => void target.loadModels(force)}
                onToggleFavoriteModel={target.toggleFavoriteModel}
              />
              {discovery?.status === "loaded" && discovery.unfiltered && (
                <p className="decision-unfiltered" role="status">
                  This server&apos;s listing does not mark decision models, so every model is listed. Type a decision model id if it is not here.
                </p>
              )}
            </>
          )}
        </fieldset>
        {draft.view === "json" ? (
          <label className="decision-field decision-json-editor">
            <span className="decision-field-label">Decision input (state and questions)</span>
            <textarea
              aria-invalid={draft.json.error ? "true" : undefined}
              disabled={locked}
              rows={24}
              spellCheck={false}
              value={draft.json.text}
              onChange={(event) => handle.setJsonText(event.target.value)}
            />
            {draft.json.error && <span className="decision-json-error" role="alert">{draft.json.error}</span>}
          </label>
        ) : (
          <>
            <section className="decision-state" aria-label="State">
              <div className="decision-section-heading">
                <span className="decision-field-label">State</span>
                <PaneTabs
                  disabled={locked}
                  label="State format"
                  value={draft.state.mode}
                  onChange={(value) => handle.setStateMode(value as "text" | "json")}
                  tabs={[{ id: "text", label: "Text" }, { id: "json", label: "JSON" }]}
                />
              </div>
              <textarea
                aria-label={draft.state.mode === "json" ? "State JSON" : "State text"}
                disabled={locked}
                rows={draft.state.mode === "json" ? 8 : 4}
                spellCheck={draft.state.mode === "text"}
                value={draft.state.text}
                onChange={(event) => handle.setStateText(event.target.value)}
              />
            </section>
            <section className="decision-questions" aria-label="Questions">
              {draft.questions.map((row, index) => (
                <QuestionCard
                  count={draft.questions.length}
                  disabled={locked}
                  draft={handle}
                  index={index}
                  key={row.rowId}
                  row={row}
                />
              ))}
              <button className="button secondary" disabled={locked} type="button" onClick={handle.addQuestion}>
                + Add question
              </button>
            </section>
          </>
        )}
      </div>
    </section>
  );
}

