"use client";

/** Advice shared by pinned chat and decision prompts; target selection stays explicit. */
export function PromptModelRecommendation({ recommendedModel, selectedModel, connectionName, connectionAdvice, dismissed, disabled, onChooseModel, onDismiss }: {
  recommendedModel: string;
  selectedModel: string;
  connectionName?: string;
  connectionAdvice?: string;
  dismissed: boolean;
  disabled?: boolean;
  onChooseModel(): void;
  onDismiss(): void;
}) {
  const differs = recommendedModel.trim() !== selectedModel.trim();
  return (
    <div className="prompt-model-recommendation">
      <p className="prompt-model-summary">Recommended model: <strong>{recommendedModel}</strong>{connectionName && <span> · Recommended connection: {connectionName}</span>}</p>
      {connectionAdvice && <p className="template-empty">{connectionAdvice}</p>}
      {differs && !dismissed && <div className="prompt-model-warning" role="status">
        <span>This prompt recommends {recommendedModel}. You’re using {selectedModel || "no model"}.</span>
        <div className="prompt-model-warning-actions">
          <button className="text-button" type="button" disabled={disabled} onClick={onChooseModel}>Choose model</button>
          <button className="text-button" type="button" onClick={onDismiss}>Dismiss</button>
        </div>
      </div>}
    </div>
  );
}
