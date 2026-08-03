"use client";

import { useState } from "react";

export const INITIAL_TEMPERATURE_OVERRIDE = 0.2;

type TemperatureControlProps = {
  /** `undefined` means "send no temperature field", which is not the same as 0. */
  value: number | undefined;
  onChange: (temperature: number | undefined) => void;
};

/**
 * Temperature entry for every surface that owns an inference option set. The
 * last override is remembered locally so clearing the override and restoring it
 * returns the author's own value rather than snapping to a default; that memory
 * is presentation state, not something a caller stores.
 */
export function TemperatureControl({ value, onChange }: TemperatureControlProps) {
  const [lastTemperatureOverride, setLastTemperatureOverride] = useState(
    value ?? INITIAL_TEMPERATURE_OVERRIDE,
  );
  const [previousTemperature, setPreviousTemperature] = useState(value);

  if (value !== previousTemperature) {
    setPreviousTemperature(value);
    if (value !== undefined) setLastTemperatureOverride(value);
  }

  const temperatureOverridden = value !== undefined;
  const sliderTemperature = value ?? lastTemperatureOverride;
  const experimentalTemperature = temperatureOverridden && sliderTemperature > 1;

  return (
    <div className="temperature-control">
      <label className="temperature-toggle">
        <input
          type="checkbox"
          checked={temperatureOverridden}
          onChange={(event) =>
            onChange(event.target.checked ? lastTemperatureOverride : undefined)
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
            setLastTemperatureOverride(next);
            onChange(next);
          }}
        />
        <output className={experimentalTemperature ? "experimental" : undefined}>
          {temperatureOverridden ? sliderTemperature.toFixed(1) : "—"}
        </output>
      </div>
      {experimentalTemperature ? (
        <small className="temperature-warning">Experimental above 1.0</small>
      ) : null}
    </div>
  );
}
