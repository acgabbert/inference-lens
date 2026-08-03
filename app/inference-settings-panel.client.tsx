"use client";

import { useId, useState, type ReactNode, type RefObject } from "react";
import { ModelCombobox } from "./model-combobox.client";
import {
  INITIAL_TEMPERATURE_OVERRIDE,
  TemperatureControl,
} from "./temperature-control.client";
import type { ModelDiscoveryState } from "./use-model-discovery.client";

/**
 * The provider-neutral option set every run-driving surface owns a copy of. It
 * deliberately mirrors the fields core already names — `target.model`,
 * `responseMode`, and `InferenceOptions` — so a surface can map its own
 * persisted shape onto this without inventing a second vocabulary.
 */
export interface InferenceSettingsValue {
  model: string;
  /** `undefined` means "send no temperature field", which is not the same as 0. */
  temperature: number | undefined;
  responseMode: "streaming" | "buffered";
}

/**
 * A setting that belongs to one surface rather than to the shared option set:
 * the connection an evaluation suite targets, the repetition count an
 * experiment plans. The slot carries its own collapsed summary so hiding the
 * panel never hides a value the surface considers part of its identity.
 */
export interface InferenceSettingsSlot {
  /** Compact value for the collapsed summary; omitted when there is none. */
  summary?: string;
  control: ReactNode;
}

export interface InferenceSettingsPanelProps {
  /**
   * Namespaces this mount's generated ids. More than one panel is mounted at a
   * time — the composer's and an evaluation suite's — and `aria-controls`
   * resolves by id, so a shared prefix would point one trigger at another
   * panel's body.
   */
  idPrefix: string;
  /** Accessible name for the region; distinguishes concurrent mounts. */
  label: string;
  heading: string;
  /** Where these settings are saved, in the surface's own words. */
  scopeNote?: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  value: InferenceSettingsValue;
  onChange(value: InferenceSettingsValue): void;
  streamingAvailable: boolean;
  /**
   * Frozen settings render as facts rather than as disabled inputs. A running
   * or finished experiment is a record of what was sent, and a disabled slider
   * invites an edit that will never be accepted.
   */
  readOnly?: boolean;
  modelDiscovery?: ModelDiscoveryState | null;
  favoriteModels?: string[];
  onLoadModels?(force?: boolean): void;
  onToggleFavoriteModel?(model: string): void;
  modelInputRef?: RefObject<HTMLInputElement | null>;
  /** Only the composer's field answers readiness routing; see `ModelCombobox`. */
  readinessTarget?: boolean;
  connection?: InferenceSettingsSlot;
  repetitions?: InferenceSettingsSlot;
  /** Lines the surface shows under the controls, such as its planned run count. */
  notes?: ReactNode;
  /** A control that stays reachable while the panel is collapsed. */
  action?: ReactNode;
}

function temperatureSummary(temperature: number | undefined): string {
  return temperature === undefined
    ? "Provider default temp"
    : `Temp ${temperature.toFixed(1)}`;
}

function deliverySummary(responseMode: "streaming" | "buffered"): string {
  return responseMode === "streaming" ? "Streaming" : "Buffered";
}

/**
 * One hide-able control panel for the inference option set, mounted by every
 * surface that drives a provider: the request composer, an evaluation suite,
 * and a repeated experiment. The panel is presentation only — each surface
 * keeps its own persistence, because the same three fields are session state in
 * one place and portable project content in another.
 *
 * The disclosure is deliberately inline rather than floating. Two of the three
 * mounts sit inside `overflow: auto` panes and the third inside a modal, where
 * an anchored popover is either clipped or in the top layer above a dialog. The
 * collapsed state still renders every value as a summary, so collapsing hides
 * the controls without hiding what the next run will send.
 */
