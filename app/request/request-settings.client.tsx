"use client";

import type { RefObject } from "react";
import { InferenceSettingsPanel } from "../inference-settings-panel.client";
import type { InferenceSettingsValue } from "../inference-settings-panel.client";
import type { ModelDiscoveryState } from "../use-model-discovery.client";

/**
 * The composer's snapshot of the provider-facing settings. It stays in the
 * granular shape the workbench already publishes — one callback per field —
 * because the composer's fields are three separately owned pieces of session
 * state, not one stored object like an evaluation suite's execution block.
 */
export interface RequestSettingsProps {
  model: string;
  temperature?: number;
  responseMode: "streaming" | "buffered";
  streamingAvailable: boolean;
  modelDiscovery: ModelDiscoveryState | null;
  /** Pinned model ids for the active profile; see `ModelCombobox`. */
  favoriteModels: string[];
  modelInputRef?: RefObject<HTMLInputElement | null>;
  onModelChange(model: string): void;
  onTemperatureChange(temperature: number | undefined): void;
  onStreamingPreferenceChange(streaming: boolean): void;
  onLoadModels(force?: boolean): void;
  onToggleFavoriteModel(model: string): void;
  /** Parent profile values while an open project owns the editable copy. */
  inherited?: { label: string; value: InferenceSettingsValue };
}

interface RequestSettingsDisclosure {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Where these settings are saved, in the open project's terms. */
  scopeLabel: string;
}

/**
 * Adapts the composer's per-field settings snapshot onto the shared inference
 * settings panel. The disclosure state belongs to the composer, which has to be
 * able to open the panel before readiness routing focuses the model field.
 */
export function RequestSettings({
  model,
  temperature,
  responseMode,
  streamingAvailable,
  modelDiscovery,
  favoriteModels,
  modelInputRef,
  onModelChange,
  onTemperatureChange,
  onStreamingPreferenceChange,
  onLoadModels,
  onToggleFavoriteModel,
  open,
  onOpenChange,
  scopeLabel,
  inherited,
}: RequestSettingsProps & RequestSettingsDisclosure) {
  return (
    <section className="request-settings-card">
      <InferenceSettingsPanel
        idPrefix="request"
        label="Run settings"
        heading="Run settings"
        scopeLabel={scopeLabel}
        {...(inherited ? { inherited } : {})}
        open={open}
        onOpenChange={onOpenChange}
        value={{ model, temperature, responseMode }}
        onChange={(next) => {
          if (next.model !== model) onModelChange(next.model);
          if (next.temperature !== temperature) onTemperatureChange(next.temperature);
          if (next.responseMode !== responseMode) {
            onStreamingPreferenceChange(next.responseMode === "streaming");
          }
        }}
        streamingAvailable={streamingAvailable}
        scopeOnModelField
        modelDiscovery={modelDiscovery}
        favoriteModels={favoriteModels}
        onLoadModels={onLoadModels}
        onToggleFavoriteModel={onToggleFavoriteModel}
        {...(modelInputRef ? { modelInputRef } : {})}
        readinessTarget
      />
    </section>
  );
}
