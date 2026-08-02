"use client";

import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { ModelCombobox } from "../model-combobox.client";
import type { ModelDiscoveryState } from "../use-model-discovery.client";

export const INITIAL_TEMPERATURE_OVERRIDE = 0.2;

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
  const lastTemperatureOverride = useRef(
    temperature ?? INITIAL_TEMPERATURE_OVERRIDE,
  );

  useEffect(() => {
    if (temperature !== undefined) lastTemperatureOverride.current = temperature;
  }, [temperature]);

  const temperatureOverridden = temperature !== undefined;
  const sliderTemperature =
    temperature ?? lastTemperatureOverride.current;
  const experimentalTemperature =
    temperatureOverridden && sliderTemperature > 1;

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
      <div className="temperature-control">
        <label className="temperature-toggle">
          <input
            type="checkbox"
            checked={temperatureOverridden}
            onChange={(event) =>
              onTemperatureChange(
                event.target.checked
                  ? lastTemperatureOverride.current
                  : undefined,
              )
            }
          />
          <span>Override temperature</span>
        </label>
        {!temperatureOverridden ? (
          <small className="temperature-default">Provider default</small>
        ) : null}
        <div className="range-row">
          <input
            aria-label="Temperature"
            type="range"
            min="0"
            max="2"
            step="0.1"
            value={sliderTemperature}
            disabled={!temperatureOverridden}
            onChange={(event) => {
              const next = Number(event.target.value);
              lastTemperatureOverride.current = next;
              onTemperatureChange(next);
            }}
          />
          <output className={experimentalTemperature ? "experimental" : undefined}>
            {temperatureOverridden
              ? sliderTemperature.toFixed(1)
              : "—"}
          </output>
        </div>
        {experimentalTemperature ? (
          <small className="temperature-warning">Experimental above 1.0</small>
        ) : null}
      </div>
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
