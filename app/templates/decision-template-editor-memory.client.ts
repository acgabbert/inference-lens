"use client";

import { useState } from "react";
import type { PromptTemplateRevisionId, PromptTemplateId } from "../../packages/core/src/run-kernel";
import type { DecisionDraftSnapshot } from "../decisions/use-decision-draft.client";

/**
 * A decision prompt's in-session editor state, including edits too incomplete
 * to persist as the template's draft.
 */
export interface DecisionTemplateEditorMemory {
  sourceRevisionId: PromptTemplateRevisionId;
  snapshot: DecisionDraftSnapshot;
  revisionName: string;
}

export interface DecisionTemplateEditorMemoryStore {
  get(templateId: PromptTemplateId): DecisionTemplateEditorMemory | undefined;
  has(templateId: PromptTemplateId): boolean;
  set(templateId: PromptTemplateId, memory: DecisionTemplateEditorMemory): void;
  delete(templateId: PromptTemplateId): void;
  clear(): void;
}

/**
 * Session memory for decision prompt editors, held above the editor mount so
 * switching prompts or modes keeps it. Entries are replaced on every edit
 * without rendering; adding or removing one renders the owner, because the
 * editor shows whether a draft exists.
 */
export function useDecisionTemplateEditorMemory(): DecisionTemplateEditorMemoryStore {
  const [, setVersion] = useState(0);
  const [store] = useState<DecisionTemplateEditorMemoryStore>(() => {
    const entries = new Map<PromptTemplateId, DecisionTemplateEditorMemory>();
    const changed = () => setVersion((version) => version + 1);
    return {
      get: (templateId) => entries.get(templateId),
      has: (templateId) => entries.has(templateId),
      set(templateId, memory) {
        const added = !entries.has(templateId);
        entries.set(templateId, memory);
        if (added) changed();
      },
      delete(templateId) {
        if (entries.delete(templateId)) changed();
      },
      clear() {
        if (entries.size === 0) return;
        entries.clear();
        changed();
      },
    };
  });
  return store;
}
