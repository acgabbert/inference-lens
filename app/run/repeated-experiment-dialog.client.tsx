"use client";

import { useEffect, useState } from "react";

import { InferenceSettingsPanel } from "../inference-settings-panel.client";
import type { ModelDiscoveryState } from "../use-model-discovery.client";
import type {
  RepeatedExperimentDraft,
  RepeatedExperimentSettings,
} from "./use-repeated-experiment-session.client.ts";
import { MAX_REPETITION_COUNT, MIN_REPETITION_COUNT } from "./use-repeated-experiment-session.client.ts";
import {
  DEFAULT_EXPERIMENT_TURN_CEILING,
  MAX_EXPERIMENT_TURN_CEILING,
  MIN_EXPERIMENT_TURN_CEILING,
} from "../../packages/core/src/experiment.ts";

import { experimentToolBindingLabel } from "./experiment-tool-bindings.client.ts";

export function RepeatedExperimentDialog({
  draft,
  settings,
  onCountChange,
  onTurnCeilingChange,
  onSettingsChange,
  onCancel,
  onConfirm,
}: {
  draft: RepeatedExperimentDraft;
  /**
   * Provider assistance for the model field. The experiment runs against the
   * profile the composer resolved, so its catalogue and pinned models apply.
   */
  settings: {
    streamingAvailable: boolean;
    modelDiscovery: ModelDiscoveryState | null;
    favoriteModels: string[];
    onLoadModels(force?: boolean): void;
    onToggleFavoriteModel(model: string): void;
  };
  onCountChange(count: number): void;
  onTurnCeilingChange(ceiling: number): void;
  onSettingsChange(next: RepeatedExperimentSettings): void;
  onCancel(): void;
  onConfirm(): void;
}) {
  // Expanded here, unlike the composer: this dialog exists to decide how the
  // repetitions will run, so its settings are the reason the user is reading it.
  const [settingsOpen, setSettingsOpen] = useState(true);
  const turnCeiling = draft.plan.turnCeiling ?? DEFAULT_EXPERIMENT_TURN_CEILING;
  const exposesTools = draft.toolBindings.length > 0;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <div className="confirmation-backdrop" role="presentation">
      <section aria-labelledby="repeat-experiment-title" aria-modal="true" className="confirmation-dialog repeated-experiment-dialog" role="dialog">
        <span className="eyebrow">Repeated experiment</span>
        <h2 id="repeat-experiment-title">Run this frozen request repeatedly</h2>
        <p>Each repetition is a new ordinary run. Results execute one at a time, in order.</p>
        <dl className="confirmation-details repeat-experiment-details">
          <div><dt>Frozen request</dt><dd>{draft.requestSummary}</dd></div>
          <div><dt>Target</dt><dd>{draft.targetName}</dd></div>
          <div><dt>Endpoint</dt><dd><code>{draft.plan.commonInput.target.endpoint}</code></dd></div>
        </dl>
        {/* Editable until the experiment starts. The plan freezes whatever is
            here on confirmation, and nothing written here reaches the composer's
            own settings or the project's defaults. */}
        <InferenceSettingsPanel
          idPrefix="experiment"
          label="Repeated experiment settings"
          heading="Experiment settings"
          scopeLabel="Frozen on start"
          inherited={{
            label: "frozen request",
            value: draft.inheritedSettings ?? {
              model: draft.plan.commonInput.target.model,
              temperature: draft.plan.commonInput.options.temperature,
              responseMode: draft.plan.commonInput.responseMode,
            },
          }}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          value={{
            model: draft.plan.commonInput.target.model,
            temperature: draft.plan.commonInput.options.temperature,
            responseMode: draft.plan.commonInput.responseMode,
          }}
          onChange={onSettingsChange}
          streamingAvailable={settings.streamingAvailable}
          modelDiscovery={settings.modelDiscovery}
          favoriteModels={settings.favoriteModels}
          onLoadModels={settings.onLoadModels}
          onToggleFavoriteModel={settings.onToggleFavoriteModel}
          repetitions={{
            summary: `${draft.repetitionCount} reps · ≤${turnCeiling} turns`,
            control: (
              <>
                <label className="inference-settings-count">
                  Repetitions
                  <input
                    aria-label="Repetitions"
                    min={MIN_REPETITION_COUNT}
                    max={MAX_REPETITION_COUNT}
                    type="number"
                    value={draft.repetitionCount}
                    onChange={(event) => onCountChange(Number(event.target.value))}
                  />
                </label>
                <label className="inference-settings-count">
                  Max turns per repetition
                  <input
                    aria-label="Max turns per repetition"
                    min={MIN_EXPERIMENT_TURN_CEILING}
                    max={MAX_EXPERIMENT_TURN_CEILING}
                    type="number"
                    value={turnCeiling}
                    onChange={(event) => onTurnCeilingChange(Number(event.target.value))}
                  />
                </label>
              </>
            ),
          }}
          notes={<small>Runs sequentially; the next starts only after the previous repetition is terminal.</small>}
        />
        {exposesTools && (
          /* What will run, at the moment cost is confirmed. A tool served
             automatically is executed without another prompt, so this is the
             last point at which a stale grant can be noticed. */
          <div className="repeat-experiment-tools">
            <h3>Tools served automatically</h3>
            <ul>
              {draft.toolBindings.map(({ tool, binding }) => (
                <li key={tool.id} className={binding ? undefined : "repeat-experiment-tool-unbound"}>
                  <code>{tool.name}</code> → {experimentToolBindingLabel({ tool, ...(binding ? { binding } : {}) })}
                </li>
              ))}
            </ul>
          </div>
        )}
        {/* A floor once tools can extend a repetition past one turn: the
            provider is called again for every round of tool results, and the
            ceiling is the only thing bounding it. */}
        <p className="repeat-experiment-call-count">
          {exposesTools
            ? <><strong>Provider calls: {draft.repetitionCount}–{draft.repetitionCount * turnCeiling}</strong> — one per repetition, up to {turnCeiling} if every repetition keeps calling tools.</>
            : <><strong>Minimum provider calls: {draft.repetitionCount}</strong> — one per repetition.</>}
        </p>
        <div className="confirmation-actions">
          <button className="button secondary" type="button" onClick={onCancel}>Cancel</button>
          <button className="button primary" type="button" onClick={onConfirm}>Start {draft.repetitionCount} repetitions</button>
        </div>
      </section>
    </div>
  );
}
