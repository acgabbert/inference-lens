"use client";

import { useState } from "react";

import type {
  PromptTemplateId,
  PromptTemplateRevisionId,
  PromptTemplateUseId,
} from "../../packages/core/src/run-kernel";
import {
  clearPromptReturn,
  followPromptSelection,
  openPromptSource,
} from "./prompt-navigation";
import type { PromptNavigationTarget, PromptReturnTarget } from "./prompt-navigation";

/**
 * Which prompt the Prompts mode shows and where "Back to request" leads.
 *
 * Transient UI state that must outlive the Prompts mode unmounting, so the page
 * calls this hook. It never switches modes: the page does that around these
 * commands, and acts on the target `returnFromSource` hands back.
 */
export interface PromptNavigation {
  target?: PromptNavigationTarget;
  editSource(
    useId: PromptTemplateUseId,
    templateId: PromptTemplateId,
    revisionId: PromptTemplateRevisionId,
  ): void;
  /** Clears the return path and returns it, if there was one. */
  returnFromSource(): PromptReturnTarget | undefined;
  clearReturn(): void;
  selectionChanged(templateId: PromptTemplateId, revisionId?: PromptTemplateRevisionId): void;
}

export function usePromptNavigation(): PromptNavigation {
  const [target, setTarget] = useState<PromptNavigationTarget>();

  function clearReturn(): void {
    setTarget(clearPromptReturn);
  }

  return {
    ...(target ? { target } : {}),
    editSource(useId, templateId, revisionId) {
      setTarget((current) => openPromptSource(current, useId, templateId, revisionId));
    },
    returnFromSource() {
      const returnTarget = target?.returnTarget;
      clearReturn();
      return returnTarget;
    },
    clearReturn,
    selectionChanged(templateId, revisionId) {
      setTarget((current) => followPromptSelection(current, templateId, revisionId));
    },
  };
}
