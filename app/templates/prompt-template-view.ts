import type {
  ChatPromptTemplate,
  ChatPromptTemplateDraft,
  DecisionPromptTemplate,
  DecisionPromptTemplateDraft,
} from "../../packages/core/src/project";

/**
 * A prompt as the editors show it: the shared template, plus the user's
 * working draft when there is one. The shared document (`ProjectFile`, v19)
 * never holds a draft; the templates owner builds this view from the personal
 * workbench record, or from a session-only prompt's own state
 * (docs/SHARED_ASSETS_LEVEL_TWO_DESIGN.md, "In-memory v19 label", L1).
 */
export type ChatPromptTemplateView = ChatPromptTemplate & { draft?: ChatPromptTemplateDraft };
export type DecisionPromptTemplateView = DecisionPromptTemplate & { draft?: DecisionPromptTemplateDraft };
export type PromptTemplateView = ChatPromptTemplateView | DecisionPromptTemplateView;
