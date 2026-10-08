import type {
  PromptTemplateId,
  PromptTemplateRevisionId,
  PromptTemplateUseId,
} from "../../packages/core/src/run-kernel/index.ts";

/**
 * Where "Back to request" leads. Stable IDs only, never a component or object
 * snapshot, so a use removed while the source is open falls back safely and
 * project serialization is untouched.
 */
export interface PromptReturnTarget {
  kind: "template-use";
  useId: PromptTemplateUseId;
}

/**
 * The prompt the Prompts mode shows. `key` changes only when navigation opens
 * a specific source, which remounts the library on that source; following the
 * author's own selection keeps the key so their unsaved draft survives.
 */
export interface PromptNavigationTarget {
  key: number;
  templateId: PromptTemplateId;
  revisionId?: PromptTemplateRevisionId;
  returnTarget?: PromptReturnTarget;
}

export function openPromptSource(
  current: PromptNavigationTarget | undefined,
  useId: PromptTemplateUseId,
  templateId: PromptTemplateId,
  revisionId: PromptTemplateRevisionId,
): PromptNavigationTarget {
  return {
    key: (current?.key ?? 0) + 1,
    templateId,
    revisionId,
    returnTarget: { kind: "template-use", useId },
  };
}

export function clearPromptReturn(
  current: PromptNavigationTarget | undefined,
): PromptNavigationTarget | undefined {
  return current ? { ...current, returnTarget: undefined } : current;
}

export function followPromptSelection(
  current: PromptNavigationTarget | undefined,
  templateId: PromptTemplateId,
  revisionId: PromptTemplateRevisionId | undefined,
): PromptNavigationTarget {
  return {
    key: current?.key ?? 0,
    templateId,
    ...(revisionId ? { revisionId } : {}),
    ...(current?.returnTarget ? { returnTarget: current.returnTarget } : {}),
  };
}
