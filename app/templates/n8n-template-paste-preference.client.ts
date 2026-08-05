"use client";

const key = "inference-lens:n8n-template-paste-suggestion:v1";

export function n8nPasteSuggestionsEnabled(): boolean {
  try { return window.localStorage.getItem(key) !== "disabled"; } catch { return true; }
}

export function setN8nPasteSuggestionsEnabled(enabled: boolean): void {
  try {
    if (enabled) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, "disabled");
  } catch { /* storage is optional */ }
}
