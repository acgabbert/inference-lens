"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { filterModels } from "./use-model-discovery.client";
import type { ModelDiscoveryState } from "./use-model-discovery.client";

/** Keeps a click on an option from blurring the input before it registers. */
const preventBlur = (event: { preventDefault: () => void }): void =>
  event.preventDefault();

type ModelComboboxProps = {
  value: string;
  onChange: (model: string) => void;
  discovery: ModelDiscoveryState | null;
  onLoadModels: (force?: boolean) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
};

/**
 * Free-text model entry with discovery as assistance rather than a
 * constraint: an unlisted id stays valid, because a provider's catalogue
 * endpoint is optional and often incomplete.
 */
export function ModelCombobox({
  value,
  onChange,
  discovery,
  onLoadModels,
  inputRef,
}: ModelComboboxProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const closeTimeoutRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (closeTimeoutRef.current !== null) {
        window.clearTimeout(closeTimeoutRef.current);
      }
    },
    [],
  );

  const matchingModels = filterModels(discovery?.models ?? [], filter);

  function selectModel(model: string): void {
    onChange(model);
    setFilter(model);
    setMenuOpen(false);
  }

  return (
    <label className="model-combobox">
      Model
      <div className="combobox-control">
        <input
          ref={inputRef}
          data-readiness-control="model"
          role="combobox"
          aria-autocomplete="list"
          aria-controls="model-options"
          aria-expanded={menuOpen}
          aria-activedescendant={
            menuOpen && matchingModels[highlightedIndex]
              ? `model-option-${highlightedIndex}`
              : undefined
          }
          value={value}
          onFocus={() => {
            setFilter("");
            setHighlightedIndex(0);
            setMenuOpen(true);
            onLoadModels();
          }}
          onChange={(event) => {
            onChange(event.target.value);
            setFilter(event.target.value);
            setHighlightedIndex(0);
            setMenuOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setMenuOpen(false);
              return;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setMenuOpen(true);
              onLoadModels();
              if (matchingModels.length > 0) {
                const direction = event.key === "ArrowDown" ? 1 : -1;
                setHighlightedIndex(
                  (current) =>
                    (current + direction + matchingModels.length) %
                    matchingModels.length,
                );
              }
              return;
            }
            if (
              event.key === "Enter" &&
              menuOpen &&
              matchingModels[highlightedIndex]
            ) {
              event.preventDefault();
              selectModel(matchingModels[highlightedIndex]);
            }
          }}
          onBlur={() => {
            closeTimeoutRef.current = window.setTimeout(
              () => setMenuOpen(false),
              120,
            );
          }}
          spellCheck={false}
          autoComplete="off"
        />
        {menuOpen && (
          <div className="model-options" id="model-options" role="listbox">
            {discovery?.status === "loading" && (
              <p className="model-options-status">Loading models…</p>
            )}
            {discovery?.status === "failed" && (
              <div className="model-options-status model-options-error">
                <span>{discovery.error}</span>
                <button
                  className="text-button"
                  type="button"
                  onMouseDown={preventBlur}
                  onClick={() => onLoadModels(true)}
                >
                  Retry
                </button>
              </div>
            )}
            {discovery?.status === "loaded" &&
              (matchingModels.length > 0 ? (
                <>
                  <div className="model-options-header">
                    <span>{matchingModels.length} discovered</span>
                    <button
                      className="text-button"
                      type="button"
                      onMouseDown={preventBlur}
                      onClick={() => onLoadModels(true)}
                    >
                      Refresh
                    </button>
                  </div>
                  {matchingModels.map((model, index) => (
                    <button
                      aria-selected={index === highlightedIndex}
                      className={
                        index === highlightedIndex
                          ? "model-option highlighted"
                          : "model-option"
                      }
                      id={`model-option-${index}`}
                      key={model}
                      role="option"
                      type="button"
                      onMouseDown={preventBlur}
                      onClick={() => selectModel(model)}
                    >
                      {model}
                    </button>
                  ))}
                </>
              ) : (
                <p className="model-options-status">
                  No discovered models match. Keep typing to use a custom ID.
                </p>
              ))}
          </div>
        )}
      </div>
    </label>
  );
}
