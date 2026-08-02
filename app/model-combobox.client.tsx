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
  /** Pinned model ids for the active profile; presentational data only. */
  favoriteModels: string[];
  onToggleFavoriteModel: (model: string) => void;
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
  favoriteModels,
  onToggleFavoriteModel,
  inputRef,
}: ModelComboboxProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const closeTimeoutRef = useRef<number | null>(null);
  // Text the field is showing while it is being edited, which is not always a
  // model the rest of the app can hold: clearing the field to retype is an
  // ordinary edit, but an open project's `defaults.target.model` requires a
  // non-empty id. The draft keeps the empty moment local to this input and
  // commits only a usable id upward.
  const [draft, setDraft] = useState<string | null>(null);

  useEffect(
    () => () => {
      if (closeTimeoutRef.current !== null) {
        window.clearTimeout(closeTimeoutRef.current);
      }
    },
    [],
  );

  const matchingModels = filterModels(discovery?.models ?? [], filter);
  // Favorites do not depend on discovery: they are stored ids, so they render
  // while the catalogue is loading and when it fails or does not exist at all.
  // That is the point of them — a saved id stays reachable exactly when a
  // provider's optional catalogue endpoint cannot help. `rows` stays an
  // accurate index of what is on screen because `discovery.models` is empty in
  // every status but `loaded`, so the discovered group renders nothing there.
  const matchingFavorites = filterModels(favoriteModels, filter).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
  // Favorites intentionally also appear in `matchingModels` below — nothing
  // is hidden from the ordinary list. `rows` is the single flat sequence
  // arrow-key navigation and `Enter` operate on; `highlightedIndex` is an
  // index into it, not into either group alone.
  const rows = [...matchingFavorites, ...matchingModels];

  function selectModel(model: string): void {
    onChange(model);
    setDraft(null);
    setFilter(model);
    setMenuOpen(false);
  }

  function renderOption(model: string, index: number) {
    const isFavorite = favoriteModels.includes(model);
    return (
      <div
        key={`${index}-${model}`}
        className={
          index === highlightedIndex
            ? "model-option-row highlighted"
            : "model-option-row"
        }
      >
        <button
          type="button"
          className={
            isFavorite
              ? "model-favorite-toggle favorited"
              : "model-favorite-toggle"
          }
          aria-pressed={isFavorite}
          aria-label={isFavorite ? `Unfavorite ${model}` : `Favorite ${model}`}
          onMouseDown={preventBlur}
          onClick={() => onToggleFavoriteModel(model)}
        >
          {isFavorite ? "★" : "☆"}
        </button>
        <button
          aria-selected={index === highlightedIndex}
          className="model-option"
          id={`model-option-${index}`}
          role="option"
          type="button"
          onMouseDown={preventBlur}
          onClick={() => selectModel(model)}
        >
          {model}
        </button>
      </div>
    );
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
            menuOpen && rows[highlightedIndex]
              ? `model-option-${highlightedIndex}`
              : undefined
          }
          value={draft ?? value}
          onFocus={() => {
            setFilter("");
            setHighlightedIndex(0);
            setMenuOpen(true);
            onLoadModels();
          }}
          onChange={(event) => {
            const text = event.target.value;
            setDraft(text);
            // An empty or blank field is a step in editing, not a model. It is
            // held locally until it names something, so the project document is
            // never asked to store an id it cannot represent.
            if (text.trim().length > 0) onChange(text);
            setFilter(text);
            setHighlightedIndex(0);
            setMenuOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setDraft(null);
              setMenuOpen(false);
              return;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setMenuOpen(true);
              onLoadModels();
              if (rows.length > 0) {
                const direction = event.key === "ArrowDown" ? 1 : -1;
                setHighlightedIndex(
                  (current) => (current + direction + rows.length) % rows.length,
                );
              }
              return;
            }
            if (event.key === "Enter" && menuOpen && rows[highlightedIndex]) {
              event.preventDefault();
              selectModel(rows[highlightedIndex]);
            }
          }}
          onBlur={() => {
            // Leaving the field with nothing in it restores the model still in
            // effect, because there is no "no model" a project can hold.
            setDraft(null);
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
            {matchingFavorites.length > 0 && (
              <>
                <div className="model-options-header">
                  <span>Favorites</span>
                </div>
                {matchingFavorites.map((model, index) =>
                  renderOption(model, index),
                )}
              </>
            )}
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
            {discovery?.status === "loaded" && (
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
                {matchingModels.length > 0 ? (
                  matchingModels.map((model, index) =>
                    renderOption(model, matchingFavorites.length + index),
                  )
                ) : (
                  <p className="model-options-status">
                    No discovered models match. Keep typing to use a custom ID.
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </label>
  );
}