export function InferenceSettingsPanel({
  idPrefix,
  label,
  heading,
  scopeNote,
  open,
  onOpenChange,
  value,
  onChange,
  streamingAvailable,
  readOnly = false,
  modelDiscovery = null,
  favoriteModels = [],
  onLoadModels,
  onToggleFavoriteModel,
  modelInputRef,
  readinessTarget = false,
  connection,
  repetitions,
  notes,
  action,
}: InferenceSettingsPanelProps) {
  const scope = useId();
  const bodyId = `${idPrefix}-settings-body-${scope}`;

  // The temperature the toggle restores. It lives here, in the part of the panel
  // that stays mounted, because the control that reads it is inside the
  // disclosure: held there, the author's own value would be discarded every time
  // the panel was collapsed and the toggle would snap back to a default.
  const [rememberedTemperature, setRememberedTemperature] = useState(
    value.temperature ?? INITIAL_TEMPERATURE_OVERRIDE,
  );
  const [previousTemperature, setPreviousTemperature] = useState(
    value.temperature,
  );
  if (value.temperature !== previousTemperature) {
    setPreviousTemperature(value.temperature);
    if (value.temperature !== undefined) {
      setRememberedTemperature(value.temperature);
    }
  }

  const facts = [
    connection?.summary,
    value.model || "No model",
    temperatureSummary(value.temperature),
    deliverySummary(value.responseMode),
    repetitions?.summary,
  ].filter((fact): fact is string => Boolean(fact));

  return (
    <section
      className={open ? "inference-settings open" : "inference-settings"}
      aria-label={label}
    >
      <div className="inference-settings-summary">
        <button
          aria-controls={bodyId}
          aria-expanded={open}
          className="inference-settings-toggle"
          onClick={() => onOpenChange(!open)}
          type="button"
        >
          <span className="inference-settings-identity">
            <strong>{heading}</strong>
            {scopeNote ? <small>{scopeNote}</small> : null}
          </span>
          {/* The collapsed values are the reason this can be collapsed at all,
              so they stay in the trigger rather than behind it. */}
          <span className="inference-settings-facts">
            {facts.map((fact) => (
              <span className="inference-settings-fact" key={fact}>
                {fact}
              </span>
            ))}
          </span>
          <span aria-hidden="true" className="menu-chevron">
            ⌄
          </span>
        </button>
        {action}
      </div>
      {open ? (
        <div className="inference-settings-body" id={bodyId}>
          {readOnly ? (
            <dl className="inference-settings-record">
              {connection?.summary ? (
                <div>
                  <dt>Connection</dt>
                  <dd>{connection.summary}</dd>
                </div>
              ) : null}
              <div>
                <dt>Model</dt>
                <dd>{value.model || "No model"}</dd>
              </div>
              <div>
                <dt>Temperature</dt>
                <dd>
                  {value.temperature === undefined
                    ? "Provider default"
                    : value.temperature.toFixed(1)}
                </dd>
              </div>
              <div>
                <dt>Delivery</dt>
                <dd>{deliverySummary(value.responseMode)}</dd>
              </div>
              {repetitions?.summary ? (
                <div>
                  <dt>Repetitions</dt>
                  <dd>{repetitions.summary}</dd>
                </div>
              ) : null}
            </dl>
          ) : (
            <div className="inference-settings-grid">
              {connection?.control}
              <ModelCombobox
                idPrefix={`${idPrefix}-model`}
                readinessTarget={readinessTarget}
                {...(modelInputRef ? { inputRef: modelInputRef } : {})}
                value={value.model}
                onChange={(model) => onChange({ ...value, model })}
                discovery={modelDiscovery}
                onLoadModels={(force) => onLoadModels?.(force)}
                favoriteModels={favoriteModels}
                onToggleFavoriteModel={(model) => onToggleFavoriteModel?.(model)}
              />
              <TemperatureControl
                value={value.temperature}
                rememberedOverride={rememberedTemperature}
                onChange={(temperature) => onChange({ ...value, temperature })}
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
                    : "This connection does not support streaming responses."
                }
              >
                <input
                  checked={value.responseMode === "streaming"}
                  disabled={!streamingAvailable}
                  onChange={(event) =>
                    onChange({
                      ...value,
                      responseMode: event.target.checked
                        ? "streaming"
                        : "buffered",
                    })
                  }
                  type="checkbox"
                />
                <span>
                  Stream response
                  <small>
                    {streamingAvailable
                      ? "Show output as the provider sends it."
                      : "Unavailable here; responses are buffered."}
                  </small>
                </span>
              </label>
              {repetitions?.control}
            </div>
          )}
          {notes}
        </div>
      ) : null}
    </section>
  );
}
