"use client";

export const INITIAL_TEMPERATURE_OVERRIDE = 0.2;

type TemperatureControlProps = {
  /** `undefined` means "send no temperature field", which is not the same as 0. */
  value: number | undefined;
  /**
   * The override to restore when the toggle is re-checked, so clearing an
   * override and restoring it returns the author's own value rather than
   * snapping to a default.
   *
   * This is remembered by the owner rather than here: the control is mounted
   * inside a disclosure that unmounts when collapsed, and state held here would
   * be discarded every time the panel closed.
   */
  rememberedOverride: number;
  onChange: (temperature: number | undefined) => void;
};

/** Temperature entry for every surface that owns an inference option set. */
export function TemperatureControl({
  value,
  rememberedOverride,
  onChange,
}: TemperatureControlProps) {
  const temperatureOverridden = value !== undefined;
  const sliderTemperature = value ?? rememberedOverride;
  const experimentalTemperature = temperatureOverridden && sliderTemperature > 1;

  return (
    <div className="temperature-control">
      <label className="temperature-toggle">
        <input
          type="checkbox"
          checked={temperatureOverridden}
          onChange={(event) =>
            onChange(event.target.checked ? rememberedOverride : undefined)
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
          onChange={(event) => onChange(Number(event.target.value))}
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
