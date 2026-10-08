"use client";

import type { RefObject } from "react";
import { protocolLabel } from "../../packages/core/src/provider-protocols.ts";
import type { ProviderWireProtocol } from "../../packages/core/src/run-kernel/types.ts";
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
  protocol: ProviderWireProtocol;
  /** What the run's profile has enabled; the select offers only these. */
  supportedProtocols: ProviderWireProtocol[];
  onProtocolChange(protocol: ProviderWireProtocol): void;
  /**
   * What changing the protocol here changes beyond this run, shown under the
   * select: without a project it is the profile's remembered preference, with
   * one it is the project's default target, which evaluations do not follow.
   */
  protocolScope: string;
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
  protocol,
  supportedProtocols,
  onProtocolChange,
  protocolScope,
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
        protocol={{
          summary: protocolLabel(protocol),
          control: (
            <ProtocolSelect
              value={protocol}
              supported={supportedProtocols}
              scope={protocolScope}
              onChange={onProtocolChange}
            />
          ),
        }}
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

/**
 * Offers the protocols the run's profile has enabled. A project may ask for
 * one its mapped profile has not: it stays selected and marked, and readiness
 * says what to do, rather than the select silently showing something else.
 */
function ProtocolSelect({
  value,
  supported,
  scope,
  onChange,
}: {
  value: ProviderWireProtocol;
  supported: ProviderWireProtocol[];
  scope: string;
  onChange(protocol: ProviderWireProtocol): void;
}) {
  const options = supported.includes(value) ? supported : [value, ...supported];
  return (
    <label>
      Protocol
      <select
        data-readiness-control="protocol"
        value={value}
        onChange={(event) => onChange(event.target.value as ProviderWireProtocol)}
      >
        {options.map((protocol) => (
          <option key={protocol} value={protocol}>
            {protocolLabel(protocol)}
            {supported.includes(protocol) ? "" : " (not enabled)"}
          </option>
        ))}
      </select>
      <small>{scope}</small>
    </label>
  );
}
