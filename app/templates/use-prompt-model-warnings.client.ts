"use client";

import { useState } from "react";
import type { PromptTemplateRecommendedTarget } from "../../packages/core/src/project";

export interface PromptModelWarnings {
  isDismissed(id: string): boolean;
  dismiss(id: string): void;
}

/**
 * The feature owner outlives its composer surface. Dismissals are in-memory,
 * per use and only for the uninterrupted comparison the user acknowledged.
 * Changing away and back, removing a use, or changing projects restores advice.
 */
export function usePromptModelWarnings(scope: string, comparisons: {
  id: string;
  recommendation?: PromptTemplateRecommendedTarget;
  selectedModel: string;
}[]): PromptModelWarnings {
  const current = Object.fromEntries(comparisons.map(({ id, recommendation, selectedModel }) => [
    id, JSON.stringify([scope, recommendation?.connectionRequirementId, recommendation?.model.trim(), selectedModel.trim()]),
  ]));
  const signature = JSON.stringify(current);
  const [state, setState] = useState<{ signature: string; comparisons: Record<string, string>; dismissed: string[] }>(
    { signature, comparisons: current, dismissed: [] },
  );
  const dismissed = state.signature === signature ? state.dismissed
    : state.dismissed.filter((id) => current[id] !== undefined && current[id] === state.comparisons[id]);
  if (state.signature !== signature) setState({ signature, comparisons: current, dismissed });
  return {
    isDismissed: (id) => dismissed.includes(id),
    dismiss(id) { setState({ signature, comparisons: current, dismissed: [...new Set([...dismissed, id])] }); },
  };
}
