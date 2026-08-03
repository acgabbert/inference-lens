"use client";

import type { RefObject } from "react";
import { ModelCombobox } from "../model-combobox.client";
import { TemperatureControl } from "../temperature-control.client";
import type { ModelDiscoveryState } from "../use-model-discovery.client";

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
}

/** Owns the provider-facing controls shown above the request composer. */
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
}: RequestSettingsProps) {
  return (
    <div className="run-settings-grid">
      <ModelCombobox
        inputRef={modelInputRef}
        value={model}
        onChange={onModelChange}
        discovery={modelDiscovery}
        onLoadModels={onLoadModels}
        favoriteModels={favoriteModels}
        onToggleFavoriteModel={onToggleFavoriteModel}
      />
      <TemperatureControl
        value={temperature}
        onChange={onTemperatureChange}
      />
      <label
        className={
          streamingAvailable
            ? "streaming-control"
            : "streaming-control disabled"
        }
        title={
          streamingAvailable
            ? undefined
            : "This profile does not support streaming responses."
        }
      >
        <input
          type="checkbox"
          checked={responseMode === "streaming"}
          disabled={!streamingAvailable}
          onChange={(event) =>
            onStreamingPreferenceChange(event.target.checked)
          }
        />
        <span>
          Stream response
          <small>
            {streamingAvailable
              ? "Show output as the provider sends it."
              : "Unavailable for this profile; responses are buffered."}
          </small>
        </span>
      </label>
    </div>
  );
}
